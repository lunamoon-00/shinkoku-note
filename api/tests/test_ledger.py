"""帳簿の基本：登録・一覧・確定・修正・削除・集計と、入力チェック。"""

import pg8000.exceptions
import pytest

from shinkoku import db, ledger, migrate

from .conftest import ALICE, expense_payload


def test_マイグレーションは何回流しても同じ(database):
    assert migrate.migrate(database) == []


def test_売上と経費の科目には収支内訳書の欄がある(database):
    rows = database.run("select code from accounts where kind in ('revenue', 'expense') and white_line is null")
    assert rows == []


def test_仕訳を登録して読み出せる(app_con):
    with db.as_user(app_con, ALICE):
        created = ledger.create_entry(app_con, ALICE, expense_payload())
        got = ledger.get_entry(app_con, created["id"])
    assert got["entry_date"] == "2026-01-10"
    assert got["total"] == 3300
    assert {(line["side"], line["account_code"]) for line in got["lines"]} == {("debit", "5190"), ("credit", "2900")}
    assert got["lines"][0]["friendly_name"]  # 画面用のふだんの言葉も返す


def test_一覧はその年の分だけ(app_con):
    with db.as_user(app_con, ALICE):
        ledger.create_entry(app_con, ALICE, expense_payload(date="2026-03-01"))
        ledger.create_entry(app_con, ALICE, expense_payload(date="2025-12-31"))
        entries_2026 = ledger.list_entries(app_con, 2026)
        entries_2025 = ledger.list_entries(app_con, 2025)
    assert [e["entry_date"] for e in entries_2026] == ["2026-03-01"]
    assert [e["entry_date"] for e in entries_2025] == ["2025-12-31"]


def test_集計は確定した仕訳だけで_所得の目安も出す(app_con):
    with db.as_user(app_con, ALICE):
        # 報酬 100,000円（源泉徴収 10,210円を引かれて 89,790円が入金）
        ledger.create_entry(app_con, ALICE, {
            "entry_date": "2026-01-31", "status": "confirmed",
            "lines": [
                {"side": "debit", "account_code": "1200", "amount": 89_790},
                {"side": "debit", "account_code": "1900", "amount": 10_210},
                {"side": "credit", "account_code": "4100", "amount": 100_000},
            ],
        })
        ledger.create_entry(app_con, ALICE, expense_payload(amount=3300))
        ledger.create_entry(app_con, ALICE, expense_payload(amount=9999, status="draft"))  # 下書きは数えない
        result = ledger.summary(app_con, 2026)
    assert (result["revenue"], result["expense"], result["income"]) == (100_000, 3300, 96_700)
    by_code = {a["code"]: a["balance"] for a in result["accounts"]}
    assert by_code["5190"] == 3300
    assert by_code["2900"] == 3300


def test_修正すると行が入れかわる(app_con):
    with db.as_user(app_con, ALICE):
        e = ledger.create_entry(app_con, ALICE, expense_payload(amount=1000))
        updated = ledger.update_entry(app_con, ALICE, e["id"], expense_payload(amount=2000, code="5140"))
    assert updated["total"] == 2000
    assert {line["account_code"] for line in updated["lines"]} == {"5140", "2900"}


def test_下書きを確定できる(app_con):
    with db.as_user(app_con, ALICE):
        e = ledger.create_entry(app_con, ALICE, expense_payload(status="draft"))
        assert ledger.confirm_entry(app_con, ALICE, e["id"])["status"] == "confirmed"


def test_削除すると行も消える(app_con):
    with db.as_user(app_con, ALICE):
        e = ledger.create_entry(app_con, ALICE, expense_payload())
        ledger.delete_entry(app_con, ALICE, e["id"])
        with pytest.raises(ledger.NotFound):
            ledger.get_entry(app_con, e["id"])
        assert app_con.run("select count(*) from journal_lines")[0][0] == 0


def test_操作の記録が残る(app_con):
    with db.as_user(app_con, ALICE):
        e = ledger.create_entry(app_con, ALICE, expense_payload())
        ledger.confirm_entry(app_con, ALICE, e["id"])
        actions = [r[0] for r in app_con.run("select action from audit_logs order by id")]
    assert actions == ["entry.create", "entry.confirm"]


# ───────── 入力チェック ─────────
@pytest.mark.parametrize(
    "change, field",
    [
        ({"entry_date": "2026/01/10"}, "entry_date"),
        ({"status": "done"}, "status"),
        ({"lines": [{"side": "debit", "account_code": "5190", "amount": 100}]}, "lines"),
        ({"lines": [{"side": "debit", "account_code": "9999", "amount": 100},
                    {"side": "credit", "account_code": "2900", "amount": 100}]}, "lines[0].account_code"),
        ({"lines": [{"side": "debit", "account_code": "5190", "amount": 100.5},
                    {"side": "credit", "account_code": "2900", "amount": 100.5}]}, "lines[0].amount"),
        ({"lines": [{"side": "debit", "account_code": "5190", "amount": True},
                    {"side": "credit", "account_code": "2900", "amount": True}]}, "lines[0].amount"),
        ({"lines": [{"side": "debit", "account_code": "5190", "amount": 0},
                    {"side": "credit", "account_code": "2900", "amount": 0}]}, "lines[0].amount"),
        ({"lines": [{"side": "debit", "account_code": "5190", "amount": 100},
                    {"side": "credit", "account_code": "2900", "amount": 99}]}, "lines"),
        ({"lines": [{"side": "debit", "account_code": "5190", "amount": 100},
                    {"side": "debit", "account_code": "2900", "amount": 100}]}, "lines"),
    ],
)
def test_おかしな入力は_どこがおかしいか教えて断る(app_con, change, field):
    payload = {**expense_payload(), **change}
    with db.as_user(app_con, ALICE):
        with pytest.raises(ledger.ValidationError) as err:
            ledger.create_entry(app_con, ALICE, payload)
        assert app_con.run("select count(*) from journal_entries")[0][0] == 0
    assert field in [d["field"] for d in err.value.details]


def test_APIのチェックをすり抜けても_DBが借方と貸方のずれを止める(app_con):
    with pytest.raises(pg8000.exceptions.DatabaseError, match="ENTRY_UNBALANCED"):
        with db.as_user(app_con, ALICE):
            app_con.run(
                "insert into journal_entries (id, user_id, entry_date)"
                " values ('00000000-0000-4000-8000-000000000001', :u, '2026-01-01')", u=ALICE)
            app_con.run(
                "insert into journal_lines (entry_id, user_id, side, account_code, amount) values"
                " ('00000000-0000-4000-8000-000000000001', :u, 'debit', '5190', 100),"
                " ('00000000-0000-4000-8000-000000000001', :u, 'credit', '2900', 99)", u=ALICE)
    assert app_con.run("select count(*) from journal_entries")[0][0] == 0  # 全部なかったことになる


def test_利用者の設定は最初に見たときに作られ_変更できる(app_con):
    with db.as_user(app_con, ALICE):
        assert ledger.get_profile(app_con, ALICE)["filing_type"] == "white"
        p = ledger.update_profile(app_con, ALICE, {"mode": "freee", "display_name": " みちる "})
    assert (p["mode"], p["display_name"]) == ("freee", "みちる")


def test_はじめの質問が終わった印をつけられる(app_con):
    with db.as_user(app_con, ALICE):
        assert ledger.get_profile(app_con, ALICE)["onboarded"] is False
        assert ledger.update_profile(app_con, ALICE, {"onboarded": True})["onboarded"] is True
        # ほかの設定を変えても、印は消えない
        assert ledger.update_profile(app_con, ALICE, {"display_name": "a"})["onboarded"] is True


def test_設定におかしな値は入れられない(app_con):
    with db.as_user(app_con, ALICE):
        with pytest.raises(ledger.ValidationError):
            ledger.update_profile(app_con, ALICE, {"filing_type": "red"})
