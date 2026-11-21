"""控除証明書などの写真 → 確定申告の準備。読み取り（Gemini）はニセモノに差しかえて試す。"""

import datetime as dt

import pytest

from shinkoku import certificates, db, tax_service, worker

from .conftest import ALICE, BOB

TODAY = dt.date(2026, 11, 21)
IMG = b"\xff\xd8\xff" + b"cert"


def doc(**over):
    base = {"doc_type": "social_insurance", "issuer": "日本年金機構", "year": 2026, "amount": 0,
            "life_new_general": 0, "life_new_medical": 0, "life_new_pension": 0, "life_old_general": 0, "life_old_pension": 0,
            "salary_gross": 0, "salary_after_deduction": 0, "salary_withheld": 0, "salary_social": 0,
            "eq_earthquake": 0, "eq_old_long": 0}
    return {**base, **over}


def send(con, d, user=ALICE, image=IMG):
    saved = {}
    with db.as_user(con, user):
        out = certificates.process_certificate(con, user, image, "image/jpeg", d, store=lambda k, b, m: saved.update({k: b}), today=TODAY)
    return out, saved


def test_国民年金の控除証明書を読むと_社会保険料に足される(app_con):
    out, saved = send(app_con, doc(amount=203_760))
    assert out.status == "auto_confirmed" and "203,760円" in out.message
    assert list(saved)[0].startswith(f"certificates/{ALICE}/2026/")
    with db.as_user(app_con, ALICE):
        tax_service.save_inputs(app_con, ALICE, 2026, {"social_insurance": 100_000})
        result = tax_service.compute(app_con, 2026)
    assert result["result"]["deductions"]["social_insurance"] == 303_760    # 手入力 10万 ＋ 写真 203,760
    assert result["inputs"]["social_insurance"] == 100_000                 # 保存してあるのは手入力の分だけ
    assert result["documents"][0]["label"].startswith("社会保険料")


def test_生命保険料の証明書は区分ごとに足す(app_con):
    send(app_con, doc(doc_type="life_insurance", issuer="〇〇生命", life_new_general=80_000, life_new_medical=30_000))
    with db.as_user(app_con, ALICE):
        r = tax_service.compute(app_con, 2026)["result"]
    assert r["deductions"]["life_insurance"] == 40_000 + 25_000   # 一般 80,000→40,000 ／ 介護医療 30,000→30,000÷2＋10,000


def test_源泉徴収票はお給料として計算に入る(app_con):
    send(app_con, doc(doc_type="salary", issuer="前の会社", salary_gross=2_000_000, salary_withheld=40_000, salary_social=280_000))
    with db.as_user(app_con, ALICE):
        r = tax_service.compute(app_con, 2026)["result"]
    assert r["salary_income"] == 1_260_000 and r["withholding"] == 40_000


def test_支払調書は_源泉徴収が二重にならないよう計算には足さない(app_con):
    out, _ = send(app_con, doc(doc_type="payment_record", amount=102_100))
    assert "支払調書" in out.message
    with db.as_user(app_con, ALICE):
        r = tax_service.compute(app_con, 2026)["result"]
    assert r["withholding"] == 0


def test_同じ写真は二重に入れない_金額が読めなければ入れない(app_con):
    send(app_con, doc(amount=1000))
    again, saved = send(app_con, doc(amount=1000))
    assert again.status == "duplicate" and saved == {}
    unreadable, _ = send(app_con, doc(amount=0), image=IMG + b"2")
    assert unreadable.status == "needs_review"


def test_年がわからなければ_今の時期で決める(app_con):
    send(app_con, doc(amount=1000, year=0))
    with db.as_user(app_con, ALICE):
        assert tax_service.compute(app_con, 2026)["documents"][0]["total"] == 1000


def test_消せる_他人のは見えない(app_con):
    send(app_con, doc(amount=1000))
    with db.as_user(app_con, BOB):
        assert certificates.list_documents(app_con, 2026) == []
    with db.as_user(app_con, ALICE):
        [d] = certificates.list_documents(app_con, 2026)
        certificates.delete_document(app_con, ALICE, d["id"])
        assert certificates.list_documents(app_con, 2026) == []


def test_LINEの読み取り係は_書類の種類で振り分ける(app_con, monkeypatch):
    from shinkoku import line

    monkeypatch.setattr(db, "shared_connection", lambda *a, **k: app_con)
    monkeypatch.setattr(line, "get_content", lambda mid: IMG + mid.encode())
    app_con.run("begin")
    app_con.run("select set_config('app.user_id', :u, true)", u=ALICE)
    app_con.run("insert into line_links (user_id, line_user_id) values (:u, 'U-a')", u=ALICE)
    app_con.run("commit")
    msg = {"line_user_id": "U-a", "message_id": "m1", "reply_token": "r"}
    out = worker.process(msg, store=lambda *a: None, reader=lambda *_: pytest.fail("レシートとして読んではいけない"),
                         doc_reader=lambda *_: doc(doc_type="donation", amount=30_000))
    assert out.status == "auto_confirmed" and "ふるさと納税" in out.message
