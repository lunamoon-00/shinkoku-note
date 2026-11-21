"""API の入口（handler）を、API Gateway から届く形のデータで試す。"""

import json

import pytest

from shinkoku import db, handler

from .conftest import ALICE, BOB, expense_payload


@pytest.fixture
def call(app_con, monkeypatch):
    monkeypatch.setattr(db, "shared_connection", lambda *a, **k: app_con)

    def _call(route_key, user=ALICE, body=None, path=None, query=None):
        event = {
            "routeKey": route_key,
            "pathParameters": path,
            "queryStringParameters": query,
            "body": json.dumps(body) if body is not None else None,
            "requestContext": {"authorizer": {"jwt": {"claims": {"sub": user}}}} if user else {},
        }
        res = handler.handler(event, None)
        return res["statusCode"], (json.loads(res["body"]) if res.get("body") else None)

    return _call


def test_ログインしていないと断る(call):
    status, body = call("GET /entries", user=None)
    assert status == 401
    assert body["error"]["code"] == "UNAUTHORIZED"


def test_登録すると201で中身が返る(call):
    status, body = call("POST /entries", body=expense_payload())
    assert status == 201
    assert body["total"] == 3300


def test_入力がおかしいと400で理由が返る(call):
    status, body = call("POST /entries", body=expense_payload(amount=-1))
    assert status == 400
    assert body["error"]["code"] == "VALIDATION"
    assert body["error"]["details"][0]["field"] == "lines[0].amount"


def test_JSONでないと400(call, app_con):
    event = {"routeKey": "POST /entries", "body": "{oops",
             "requestContext": {"authorizer": {"jwt": {"claims": {"sub": ALICE}}}}}
    assert handler.handler(event, None)["statusCode"] == 400


def test_他人の仕訳は404(call):
    _, created = call("POST /entries", body=expense_payload())
    status, _ = call("GET /entries/{id}", user=BOB, path={"id": created["id"]})
    assert status == 404


def test_番号の形がおかしくても404(call):
    status, _ = call("GET /entries/{id}", path={"id": "not-a-uuid"})
    assert status == 404


def test_一覧_集計_削除の流れ(call):
    _, created = call("POST /entries", body=expense_payload())
    status, body = call("GET /entries", query={"year": "2026"})
    assert status == 200 and len(body["entries"]) == 1
    status, body = call("GET /summary", query={"year": "2026"})
    assert status == 200 and body["expense"] == 3300
    status, body = call("DELETE /entries/{id}", path={"id": created["id"]})
    assert status == 204 and body is None


def test_年の形がおかしいと400(call):
    status, _ = call("GET /entries", query={"year": "26"})
    assert status == 400


def test_科目の一覧と設定(call):
    status, body = call("GET /accounts")
    assert status == 200 and len(body["accounts"]) >= 30
    status, body = call("PUT /me", body={"mode": "freee"})
    assert status == 200 and body["mode"] == "freee"


def test_ない窓口は404(call):
    status, _ = call("GET /nothing")
    assert status == 404


def test_DBが起動中なら503で待ってねと返す(monkeypatch):
    def unavailable(*a, **k):
        raise db.DatabaseUnavailable("starting")

    monkeypatch.setattr(db, "shared_connection", unavailable)
    event = {"routeKey": "GET /entries", "requestContext": {"authorizer": {"jwt": {"claims": {"sub": ALICE}}}}}
    res = handler.handler(event, None)
    assert res["statusCode"] == 503
    assert json.loads(res["body"])["error"]["code"] == "DB_STARTING"


def test_くり返し設定を作ると_過去の分がすぐ記録される(call):
    status, body = call("POST /recurring", body={"name": "スマホ代", "account_code": "5140", "amount": 4980,
                                                  "business_ratio": 50, "day_of_month": 1, "start_month": "2026-01"})
    assert status == 201 and body["created"] >= 1 and body["rule"]["monthly_expense"] == 2490
    status, body = call("GET /recurring")
    assert status == 200 and len(body["rules"]) == 1
    rule_id = body["rules"][0]["id"]
    status, body = call("PUT /recurring/{id}/active", path={"id": rule_id}, body={"active": False})
    assert status == 200 and body["rule"]["active"] is False
    status, _ = call("DELETE /recurring/{id}", path={"id": rule_id})
    assert status == 204
