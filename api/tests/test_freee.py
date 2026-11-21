"""freee 連携。本物の freee には送らず、ニセの freee（呼ばれた中身を記録する）で試す。"""

import datetime as dt
import urllib.parse

import pytest

from shinkoku import db, freee_api, freee_sync, handler, ledger, recurring

from .conftest import ALICE, BOB

ITEMS = [
    {"id": 101, "name": "消耗品費", "default_tax_code": 136},
    {"id": 102, "name": "通信費", "default_tax_code": 136},
    {"id": 103, "name": "地代家賃", "default_tax_code": 136},
    {"id": 104, "name": "交際費", "default_tax_code": 136},  # このアプリでは「接待交際費」
    {"id": 201, "name": "事業主借", "default_tax_code": 2},
    {"id": 202, "name": "事業主貸", "default_tax_code": 2},
    {"id": 301, "name": "売上高", "default_tax_code": 129},  # このアプリでは「売上」
    # 「普通預金」はない（口座を登録していない人）
]


class FakeFreee:
    def __init__(self):
        self.calls = []
        self.next_id = 1000
        self.fail_post = False
        self.not_connected = False

    def _id(self):
        self.next_id += 1
        return self.next_id

    def get(self, path, **q):
        if self.not_connected:
            raise freee_api.NotConnected()
        assert path == "/api/1/account_items"
        return {"account_items": ITEMS}

    def post(self, path, body):
        self.calls.append(("POST", path, body))
        if self.fail_post:
            raise freee_api.FreeeError(500, "freee が止まっている")
        key = "deal" if path.endswith("deals") else "manual_journal"
        return {key: {"id": self._id()}}

    def delete(self, path, **q):
        self.calls.append(("DELETE", path, q))

    def request(self, method, path, **kw):
        self.calls.append((method, path, kw.get("multipart", (None,))[0]))
        return {"receipt": {"id": 777}}


class FakeStore:
    def __init__(self):
        self.tokens = {}

    def get(self, user_id):
        return self.tokens.get(user_id)

    def put(self, user_id, token):
        self.tokens[user_id] = token

    def delete(self, user_id):
        self.tokens.pop(user_id, None)


def connect(con, user=ALICE, store=None):
    store = store or FakeStore()
    with db.as_user(con, user):
        url = freee_sync.start_connect(con, user)
    state = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)["state"][0]
    freee_sync.finish_connect(
        con, state, "the-code", store,
        exchange=lambda code: {"access_token": "a", "refresh_token": "r", "expires_at": 9e9},
        companies=lambda client: [{"id": 12345, "display_name": "テスト事業所"}],
    )
    return store


def expense(con, user=ALICE, amount=3300, code="5190", status="confirmed", source="manual", credit="2900"):
    with db.as_user(con, user):
        return ledger.create_entry(con, user, {
            "entry_date": "2026-11-20", "partner": "家電店", "description": "ケーブル", "status": status, "source": source,
            "lines": [{"side": "debit", "account_code": code, "amount": amount},
                      {"side": "credit", "account_code": credit, "amount": amount}],
        })


def sync_rows(con, user=ALICE):
    with db.as_user(con, user):
        return {str(r[0]): tuple(r[1:]) for r in con.run("select entry_id, op, status, freee_kind, freee_id from freee_syncs")}


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setenv("SHINKOKU_SECRET_FREEE_CLIENT_ID", "client-123")
    monkeypatch.setenv("SHINKOKU_SECRET_FREEE_CLIENT_SECRET", "secret-xyz")
    monkeypatch.setenv("FREEE_REDIRECT_URI", "https://example.com/freee/callback")


# ───────── つなぐ ─────────
def test_許可画面のURLには合言葉と戻り先が入る(app_con):
    with db.as_user(app_con, ALICE):
        url = freee_sync.start_connect(app_con, ALICE)
    q = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
    assert q["client_id"] == ["client-123"] and q["redirect_uri"] == ["https://example.com/freee/callback"]
    assert len(q["state"][0]) >= 40


def test_戻ってきたら鍵をしまい_freeeモードになる(app_con):
    store = connect(app_con)
    assert store.tokens[ALICE]["refresh_token"] == "r"
    with db.as_user(app_con, ALICE):
        s = freee_sync.status(app_con)
        assert s["connected"] and s["company_name"] == "テスト事業所"
        assert s["send_sources"] == ["receipt", "recurring", "manual"]
        assert ledger.get_profile(app_con, ALICE)["mode"] == "freee"


def test_合言葉は1回しか使えない_期限切れも断る(app_con, database):
    with db.as_user(app_con, ALICE):
        url = freee_sync.start_connect(app_con, ALICE)
    state = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)["state"][0]
    kwargs = dict(exchange=lambda c: {"access_token": "a", "refresh_token": "r", "expires_at": 9e9},
                  companies=lambda c: [{"id": 1}])
    freee_sync.finish_connect(app_con, state, "c", FakeStore(), **kwargs)
    with pytest.raises(ledger.ValidationError, match="期限"):
        freee_sync.finish_connect(app_con, state, "c", FakeStore(), **kwargs)
    with pytest.raises(ledger.ValidationError):
        freee_sync.finish_connect(app_con, "made-up-state", "c", FakeStore(), **kwargs)


def test_戻り先の窓口は_失敗してもアプリの設定画面に戻す(monkeypatch, app_con):
    monkeypatch.setenv("WEB_URL", "https://app.example")
    res = handler.handler({"routeKey": "GET /freee/callback", "queryStringParameters": {"error": "access_denied"}}, None)
    assert res["statusCode"] == 302 and res["headers"]["location"] == "https://app.example/settings/?freee=cancelled"
    monkeypatch.setattr(db, "shared_connection", lambda *a, **k: app_con)
    res = handler.handler({"routeKey": "GET /freee/callback", "queryStringParameters": {"code": "c", "state": "nope"}}, None)
    assert res["headers"]["location"].endswith("?freee=expired")


# ───────── 送る予定（トリガー） ─────────
def test_つなぐ前の記録は送らない(app_con):
    before = expense(app_con)
    connect(app_con)
    after = expense(app_con)
    rows = sync_rows(app_con)
    assert before["id"] not in rows and rows[after["id"]][:2] == ("upsert", "pending")


def test_下書きとCSVは送らない_確定したら送る(app_con):
    connect(app_con)
    draft = expense(app_con, status="draft")
    csv = expense(app_con, source="csv", amount=100)
    assert draft["id"] not in sync_rows(app_con) and csv["id"] not in sync_rows(app_con)
    with db.as_user(app_con, ALICE):
        ledger.confirm_entry(app_con, ALICE, draft["id"])
    assert sync_rows(app_con)[draft["id"]][1] == "pending"


def test_設定でCSVも送るようにできる(app_con):
    connect(app_con)
    with db.as_user(app_con, ALICE):
        freee_sync.set_sources(app_con, ALICE, ["manual", "csv"])
    csv = expense(app_con, source="csv")
    assert csv["id"] in sync_rows(app_con)


def test_freeeとつないでいない人は_何も送る予定にならない(app_con):
    connect(app_con, user=ALICE)
    expense(app_con, user=BOB)
    assert sync_rows(app_con, user=BOB) == {}


# ───────── 送る ─────────
def test_自分のお金で払った経費は_プライベート資金からの取引になる(app_con):
    connect(app_con)
    e = expense(app_con)
    fake = FakeFreee()
    assert freee_sync.sync_user(app_con, ALICE, fake) == {"sent": 1, "failed": 0, "skipped": 0}
    [(method, path, body)] = fake.calls
    assert (method, path) == ("POST", "/api/1/deals")
    assert body["type"] == "expense" and body["company_id"] == 12345
    assert body["details"] == [{"account_item_id": 101, "tax_code": 136, "amount": 3300, "description": "家電店・ケーブル"}]
    assert body["payments"][0]["from_walletable_type"] == "private_account_item"
    assert body["payments"][0]["from_walletable_id"] == 201
    assert sync_rows(app_con)[e["id"]][1:3] == ("sent", "deal")


def test_名前がちがう科目も対応表で送れる(app_con):
    connect(app_con)
    expense(app_con, code="5160")  # 接待交際費 → freee では「交際費」
    fake = FakeFreee()
    freee_sync.sync_user(app_con, ALICE, fake)
    assert fake.calls[0][2]["details"][0]["account_item_id"] == 104


def test_源泉徴収つきの報酬は振替伝票で送る(app_con):
    connect(app_con)
    with db.as_user(app_con, ALICE):
        ledger.create_entry(app_con, ALICE, {"entry_date": "2026-11-25", "partner": "A社", "status": "confirmed", "lines": [
            {"side": "debit", "account_code": "1900", "amount": 100_000},
            {"side": "credit", "account_code": "4100", "amount": 100_000}]})
    fake = FakeFreee()
    freee_sync.sync_user(app_con, ALICE, fake)
    method, path, body = fake.calls[0]
    assert path == "/api/1/manual_journals"
    assert {(d["entry_side"], d["account_item_id"], d["tax_code"]) for d in body["details"]} == {
        ("debit", 202, 2), ("credit", 301, 129)}


def test_freeeにない科目は送らずに理由を残す(app_con):
    connect(app_con)
    e = expense(app_con, credit="1200")  # 普通預金は freee にない
    assert freee_sync.sync_user(app_con, ALICE, FakeFreee())["skipped"] == 1
    with db.as_user(app_con, ALICE):
        assert "普通預金" in freee_sync.entry_sync(app_con, e["id"])["error"]
        assert freee_sync.status(app_con)["counts"]["skipped"] == 1


def test_直したら_freeeの前のものを消して作りなおす(app_con):
    connect(app_con)
    e = expense(app_con)
    fake = FakeFreee()
    freee_sync.sync_user(app_con, ALICE, fake)
    first_id = sync_rows(app_con)[e["id"]][3]
    with db.as_user(app_con, ALICE):
        ledger.update_entry(app_con, ALICE, e["id"], {"entry_date": "2026-11-20", "status": "confirmed", "lines": [
            {"side": "debit", "account_code": "5140", "amount": 5000},
            {"side": "credit", "account_code": "2900", "amount": 5000}]})
    freee_sync.sync_user(app_con, ALICE, fake)
    assert fake.calls[1] == ("DELETE", f"/api/1/deals/{first_id}", {"company_id": 12345})
    assert fake.calls[2][2]["details"][0]["account_item_id"] == 102


def test_消したら_freeeでも消す(app_con):
    connect(app_con)
    e = expense(app_con)
    fake = FakeFreee()
    freee_sync.sync_user(app_con, ALICE, fake)
    with db.as_user(app_con, ALICE):
        ledger.delete_entry(app_con, ALICE, e["id"])
    assert sync_rows(app_con)[e["id"]][:2] == ("delete", "pending")
    freee_sync.sync_user(app_con, ALICE, fake)
    assert fake.calls[-1][0] == "DELETE" and sync_rows(app_con) == {}


def test_送る前に消したものは_freeeには何もしない(app_con):
    connect(app_con)
    e = expense(app_con)
    with db.as_user(app_con, ALICE):
        ledger.delete_entry(app_con, ALICE, e["id"])
    assert sync_rows(app_con) == {}


def test_freeeが止まっていたら失敗として残し_次にやりなおす(app_con):
    connect(app_con)
    e = expense(app_con)
    fake = FakeFreee()
    fake.fail_post = True
    assert freee_sync.sync_user(app_con, ALICE, fake)["failed"] == 1
    assert sync_rows(app_con)[e["id"]][1] == "failed"
    fake.fail_post = False
    assert freee_sync.sync_user(app_con, ALICE, fake)["sent"] == 1


def test_freeeとのつながりが切れていたら_つなぎなおしてと伝える(app_con):
    connect(app_con)
    e = expense(app_con)
    fake = FakeFreee()
    fake.not_connected = True
    freee_sync.sync_user(app_con, ALICE, fake)
    with db.as_user(app_con, ALICE):
        assert "つなぎなおして" in freee_sync.entry_sync(app_con, e["id"])["error"]


def test_レシートの写真はファイルボックスに入れて取引にくっつける(app_con):
    from .test_receipts import IMAGE, ai_result

    connect(app_con)
    from shinkoku import receipts

    with db.as_user(app_con, ALICE):
        out = receipts.process_receipt(app_con, ALICE, IMAGE, "image/jpeg", via="line", store=lambda *a: None,
                                       reader=lambda *_: ai_result(), today=dt.date(2026, 11, 21))
    fake = FakeFreee()
    freee_sync.sync_user(app_con, ALICE, fake, read_receipt=lambda key: (IMAGE, "image/jpeg"))
    assert fake.calls[0][:2] == ("POST", "/api/1/receipts")
    assert fake.calls[1][2]["receipt_ids"] == [777]
    with db.as_user(app_con, ALICE):
        assert freee_sync.entry_sync(app_con, out.entry["id"])["status"] == "sent"


def test_毎月の固定費も送る(app_con):
    connect(app_con)
    with db.as_user(app_con, ALICE):
        recurring.create_rule(app_con, ALICE, {"name": "家賃", "account_code": "5050", "amount": 80000, "business_ratio": 30,
                                               "day_of_month": 1, "start_month": "2026-11"})
        recurring.run_for_user(app_con, ALICE, dt.date(2026, 11, 21))
    fake = FakeFreee()
    assert freee_sync.sync_user(app_con, ALICE, fake)["sent"] == 1
    assert fake.calls[0][2]["details"][0]["amount"] == 24000


def test_つなぐのをやめると_鍵を消してアプリ内モードにもどる(app_con):
    store = connect(app_con)
    with db.as_user(app_con, ALICE):
        freee_sync.disconnect(app_con, ALICE, store)
        assert freee_sync.status(app_con) == {"connected": False}
        assert ledger.get_profile(app_con, ALICE)["mode"] == "in_app"
    assert ALICE not in store.tokens


def test_他人のfreeeのつながりや送信記録は見えない(app_con):
    connect(app_con, user=ALICE)
    expense(app_con, user=ALICE)
    with db.as_user(app_con, BOB):
        assert freee_sync.status(app_con) == {"connected": False}
        assert app_con.run("select count(*) from freee_syncs")[0][0] == 0


def test_鍵が切れていたら更新して_新しい鍵をしまう(monkeypatch):
    store = FakeStore()
    store.put(ALICE, {"access_token": "old", "refresh_token": "r1", "expires_at": 0})
    monkeypatch.setattr(freee_api, "refresh", lambda t: {"access_token": "new", "refresh_token": "r2", "expires_at": 9e9})
    seen = []
    monkeypatch.setattr(freee_api, "http", lambda method, url, headers=None, body=None, timeout=15:
                        (seen.append(headers["authorization"]) or (200, b'{"ok": true}')))
    assert freee_api.Client(ALICE, store=store).get("/api/1/companies") == {"ok": True}
    assert seen == ["Bearer new"] and store.tokens[ALICE]["refresh_token"] == "r2"
