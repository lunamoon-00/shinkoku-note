"""読み取り係（SQS から受け取って、レシートを読んで記録する）。

失敗したら SQS が自動でやりなおす（最大3回）。3回目も失敗したら、
LINE で「読めなかった」と伝えてから、失敗の置き場（DLQ）に送る。
"""

from __future__ import annotations

import json
import os
import traceback

from . import certificates, db, freee_worker, gemini, line, receipts, recurring

MAX_ATTEMPTS = 3

# LINE から届く写真の種類を、中身の先頭のバイトで見分ける
SIGNATURES = [(b"\xff\xd8\xff", "image/jpeg"), (b"\x89PNG", "image/png"), (b"RIFF", "image/webp")]


def mime_of(image: bytes) -> str | None:
    for head, mime in SIGNATURES:
        if image.startswith(head):
            return mime
    return None


def _s3_store(key: str, body: bytes, content_type: str) -> None:
    import boto3

    boto3.client("s3").put_object(
        Bucket=os.environ["UPLOADS_BUCKET"], Key=key, Body=body, ContentType=content_type,
        ServerSideEncryption="AES256",
    )


NOT_LINKED = (
    "まだアプリとつながっていないみたい。\n"
    "アプリの「設定」→「LINEとつなぐ」で出る6けたの番号を、ここに送ってね"
)


def process(msg: dict, store=_s3_store, reader=gemini.read_receipt, doc_reader=gemini.read_document) -> receipts.Outcome:
    con = db.shared_connection()
    # LINE の利用者番号から、アプリの利用者を引く（つながっていなければ写真は取りにいかない）
    con.run("begin")
    try:
        user_id = con.run("select line_user_lookup(:l)", l=msg["line_user_id"])[0][0]
        con.run("commit")
    except BaseException:
        con.run("rollback")
        raise
    if not user_id:
        return receipts.Outcome("not_linked", NOT_LINKED)

    image = line.get_content(msg["message_id"])
    mime = mime_of(image)
    if not mime:
        return receipts.Outcome("not_receipt", "写真の形式が読めませんでした。JPEG か PNG で送ってね")
    # まず何の書類かを見分ける。レシートならこれまでどおり、控除証明書などなら確定申告の準備へ
    doc = doc_reader(image, mime)
    with db.as_user(con, user_id):
        if doc.get("doc_type") in ("receipt", "other", None):
            outcome = receipts.process_receipt(con, user_id, image, mime, via="line", store=store, reader=reader)
        else:
            outcome = certificates.process_certificate(con, user_id, image, mime, doc, store=store, today=recurring.today_jst())
    outcome.entry_user = user_id
    return outcome


def handler(event, context):  # Lambda の入口（SQS）
    failures = []
    for record in event.get("Records", []):
        msg = json.loads(record["body"])
        attempt = int(record.get("attributes", {}).get("ApproximateReceiveCount", "1"))
        try:
            outcome = process(msg)
            line.reply_or_push(msg.get("reply_token"), msg["line_user_id"], [line.text(outcome.message)])
            if outcome.entry:
                freee_worker.kick_if_pending(db.shared_connection(), outcome.entry_user)
            print(json.dumps({"status": outcome.status, "attempt": attempt}))
        except Exception:
            traceback.print_exc()
            if attempt >= MAX_ATTEMPTS:
                try:
                    line.push(msg["line_user_id"], [line.text(
                        "😢 ごめんね、レシートを読み取れませんでした。少し時間をおいてもう一度送るか、アプリから手で入れてね"
                    )])
                except Exception:
                    traceback.print_exc()
            failures.append({"itemIdentifier": record["messageId"]})  # この1件だけ、やりなおしてもらう
    return {"batchItemFailures": failures}
