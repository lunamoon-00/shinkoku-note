"""くり返し設定と、目覚まし係（毎朝の記録・週1のお知らせ）。"""

import datetime as dt

import pytest

from shinkoku import db, ledger, line, recurring, scheduler

from .conftest import ALICE, BOB

TODAY = dt.date(2026, 11, 21)


def rent(**over):
    base = {"name": "家賃", "account_code": "5050", "amount": 80_000, "business_ratio": 30,
            "day_of_month": 27, "paid_from": "personal", "start_month": "2026-01"}
    return {**base, **over}


def add(con, user=ALICE, **over):
    with db.as_user(con, user):
        return recurring.create_rule(con, user, rent(**over))


def run(con, user=ALICE, today=TODAY):
    with db.as_user(con, user):
        return recurring.run_for_user(con, user, today)


# ───────── 計算 ─────────
def test_家事按分は四捨五入で_少なくとも1円():
    assert recurring.business_amount(80_000, 30) == 24_000
    assert recurring.business_amount(4_980, 50) == 2_490
    assert recurring.business_amount(999, 33) == 330  # 329.67 → 330
    assert recurring.business_amount(1, 1) == 1


def test_31日にすると短い月は月末():
    assert recurring.due_date(dt.date(2026, 2, 1), 31) == dt.date(2026, 2, 28)
    assert recurring.due_date(dt.date(2026, 4, 1), 31) == dt.date(2026, 4, 30)


def test_記録日がまだ来ていない今月は入らない():
    months = recurring.due_months(dt.date(2026, 9, 1), None, 27, TODAY)
    assert months == [dt.date(2026, 9, 1), dt.date(2026, 10, 1)]  # 11/27 はまだ


def test_いつまでがあれば_そこで止まる():
    months = recurring.due_months(dt.date(2026, 1, 1), dt.date(2026, 3, 1), 1, TODAY)
    assert months == [dt.date(2026, 1, 1), dt.date(2026, 2, 1), dt.date(2026, 3, 1)]


def test_日本時間で今日を数える():
    assert recurring.today_jst(dt.datetime(2026, 11, 20, 16, 0, tzinfo=dt.timezone.utc)) == dt.date(2026, 11, 21)


# ───────── 記録 ─────────
def test_過去の月からまとめて記録する(app_con):
    add(app_con)
    assert run(app_con) == 10  # 1月〜10月（11月27日はまだ）
    with db.as_user(app_con, ALICE):
        entries = ledger.list_entries(app_con, 2026)
        summary = ledger.summary(app_con, 2026)
    assert len(entries) == 10
    assert entries[0]["entry_date"] == "2026-01-27" and entries[0]["source"] == "recurring"
    assert "1月分・仕事の割合30%" in entries[0]["description"]
    assert summary["expense"] == 240_000  # 24,000円 × 10か月


def test_何回動かしても二重にならない(app_con):
    add(app_con)
    run(app_con)
    assert run(app_con) == 0
    assert run(app_con, today=dt.date(2026, 11, 27)) == 1  # 11月分の記録日が来たら1件だけ


def test_止めた設定は記録しない(app_con):
    rule = add(app_con)
    with db.as_user(app_con, ALICE):
        recurring.set_active(app_con, ALICE, rule["id"], False)
    assert run(app_con) == 0


def test_設定を消しても_記録した分は帳簿に残る(app_con):
    rule = add(app_con)
    run(app_con)
    with db.as_user(app_con, ALICE):
        recurring.delete_rule(app_con, ALICE, rule["id"])
        assert len(ledger.list_entries(app_con, 2026)) == 10
        assert recurring.list_rules(app_con) == []


def test_仕事用の口座から払うなら普通預金から(app_con):
    add(app_con, paid_from="business", business_ratio=100, start_month="2026-10", amount=5_000)
    run(app_con)
    with db.as_user(app_con, ALICE):
        [entry] = ledger.list_entries(app_con, 2026)
    assert {(line["side"], line["account_code"], line["amount"]) for line in entry["lines"]} == {
        ("debit", "5050", 5_000), ("credit", "1200", 5_000),
    }


@pytest.mark.parametrize("change, field", [
    ({"name": ""}, "name"),
    ({"account_code": "4100"}, "account_code"),  # 売上は経費の科目ではない
    ({"amount": 0}, "amount"),
    ({"amount": 1.5}, "amount"),
    ({"business_ratio": 0}, "business_ratio"),
    ({"business_ratio": 101}, "business_ratio"),
    ({"day_of_month": 32}, "day_of_month"),
    ({"paid_from": "cash"}, "paid_from"),
    ({"start_month": "2026/01"}, "start_month"),
    ({"start_month": "2020-01"}, "start_month"),
    ({"end_month": "2025-12"}, "end_month"),
])
def test_おかしな設定は理由を伝えて断る(app_con, change, field):
    with pytest.raises(ledger.ValidationError) as err:
        add(app_con, **change)
    assert field in [d["field"] for d in err.value.details]


def test_他人の設定は見えない_さわれない(app_con):
    rule = add(app_con, user=ALICE)
    with db.as_user(app_con, BOB):
        assert recurring.list_rules(app_con) == []
        with pytest.raises(ledger.NotFound):
            recurring.delete_rule(app_con, BOB, rule["id"])


# ───────── 目覚まし係 ─────────
def test_毎朝の目覚ましは_設定がある人全員の分を記録する(app_con):
    add(app_con, user=ALICE)
    add(app_con, user=BOB, start_month="2026-11", day_of_month=1)
    result = scheduler.run_recurring(app_con, TODAY)
    assert result == {"users": 2, "created": 11, "failed": 0}
    assert scheduler.run_recurring(app_con, TODAY)["created"] == 0


def test_週1のお知らせは_確認待ちがあってLINEとつながっている人だけ(app_con, database, monkeypatch):
    sent = []
    monkeypatch.setattr(line, "push", lambda to, messages: sent.append((to, messages[0]["text"])))
    with db.as_user(app_con, ALICE):
        ledger.create_entry(app_con, ALICE, {"entry_date": "2026-11-20", "status": "draft", "lines": [
            {"side": "debit", "account_code": "5190", "amount": 100}, {"side": "credit", "account_code": "2900", "amount": 100}]})
    with db.as_user(app_con, BOB):  # Bob は確認待ちがあるけど LINE とつながっていない
        ledger.create_entry(app_con, BOB, {"entry_date": "2026-11-20", "status": "draft", "lines": [
            {"side": "debit", "account_code": "5190", "amount": 100}, {"side": "credit", "account_code": "2900", "amount": 100}]})
    database.run("insert into line_links (user_id, line_user_id) values (:u, 'U-alice')", u=ALICE)
    assert scheduler.send_review_reminders(app_con) == {"sent": 1, "failed": 0}
    assert sent[0][0] == "U-alice" and "1件" in sent[0][1]


def test_知らない仕事を頼まれたらエラー(monkeypatch, app_con):
    monkeypatch.setattr(db, "shared_connection", lambda *a, **k: app_con)
    with pytest.raises(ValueError):
        scheduler.handler({"task": "dance"}, None)
