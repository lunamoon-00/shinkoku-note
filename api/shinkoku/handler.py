"""API の入口（API Gateway HTTP API → この Lambda）。

ログインのチェックは API Gateway（Cognito の JWT）が先にやってくれる。
ここに届いたリクエストには、ログイン中の人の番号（sub）が必ず入っている。
"""

from __future__ import annotations

import base64
import datetime as dt
import json
import traceback

import pg8000.exceptions

import os

from . import certificates, csv_import, db, depreciation, freee_api, freee_sync, freee_worker, ledger, receipts, recurring, tax_service

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


def _receipt_url(s3_key: str) -> str:
    """レシート写真を5分だけ見られるURL（S3 の署名つきURL）。本人のAPIからしか作れない"""
    import boto3

    return boto3.client("s3").generate_presigned_url(
        "get_object", Params={"Bucket": os.environ["UPLOADS_BUCKET"], "Key": s3_key}, ExpiresIn=300
    )


def _classify(descriptions, accounts):
    """明細の内容から科目の候補を聞く。Gemini が止まっていても、取りこみは続けられるようにする"""
    from . import gemini

    try:
        return gemini.classify_descriptions(descriptions, accounts)
    except Exception:
        traceback.print_exc()
        return {}


def _s3_store(key: str, body: bytes, content_type: str) -> None:
    import boto3

    boto3.client("s3").put_object(
        Bucket=os.environ["UPLOADS_BUCKET"], Key=key, Body=body, ContentType=content_type, ServerSideEncryption="AES256"
    )


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
        entry = ledger.update_entry(con, user_id, path.get("id", ""), _body(event))
        if entry["status"] == "confirmed":
            receipts.learn_partner(con, user_id, entry)  # レシートの科目を直したら覚える
        return 200, entry
    if key == "POST /entries/{id}/confirm":
        entry = ledger.confirm_entry(con, user_id, path.get("id", ""))
        receipts.learn_partner(con, user_id, entry)
        return 200, entry
    if key == "GET /entries/{id}/receipt":
        s3_key = ledger.receipt_key(con, path.get("id", ""))
        if not s3_key:
            return 404, {"error": {"code": "NOT_FOUND", "message": "この記録にはレシートの写真がありません", "details": []}}
        return 200, {"url": _receipt_url(s3_key)}
    if key == "POST /imports/csv":
        body = _body(event)
        try:
            raw = base64.b64decode(str(body.get("content_base64", "")), validate=True)
        except ValueError:
            raise ledger.ValidationError("ファイルが読めませんでした") from None
        return 200, csv_import.preview(
            con, user_id, raw, str(body.get("source", "")),
            filename=str(body.get("filename", "")), classifier=_classify, store=_s3_store,
        )
    if key == "POST /imports/{id}/commit":
        return 200, csv_import.commit(con, user_id, path.get("id", ""), _body(event).get("rows"))
    if key == "GET /recurring":
        return 200, {"rules": recurring.list_rules(con)}
    if key == "POST /recurring":
        rule = recurring.create_rule(con, user_id, _body(event))
        # 「いつから」が過去なら、その月からの分をすぐに記録する
        created = recurring.run_for_user(con, user_id, recurring.today_jst())
        return 201, {"rule": rule, "created": created}
    if key == "PUT /recurring/{id}/active":
        active = _body(event).get("active")
        if not isinstance(active, bool):
            raise ledger.ValidationError("はい（true）かいいえ（false）で送ってください")
        rule = recurring.set_active(con, user_id, path.get("id", ""), active)
        created = recurring.run_for_user(con, user_id, recurring.today_jst()) if active else 0
        return 200, {"rule": rule, "created": created}
    if key == "DELETE /recurring/{id}":
        recurring.delete_rule(con, user_id, path.get("id", ""))
        return 204, None
    if key == "GET /freee":
        return 200, freee_sync.status(con)
    if key == "POST /freee/connect":
        return 200, {"url": freee_sync.start_connect(con, user_id)}
    if key == "PUT /freee/sources":
        return 200, freee_sync.set_sources(con, user_id, _body(event).get("sources"))
    if key == "DELETE /freee":
        freee_sync.disconnect(con, user_id, freee_api.TokenStore())
        return 204, None
    if key == "GET /entries/{id}/freee":
        ledger.get_entry(con, path.get("id", ""))  # 自分の記録でなければ NotFound
        return 200, {"sync": freee_sync.entry_sync(con, path.get("id", ""))}
    if key in ("GET /tax/{year}", "PUT /tax/{year}/inputs"):
        raw = str(path.get("year", ""))
        if not raw.isdigit() or not 2025 <= int(raw) <= 2100:
            raise ledger.ValidationError("年は 2026 のような4桁の数字で入れてください")
        year = int(raw)
        if key == "PUT /tax/{year}/inputs":
            tax_service.save_inputs(con, user_id, year, _body(event))
        return 200, tax_service.compute(con, year)
    if key == "DELETE /tax/documents/{id}":
        certificates.delete_document(con, user_id, path.get("id", ""))
        return 204, None
    if key == "GET /assets":
        return 200, {"assets": depreciation.list_assets(con)}
    if key == "POST /assets":
        return 201, depreciation.create_asset(con, user_id, _body(event))
    if key == "DELETE /assets/{id}":
        depreciation.delete_asset(con, user_id, path.get("id", ""))
        return 204, None
    if key == "GET /review":
        return 200, {"count": ledger.review_count(con)}
    if key == "GET /line":
        return 200, ledger.line_status(con)
    if key == "POST /line/link-code":
        return 200, ledger.create_line_link_code(con, user_id)
    if key == "DELETE /line":
        ledger.unlink_line(con, user_id)
        return 204, None
    if key == "DELETE /entries/{id}":
        ledger.delete_entry(con, user_id, path.get("id", ""))
        return 204, None
    if key == "GET /summary":
        return 200, ledger.summary(con, _year(event))
    return 404, {"error": {"code": "NOT_FOUND", "message": "その窓口はありません", "details": []}}


def _redirect(location: str) -> dict:
    return {"statusCode": 302, "headers": {"location": location, "cache-control": "no-store"}}


def freee_callback(event: dict) -> dict:
    """freee の許可画面から戻ってきたところ（ログインの情報はないので、合言葉 state で本人を確かめる）"""
    web = os.environ.get("WEB_URL", "http://localhost:3000")
    q = event.get("queryStringParameters") or {}
    if q.get("error") or not q.get("code") or not q.get("state"):
        return _redirect(f"{web}/settings/?freee=cancelled")
    try:
        con = db.shared_connection()
        freee_sync.finish_connect(con, q["state"], q["code"], freee_api.TokenStore())
        return _redirect(f"{web}/settings/?freee=connected")
    except ledger.ValidationError:
        return _redirect(f"{web}/settings/?freee=expired")
    except Exception:
        traceback.print_exc()
        return _redirect(f"{web}/settings/?freee=error")


def handler(event, context):  # Lambda の入口
    if event.get("routeKey") == "GET /freee/callback":
        return freee_callback(event)
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

    # 記録を変えたら、freee に送る予定がないか見て、あれば送る係を起こす
    if not event.get("routeKey", "").startswith("GET ") and status < 400:
        freee_worker.kick_if_pending(con, user_id)

    if status == 204:
        return {"statusCode": 204, "headers": {"cache-control": "no-store"}}
    return _response(status, body)
