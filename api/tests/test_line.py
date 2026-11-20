"""LINE の受け取り係（Webhook）・読み取り係（Worker）・ひも付けの番号。"""

import base64
import hashlib
import hmac
import json

import pytest

from shinkoku import db, ledger, line, webhook, worker

from .conftest import ALICE, BOB

SECRET = "test-channel-secret"
LINE_ALICE = "U" + "a" * 32


@pytest.fixture(autouse=True)
def fake_line(monkeypatch):
    """LINE の API を呼ばずに、送ろうとした中身を記録する"""
    sent = []
    monkeypatch.setenv("SHINKOKU_SECRET_LINE_CHANNEL_SECRET", SECRET)
    monkeypatch.setenv("SHINKOKU_SECRET_LINE_CHANNEL_ACCESS_TOKEN", "test-token")

    def fake_request(method, url, body=None, timeout=10):
        sent.append((method, url, body))
        if url.endswith("/content"):
            return b"\xff\xd8\xff" + b"photo"
        return b"{}"

    monkeypatch.setattr(line, "_request", fake_request)
    return sent


def sign(body: bytes) -> str:
    return base64.b64encode(hmac.new(SECRET.encode(), body, hashlib.sha256).digest()).decode()


def text_event(text, user=LINE_ALICE):
    return {"type": "message", "replyToken": "r1", "source": {"type": "user", "userId": user},
            "message": {"type": "text", "id": "m1", "text": text}, "deliveryContext": {"isRedelivery": False}}


def image_event(user=LINE_ALICE):
    return {"type": "message", "replyToken": "r2", "source": {"type": "user", "userId": user},
            "message": {"type": "image", "id": "m2"}, "deliveryContext": {"isRedelivery": False}}


def replies(sent):
    return [m["text"] for _, url, body in sent if url.endswith("/reply") for m in body["messages"]]


# ───────── 署名 ─────────
def test_署名が合っていれば本物():
    body = b'{"events":[]}'
    assert line.verify_signature(body, sign(body), SECRET)


def test_本文が書きかえられていたら偽物():
    assert not line.verify_signature(b'{"events":[1]}', sign(b'{"events":[]}'), SECRET)
    assert not line.verify_signature(b"{}", "", SECRET)


def test_署名がない通知は401で断る(monkeypatch):
    res = webhook.handler({"body": '{"events":[]}', "headers": {}}, None)
    assert res["statusCode"] == 401


def test_本物の通知には200を返す(app_con, monkeypatch):
    monkeypatch.setattr(db, "shared_connection", lambda *a, **k: app_con)
    body = json.dumps({"events": [text_event("こんにちは")]})
    res = webhook.handler({"body": body, "headers": {"X-Line-Signature": sign(body.encode())}}, None)
    assert res["statusCode"] == 200


# ───────── ひも付け ─────────
def link(app_con, fake_line, user=ALICE, line_user=LINE_ALICE):
    with db.as_user(app_con, user):
        code = ledger.create_line_link_code(app_con, user)["code"]
    webhook.handle_event(lambda: app_con, text_event(f" {code} ", user=line_user))
    return code


def test_6けたの番号を送るとつながる(app_con, fake_line):
    link(app_con, fake_line)
    assert "つながったよ" in replies(fake_line)[-1]
    with db.as_user(app_con, ALICE):
        assert ledger.line_status(app_con)["linked"] is True
    with db.as_user(app_con, BOB):
        assert ledger.line_status(app_con)["linked"] is False  # 他人のつながりは見えない


def test_番号は1回しか使えない(app_con, fake_line):
    code = link(app_con, fake_line)
    webhook.handle_event(lambda: app_con, text_event(code, user="U" + "b" * 32))
    assert "番号がちがうか" in replies(fake_line)[-1]


def test_期限切れの番号は使えない(app_con, fake_line, database):
    with db.as_user(app_con, ALICE):
        code = ledger.create_line_link_code(app_con, ALICE)["code"]
    database.run("update line_link_codes set expires_at = now() - interval '1 minute'")
    webhook.handle_event(lambda: app_con, text_event(code))
    assert "期限" in replies(fake_line)[-1]


def test_全角の番号でもOK(app_con, fake_line):
    with db.as_user(app_con, ALICE):
        code = ledger.create_line_link_code(app_con, ALICE)["code"]
    zenkaku = code.translate(str.maketrans("0123456789", "０１２３４５６７８９"))
    webhook.handle_event(lambda: app_con, text_event(zenkaku))
    assert "つながったよ" in replies(fake_line)[-1]


def test_つなぎを外せる(app_con, fake_line):
    link(app_con, fake_line)
    with db.as_user(app_con, ALICE):
        ledger.unlink_line(app_con, ALICE)
        assert ledger.line_status(app_con)["linked"] is False


# ───────── 写真 ─────────
def test_写真はDBにさわらず_すぐ待ち行列に入れる(fake_line):
    def no_db():
        raise AssertionError("受け取り係は写真のときに DB にさわってはいけない")

    queued = []
    webhook.handle_event(no_db, image_event(), enqueue=queued.append)
    assert queued == [{"line_user_id": LINE_ALICE, "message_id": "m2", "reply_token": "r2", "webhook_event_id": None}]


def test_LINEの検証では_DBにさわらず200を返す(monkeypatch):
    def no_db(*a, **k):
        raise AssertionError("DB にさわってはいけない")

    monkeypatch.setattr(db, "shared_connection", no_db)
    body = b'{"destination":"x","events":[]}'
    res = webhook.handler({"body": body.decode(), "headers": {"x-line-signature": sign(body)}}, None)
    assert res["statusCode"] == 200


def test_つないでいない人の写真は_読み取り係が断る(app_con, fake_line, monkeypatch):
    monkeypatch.setattr(db, "shared_connection", lambda *a, **k: app_con)
    out = worker.process({"line_user_id": "U" + "z" * 32, "message_id": "m2", "reply_token": "r2"},
                         store=lambda *a: None, reader=lambda *_: {})
    assert out.status == "not_linked"
    assert not any(url.endswith("/content") for _, url, _ in fake_line)  # 写真は取りにいかない


def test_読み取り係が記録してLINEに返事する(app_con, fake_line, monkeypatch):
    link(app_con, fake_line)
    monkeypatch.setattr(db, "shared_connection", lambda *a, **k: app_con)
    ai = {"is_receipt": True, "date": "2026-11-20", "total": 500, "store": "書店", "items": "本",
          "account_code": "5210", "confidence": 0.9, "tax_8": 0, "tax_10": 500, "invoice_number": "", "unclear": ""}
    stored = {}
    msg = {"line_user_id": LINE_ALICE, "message_id": "m2", "reply_token": "r2"}
    out = worker.process(msg, store=lambda k, b, m: stored.update({k: b}), reader=lambda *_: ai)
    assert out.status == "auto_confirmed"
    assert len(stored) == 1


def test_読み取り係は3回失敗したらLINEで伝えて失敗の置き場へ(monkeypatch, fake_line):
    def boom(msg, **_):
        raise RuntimeError("Gemini が止まっている")

    monkeypatch.setattr(worker, "process", boom)
    body = json.dumps({"user_id": ALICE, "line_user_id": LINE_ALICE, "message_id": "m2", "reply_token": "r2"})
    first = worker.handler({"Records": [{"messageId": "q1", "body": body, "attributes": {"ApproximateReceiveCount": "1"}}]}, None)
    assert first == {"batchItemFailures": [{"itemIdentifier": "q1"}]}
    assert not any(url.endswith("/push") for _, url, _ in fake_line)  # 1回目はだまってやりなおす
    worker.handler({"Records": [{"messageId": "q1", "body": body, "attributes": {"ApproximateReceiveCount": "3"}}]}, None)
    pushes = [b for _, url, b in fake_line if url.endswith("/push")]
    assert pushes and "読み取れませんでした" in pushes[0]["messages"][0]["text"]


def test_写真の種類を中身で見分ける():
    assert worker.mime_of(b"\xff\xd8\xff\xe0") == "image/jpeg"
    assert worker.mime_of(b"\x89PNG\r\n") == "image/png"
    assert worker.mime_of(b"%PDF-1.7") is None
