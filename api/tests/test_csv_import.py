"""CSV 取りこみ：確認画面の候補づけ → ✅の行だけ取りこむ（本物の PostgreSQL で）。"""

import pytest

from shinkoku import csv_import, db, ledger

from .conftest import ALICE, BOB

CARD = (
    "ご利用日,ご利用店名,ご利用金額\n"
    "2026/11/03,ヨドバシカメラ,3300\n"
    "2026/11/04,スーパーまるや,2180\n"
    "2026/11/05,ＪＲ東日本,680\n"
)
BANK = "取引日,摘要,お支払金額,お預り金額\n2026/11/10,カ）エーシャ,,89790\n2026/11/12,デンキ,4980,\n"


def fake_ai(descriptions, accounts):
    answers = {
        "ヨドバシカメラ": ("5190", 0.9, True),
        "スーパーまるや": ("5900", 0.3, False),
        "JR東日本": ("5130", 0.95, True),
        "デンキ": ("5120", 0.8, True),
    }
    return {d: {"description": d, "account_code": answers[d][0], "confidence": answers[d][1], "business_likely": answers[d][2]}
            for d in descriptions if d in answers}


class Spy:
    def __init__(self):
        self.calls = []
        self.saved = {}

    def ai(self, descriptions, accounts):
        self.calls.append(list(descriptions))
        return fake_ai(descriptions, accounts)

    def store(self, key, body, mime):
        self.saved[key] = body


def preview(con, csv=CARD, source="personal", user=ALICE, spy=None):
    spy = spy or Spy()
    with db.as_user(con, user):
        return csv_import.preview(con, user, csv.encode("cp932"), source, filename="card.csv",
                                  classifier=spy.ai, store=spy.store, mapper=lambda records: (None, 0)), spy


def commit(con, result, user=ALICE, change=None):
    rows = [{"row_id": r["row_id"], "include": r["include"], "account_code": r["account_code"]} for r in result["rows"]]
    for row in rows:
        row.update((change or {}).get(row["row_id"], {}))
    with db.as_user(con, user):
        return csv_import.commit(con, user, result["import_id"], rows)


def test_確認画面_仕事っぽいものだけ最初からチェックがつく(app_con):
    result, spy = preview(app_con)
    by_desc = {r["description"]: r for r in result["rows"]}
    assert by_desc["ヨドバシカメラ"]["include"] is True and by_desc["ヨドバシカメラ"]["account_code"] == "5190"
    assert by_desc["スーパーまるや"]["include"] is False  # 生活っぽい
    assert by_desc["JR東日本"]["include"] is True
    assert list(spy.saved) == [f"csv/{ALICE}/{result['import_id']}.csv"]  # 元の CSV もとっておく


def test_チェックした行だけ取りこまれ_自分のお金で払った経費になる(app_con):
    result, _ = preview(app_con)
    assert commit(app_con, result) == {"created": 2, "skipped": 1}
    with db.as_user(app_con, ALICE):
        entries = ledger.list_entries(app_con, 2026)
    assert sorted(e["total"] for e in entries) == [680, 3300]
    assert all(e["source"] == "csv" and e["status"] == "confirmed" for e in entries)
    assert all(any(line["account_code"] == "2900" and line["side"] == "credit" for line in e["lines"]) for e in entries)


def test_同じCSVをもう一度入れても二重にならない(app_con):
    first, _ = preview(app_con)
    commit(app_con, first)
    second, _ = preview(app_con)
    done = [r for r in second["rows"] if r["duplicate"]]
    assert len(done) == 2 and all(r["include"] is False for r in done)
    assert commit(app_con, second, change={r["row_id"]: {"include": True} for r in second["rows"]})["created"] == 1
    with db.as_user(app_con, ALICE):
        assert len(ledger.list_entries(app_con, 2026)) == 3


def test_選んだ科目を覚えて_次はAIに聞かずに候補にする(app_con):
    first, _ = preview(app_con)
    # 「スーパーまるや」は仕事の打ち合わせのお茶代だった、と本人が直して取りこむ
    maruya = next(r for r in first["rows"] if r["description"] == "スーパーまるや")
    commit(app_con, first, change={maruya["row_id"]: {"include": True, "account_code": "5230"}})
    another = CARD.replace("2026/11/04", "2026/11/20")
    second, spy = preview(app_con, csv=another)
    row = next(r for r in second["rows"] if r["description"] == "スーパーまるや" and not r["duplicate"])
    assert row["account_code"] == "5230" and row["include"] is True and row["reason"] == "前に選んだ科目です"
    assert all("スーパーまるや" not in call for call in spy.calls)


def test_仕事用の口座の明細なら_入金は報酬として最初からチェック(app_con):
    result, _ = preview(app_con, csv=BANK, source="business")
    income = next(r for r in result["rows"] if r["direction"] == "in")
    assert income["include"] is True and income["account_code"] == "4100"
    commit(app_con, result)
    with db.as_user(app_con, ALICE):
        summary = ledger.summary(app_con, 2026)
    assert summary["revenue"] == 89790 and summary["expense"] == 4980


def test_一度取りこんだCSVはもう取りこめない(app_con):
    result, _ = preview(app_con)
    commit(app_con, result)
    with pytest.raises(ledger.ValidationError, match="もう取りこみ済み"):
        commit(app_con, result)


def test_経費の行に売上の科目はつけられない(app_con):
    result, _ = preview(app_con)
    first = result["rows"][0]["row_id"]
    with pytest.raises(ledger.ValidationError, match="科目がおかしい"):
        commit(app_con, result, change={first: {"include": True, "account_code": "4100"}})


def test_他人の取りこみは見えない_使えない(app_con):
    result, _ = preview(app_con, user=ALICE)
    with pytest.raises(ledger.NotFound):
        commit(app_con, result, user=BOB)


def test_読めないCSVはやさしい言葉で断る(app_con):
    with pytest.raises(ledger.ValidationError, match="列が見つかりませんでした"):
        preview(app_con, csv="A,B\n1,2\n", spy=type("S", (Spy,), {})())


def test_どこの明細か選んでいないと断る(app_con):
    with pytest.raises(ledger.ValidationError, match="どこの明細"):
        preview(app_con, source="")
