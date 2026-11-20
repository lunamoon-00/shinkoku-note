"""LINE の受け取り係（Webhook）。

LINE から届いた通知を、本物か確かめてから、
- 6けたの番号 → LINE とアプリをひも付ける
- 写真 → 待ち行列（SQS）に入れる（読み取りは時間がかかるので、読み取り係にまかせる）
- それ以外 → 使い方を返す
LINE は返事が遅いと何度も送りなおしてくるので、ここではすぐに 200 を返す。
"""

from __future__ import annotations

import base64
import json
import os
import re
import traceback

from . import db, line, secrets

HELP = (
    "📸 レシートや領収書の写真を送ってね。読み取って帳簿に記録するよ\n"
    "（まだつないでいなければ、アプリの「設定」→「LINEとつなぐ」で出る6けたの番号を送ってね）"
)


def _ok() -> dict:
    return {"statusCode": 200, "headers": {"content-type": "text/plain"}, "body": "ok"}


def _raw_body(event: dict) -> bytes:
    body = event.get("body") or ""
    return base64.b64decode(body) if event.get("isBase64Encoded") else body.encode("utf-8")


def _enqueue(message: dict) -> None:
    import boto3

    boto3.client("sqs").send_message(QueueUrl=os.environ["RECEIPT_QUEUE_URL"], MessageBody=json.dumps(message))


def handle_event(con, ev: dict, enqueue=_enqueue) -> None:
    source = ev.get("source", {})
    line_user_id = source.get("userId")
    reply_token = ev.get("replyToken")
    if source.get("type") != "user" or not line_user_id:
        return  # グループなどは使わない

    if ev.get("type") == "follow":
        line.reply(reply_token, [line.text("友だち追加ありがとう！\n" + HELP)])
        return
    if ev.get("type") != "message":
        return

    message = ev.get("message", {})
    if message.get("type") == "text":
        typed = re.sub(r"\s", "", str(message.get("text", "")))
        typed = typed.translate(str.maketrans("０１２３４５６７８９", "0123456789"))
        if re.fullmatch(r"\d{6}", typed):
            user_id = con.run("select line_link_by_code(:c, :l)", c=typed, l=line_user_id)[0][0]
            if user_id:
                line.reply(reply_token, [line.text("✅ アプリとつながったよ！\nこれからはレシートの写真を送るだけで記録するね")])
            else:
                line.reply(reply_token, [line.text("番号がちがうか、期限（10分）が切れているみたい。アプリでもう一度番号を出してね")])
            return
        line.reply(reply_token, [line.text(HELP)])
        return

    if message.get("type") in ("image", "file"):
        user_id = con.run("select line_user_lookup(:l)", l=line_user_id)[0][0]
        if not user_id:
            line.reply(reply_token, [line.text("まだアプリとつながっていないみたい。\n" + HELP)])
            return
        if message.get("type") == "file" and not str(message.get("fileName", "")).lower().endswith((".jpg", ".jpeg", ".png")):
            line.reply(reply_token, [line.text("写真（JPEG・PNG）で送ってね")])
            return
        enqueue({
            "user_id": user_id,
            "line_user_id": line_user_id,
            "message_id": message["id"],
            "reply_token": reply_token,
            "webhook_event_id": ev.get("webhookEventId"),
        })
        return

    line.reply(reply_token, [line.text(HELP)])


def handler(event, context):  # Lambda の入口（API Gateway の POST /line/webhook）
    body = _raw_body(event)
    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    if not line.verify_signature(body, headers.get("x-line-signature", ""), secrets.get("line_channel_secret")):
        return {"statusCode": 401, "body": "bad signature"}  # 本物の LINE からではない

    payload = json.loads(body or b"{}")
    con = db.shared_connection()
    for ev in payload.get("events", []):
        if ev.get("deliveryContext", {}).get("isRedelivery"):
            continue  # 送りなおし分は、もう受け取っている
        try:
            con.run("begin")
            handle_event(con, ev)
            con.run("commit")
        except Exception:
            con.run("rollback")
            traceback.print_exc()  # 1件の失敗で、ほかの通知を止めない
    return _ok()
