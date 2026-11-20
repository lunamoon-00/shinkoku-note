"""レシートの写真 → 仕訳。読み取り（Gemini）と保存（S3）はニセモノに差しかえて試す。"""

import datetime as dt

import pytest

from shinkoku import db, ledger, receipts

from .conftest import ALICE, BOB

TODAY = dt.date(2026, 11, 21)
IMAGE = b"\xff\xd8\xff" + b"receipt-1"


def ai_result(**over):
    base = {
        "is_receipt": True, "date": "2026-11-20", "total": 3300, "store": "ダイソー 渋谷店",
        "items": "USBケーブル", "account_code": "5190", "confidence": 0.95,
        "tax_8": 0, "tax_10": 3300, "invoice_number": "", "unclear": "",
    }
    return {**base, **over}


class FakeS3:
    def __init__(self):
        self.saved = {}

    def __call__(self, key, body, mime):
        self.saved[key] = (body, mime)


def run(con, user=ALICE, image=IMAGE, **ai):
    s3 = FakeS3()
    with db.as_user(con, user):
        out = receipts.process_receipt(con, user, image, "image/jpeg", via="line", store=s3,
                                       reader=lambda *_: ai_result(**ai), today=TODAY)
    return out, s3


def test_自信があれば自動で確定して_LINEに返す文を作る(app_con):
    out, s3 = run(app_con)
    assert out.status == "auto_confirmed"
    assert out.entry["status"] == "confirmed"
    assert out.entry["source"] == "receipt" and out.entry["has_receipt"]
    assert {(line["side"], line["account_code"], line["amount"]) for line in out.entry["lines"]} == {
        ("debit", "5190", 3300), ("credit", "2900", 3300),
    }
    assert "記録したよ" in out.message and "3,300円" in out.message
    [(key, (body, _))] = s3.saved.items()
    assert key.startswith(f"receipts/{ALICE}/2026/") and body == IMAGE


def test_初めてのお店で自信がないときは下書きにして理由を伝える(app_con):
    out, _ = run(app_con, confidence=0.4)
    assert out.status == "needs_review"
    assert out.entry["status"] == "draft"
    assert "（科目）を確かめてください" in out.message


def test_雑費を選んだときも確認してもらう(app_con):
    out, _ = run(app_con, account_code="5900", confidence=0.99)
    assert out.status == "needs_review"


def test_本人が確定すると_次からそのお店は自動で確定する(app_con):
    first, _ = run(app_con, confidence=0.4, account_code="5900")
    with db.as_user(app_con, ALICE):
        # 本人が科目を「会議費」に直して確定
        fixed = ledger.update_entry(app_con, ALICE, first.entry["id"], {
            "entry_date": "2026-11-20", "partner": "ダイソー 渋谷店", "status": "confirmed",
            "lines": [{"side": "debit", "account_code": "5230", "amount": 3300},
                      {"side": "credit", "account_code": "2900", "amount": 3300}],
        })
        fixed["source"] = "receipt"
        receipts.learn_partner(app_con, ALICE, fixed)
    # 表記ゆれ（全角・空白）があっても同じお店とみなす
    second, _ = run(app_con, image=IMAGE + b"2", store="ダイソー　渋谷店", confidence=0.1, account_code="5190")
    assert second.status == "auto_confirmed"
    assert any(line["account_code"] == "5230" for line in second.entry["lines"])


def test_同じ写真は二重に記録しない(app_con):
    run(app_con)
    again, s3 = run(app_con)
    assert again.status == "duplicate"
    assert s3.saved == {}
    with db.as_user(app_con, ALICE):
        assert len(ledger.list_entries(app_con, 2026)) == 1


def test_同じ写真でも_別の人なら記録できる(app_con):
    run(app_con, user=ALICE)
    out, _ = run(app_con, user=BOB)
    assert out.status == "auto_confirmed"


def test_レシートでない写真は記録しない(app_con):
    out, _ = run(app_con, is_receipt=False)
    assert out.status == "not_receipt"
    with db.as_user(app_con, ALICE):
        assert ledger.list_entries(app_con, 2026) == []
        assert app_con.run("select status from import_files")[0][0] == "not_receipt"


def test_金額が読めないときは記録せず_手で入れてもらう(app_con):
    out, _ = run(app_con, total=0)
    assert out.status == "needs_review"
    assert out.entry is None
    assert "金額が読めませんでした" in out.message


@pytest.mark.parametrize("date", ["", "2026-13-01", "2027-01-01", "2020-01-01"])
def test_日付がおかしいときは今日にして確認してもらう(app_con, date):
    out, _ = run(app_con, date=date)
    assert out.status == "needs_review"
    assert out.entry["entry_date"] == "2026-11-21"


def test_お店の名前のそろえ方():
    assert receipts.partner_key("ﾀﾞｲｿｰ 渋谷店") == receipts.partner_key("ダイソー　渋谷店")
    assert receipts.partner_key("Seven-Eleven") == receipts.partner_key("seven eleven")


def test_レシートの写真は本人だけが見られる(app_con):
    out, _ = run(app_con)
    with db.as_user(app_con, ALICE):
        assert ledger.receipt_key(app_con, out.entry["id"]).startswith(f"receipts/{ALICE}/")
    with db.as_user(app_con, BOB):
        with pytest.raises(ledger.NotFound):
            ledger.receipt_key(app_con, out.entry["id"])
        assert app_con.run("select count(*) from import_files")[0][0] == 0
        assert app_con.run("select count(*) from partner_rules")[0][0] == 0


def test_確認待ちの件数(app_con):
    run(app_con, confidence=0.1)
    with db.as_user(app_con, ALICE):
        assert ledger.review_count(app_con) == 1
    with db.as_user(app_con, BOB):
        assert ledger.review_count(app_con) == 0
