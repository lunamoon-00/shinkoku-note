"""API の入口（API Gateway HTTP API → この Lambda）。

ログインのチェックは API Gateway（Cognito の JWT）が先にやってくれる。
ここに届いたリクエストには、ログイン中の人の番号（sub）が必ず入っている。
"""

from __future__ import annotations

import datetime as dt
import json
import traceback

import pg8000.exceptions

from . import db, ledger

JSON_HEADERS = {"content-type": "application/json; charset=utf-8", "cache-control": "no-store"}


def _response(status: int, body) -> dict:
    return {"statusCode": status, "headers": JSON_HEADERS, "body": json.dumps(body, ensure_ascii=False)}


def _error(status: int, code: str, message: str, details: list | None = None) -> dict:
    return _response(status, {"error": {"code": code, "message": message, "details": details or []}})


def _user_id(event: dict) -> str:
    claims = event.get("requestContext", {}).get("authorizer", {}).get("jwt", {}).get("claims", {})
    sub = claims.get("sub")
    if not sub:
        raise PermissionError()
    return str(sub)


def _body(event: dict):
    raw = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        import base64

        raw = base64.b64decode(raw).decode("utf-8")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        raise ledger.ValidationError("送られてきた形がおかしいです（JSONではありません）") from None


def _year(event: dict) -> int:
    q = event.get("queryStringParameters") or {}
    raw = q.get("year", str(dt.date.today().year))
    if not raw.isdigit() or not 2000 <= int(raw) <= 2100:
        raise ledger.ValidationError("年は 2026 のような4桁の数字で入れてください")
    return int(raw)


def route(con, user_id: str, event: dict):
    """どの窓口（ルート）かを見て、帳簿の関数を呼ぶ。戻り値は (状態コード, 中身)。"""
    key = event.get("routeKey", "")
    path = event.get("pathParameters") or {}
    q = event.get("queryStringParameters") or {}

    if key == "GET /me":
        return 200, ledger.get_profile(con, user_id)
    if key == "PUT /me":
        return 200, ledger.update_profile(con, user_id, _body(event))
    if key == "GET /accounts":
        return 200, {"accounts": ledger.list_accounts(con)}
    if key == "GET /entries":
        return 200, {"entries": ledger.list_entries(con, _year(event), q.get("status"))}
    if key == "POST /entries":
        return 201, ledger.create_entry(con, user_id, _body(event))
    if key == "GET /entries/{id}":
        return 200, ledger.get_entry(con, path.get("id", ""))
    if key == "PUT /entries/{id}":
        return 200, ledger.update_entry(con, user_id, path.get("id", ""), _body(event))
    if key == "POST /entries/{id}/confirm":
        return 200, ledger.confirm_entry(con, user_id, path.get("id", ""))
    if key == "DELETE /entries/{id}":
        ledger.delete_entry(con, user_id, path.get("id", ""))
        return 204, None
    if key == "GET /summary":
        return 200, ledger.summary(con, _year(event))
    return 404, {"error": {"code": "NOT_FOUND", "message": "その窓口はありません", "details": []}}


def handler(event, context):  # Lambda の入口
    try:
        user_id = _user_id(event)
    except PermissionError:
        return _error(401, "UNAUTHORIZED", "ログインしてください")

    try:
        con = db.shared_connection()
        with db.as_user(con, user_id):
            status, body = route(con, user_id, event)
    except db.DatabaseUnavailable:
        # DBは使わないと自動で止まる。起きるまで20〜30秒かかるので、画面には「少し待ってね」と出す
        return _error(503, "DB_STARTING", "データベースを起こしています。数秒後にもう一度ためしてください")
    except ledger.ValidationError as e:
        return _error(400, "VALIDATION", e.message, e.details)
    except ledger.NotFound:
        return _error(404, "NOT_FOUND", "見つかりませんでした")
    except pg8000.exceptions.DatabaseError as e:
        message = str(e.args[0].get("M", "")) if e.args and isinstance(e.args[0], dict) else str(e)
        if "ENTRY_UNBALANCED" in message or "ENTRY_TOO_FEW_LINES" in message:
            return _error(400, "VALIDATION", "借方と貸方の合計が合っていません")
        traceback.print_exc()
        return _error(500, "INTERNAL", "うまくいきませんでした。時間をおいてもう一度ためしてください")
    except Exception:
        traceback.print_exc()  # 中身は CloudWatch のログにだけ残す（画面には出さない）
        return _error(500, "INTERNAL", "うまくいきませんでした。時間をおいてもう一度ためしてください")

    if status == 204:
        return {"statusCode": 204, "headers": {"cache-control": "no-store"}}
    return _response(status, body)
