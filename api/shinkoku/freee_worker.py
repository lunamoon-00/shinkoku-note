"""freee に送る係（SQS から「この人の分を送って」を受け取る）。毎朝の見回りからも呼ばれる。"""

from __future__ import annotations

import json
import os
import traceback

from . import db, freee_api, freee_sync


def read_receipt(key: str) -> tuple[bytes, str]:
    import boto3

    obj = boto3.client("s3").get_object(Bucket=os.environ["UPLOADS_BUCKET"], Key=key)
    return obj["Body"].read(), obj.get("ContentType", "image/jpeg")


def sync(user_id: str) -> dict:
    con = db.shared_connection()
    return freee_sync.sync_user(con, user_id, freee_api.Client(user_id), read_receipt=read_receipt)


def handler(event, context):  # Lambda の入口（SQS）
    failures = []
    for record in event.get("Records", []):
        try:
            user_id = json.loads(record["body"])["user_id"]
            print(json.dumps({"user": "…" + user_id[-4:], **sync(user_id)}))
        except Exception:
            traceback.print_exc()
            failures.append({"itemIdentifier": record["messageId"]})
    return {"batchItemFailures": failures}


def enqueue(user_id: str) -> None:
    """「この人の分を送って」を待ち行列に入れる（freee の行列の場所が設定されていなければ何もしない）"""
    url = os.environ.get("FREEE_QUEUE_URL")
    if not url:
        return
    import boto3

    boto3.client("sqs").send_message(QueueUrl=url, MessageBody=json.dumps({"user_id": user_id}))


def kick_if_pending(con, user_id: str) -> None:
    """記録を変えたあと（トランザクションの外で）呼ぶ。送る予定があれば送る係を起こす"""
    try:
        with db.as_user(con, user_id):
            pending = freee_sync.has_pending(con)
        if pending:
            enqueue(user_id)
    except Exception:
        traceback.print_exc()  # 送れなくても毎朝の見回りで送るので、ここでは止めない
