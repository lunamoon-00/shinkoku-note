"""freee につなぐ・freee に送る。

つなぐ：
  1. 画面で「freeeとつなぐ」→ 合言葉（state）を作って、freee の許可画面の URL を返す
  2. 許可すると freee が /freee/callback に戻してくる → 合言葉から利用者を引き、code を鍵にかえて金庫へ
送る：
  - 記録が確定・修正・削除されると、DB のしくみ（トリガー）が「送る予定」にする（0007_freee.sql）
  - ここでは「送る予定」を1件ずつ freee に送る
    - 自分のお金で払った経費（借方：経費1行／貸方：事業主借1行）→ freee の「取引」（プライベート資金から支払い）
    - それ以外（報酬・源泉徴収・仕事用の口座など）→ freee の「振替伝票」（借方・貸方そのまま）
    - レシートの写真があれば、freee のファイルボックスに入れて取引にくっつける
  - 修正したときは、freee 側を消して作りなおす（取引の支払い部分は直接直せないため）
"""

from __future__ import annotations

import secrets as pysecrets
import traceback

import pg8000.native

from . import freee_api, ledger

# このアプリの科目名 → freee の科目名（ちがうものだけ）
ALIASES = {
    "売上": "売上高",
    "給料賃金": "給料手当",
    "外注工賃": "外注費",
    "貸倒金": "貸倒損失",
    "利子割引料": "支払利息",
    "接待交際費": "交際費",
    "損害保険料": "保険料",
}
OWNER_CONTRIBUTION = "2900"  # 事業主借（自分のお金で払った）
MAX_ATTEMPTS = 10
SOURCES = ("receipt", "recurring", "manual", "csv")


# ───────── つなぐ ─────────
def start_connect(con: pg8000.native.Connection, user_id: str) -> str:
    state = pysecrets.token_urlsafe(32)
    con.run("delete from freee_oauth_states where user_id = :u", u=user_id)
    con.run(
        "insert into freee_oauth_states (state, user_id, expires_at) values (:s, :u, now() + interval '10 minutes')",
        s=state, u=user_id,
    )
    return freee_api.authorize_url(state)


def finish_connect(con: pg8000.native.Connection, state: str, code: str, store, exchange=None, companies=None) -> str:
    """freee から戻ってきたとき。成功したら利用者番号を返す（失敗は例外）"""
    con.run("begin")
    try:
        user_id = con.run("select freee_consume_state(:s)", s=state)[0][0]
        con.run("commit")
    except BaseException:
        con.run("rollback")
        raise
    if not user_id:
        raise ledger.ValidationError("つなぐ手続きの期限（10分）が切れました。もう一度「freeeとつなぐ」を押してね")

    token = (exchange or freee_api.exchange_code)(code)
    store.put(user_id, token)
    client = freee_api.Client(user_id, store=store)
    found = companies(client) if companies else client.get("/api/1/companies")["companies"]
    if not found:
        raise ledger.ValidationError("freee に事業所が見つかりませんでした")
    company = found[0]  # 許可画面で選んだ事業所だけが返ってくる

    from . import db

    with db.as_user(con, user_id):
        con.run(
            "insert into freee_connections (user_id, company_id, company_name) values (:u, :c, :n)"
            " on conflict (user_id) do update set company_id = excluded.company_id, company_name = excluded.company_name,"
            " connected_at = now()",
            u=user_id, c=int(company["id"]), n=str(company.get("display_name") or company.get("name") or "")[:100],
        )
        # 設定（プロフィール）がまだなくても freee モードにする
        con.run("insert into profiles (user_id, mode) values (:u, 'freee')"
                " on conflict (user_id) do update set mode = 'freee', updated_at = now()", u=user_id)
        ledger._audit(con, user_id, "freee.connect", str(company["id"]))
    return user_id


def status(con: pg8000.native.Connection) -> dict:
    rows = con.run("select company_id, company_name, connected_at, send_sources from freee_connections")
    if not rows:
        return {"connected": False}
    company_id, name, connected_at, sources = rows[0]
    counts = dict(con.run("select status, count(*) from freee_syncs group by status"))
    failed = con.run(
        "select s.entry_id, s.last_error, e.entry_date, e.partner from freee_syncs s"
        " left join journal_entries e on e.id = s.entry_id where s.status in ('failed', 'skipped')"
        " order by s.updated_at desc limit 5"
    )
    return {
        "connected": True,
        "company_id": company_id,
        "company_name": name,
        "connected_at": connected_at.isoformat(),
        "send_sources": list(sources),
        "counts": {k: counts.get(k, 0) for k in ("pending", "sent", "failed", "skipped")},
        "problems": [
            {"entry_id": str(eid), "error": err, "entry_date": d.isoformat() if d else None, "partner": p or ""}
            for eid, err, d, p in failed
        ],
    }


def set_sources(con: pg8000.native.Connection, user_id: str, sources) -> dict:
    if not isinstance(sources, list) or any(s not in SOURCES for s in sources):
        raise ledger.ValidationError("送るものの種類がおかしいです")
    if not con.run("select 1 from freee_connections"):
        raise ledger.NotFound()
    con.run("update freee_connections set send_sources = cast(:s as text[])", s=sorted(set(sources)))
    return status(con)


def disconnect(con: pg8000.native.Connection, user_id: str, store) -> None:
    con.run("delete from freee_connections")
    con.run("delete from freee_syncs where status <> 'sent'")
    con.run("update profiles set mode = 'in_app', updated_at = now() where user_id = :u", u=user_id)
    store.delete(user_id)
    ledger._audit(con, user_id, "freee.disconnect", user_id)


def entry_sync(con: pg8000.native.Connection, entry_id: str) -> dict | None:
    rows = con.run(
        "select status, last_error, freee_kind, freee_id from freee_syncs where entry_id = cast(:id as uuid)", id=entry_id
    )
    if not rows:
        return None
    s, err, kind, fid = rows[0]
    return {"status": s, "error": err, "kind": kind, "freee_id": fid}


def has_pending(con: pg8000.native.Connection) -> bool:
    return bool(con.run("select 1 from freee_syncs where status = 'pending' limit 1"))


# ───────── 送る ─────────
class AccountMap:
    """このアプリの科目 → freee の勘定科目（番号・税区分の初期値）"""

    def __init__(self, items: list[dict], our_accounts: list[dict]):
        by_name = {i["name"]: i for i in items}
        self.items = {}
        for a in our_accounts:
            item = by_name.get(ALIASES.get(a["name"], a["name"]))
            if item:
                self.items[a["code"]] = item
        self.names = {a["code"]: a["name"] for a in our_accounts}

    def item(self, code: str) -> dict:
        if code not in self.items:
            raise SkipEntry(f"freee に「{ALIASES.get(self.names.get(code, code), self.names.get(code, code))}」の科目がないので送れません")
        return self.items[code]


class SkipEntry(Exception):
    """この記録は freee に送れない（送らないことにする）"""


def build_payload(entry: dict, company_id: int, amap: AccountMap, receipt_id: int | None) -> tuple[str, dict]:
    """記録 → freee に送る形。戻り値は (種類, 中身)"""
    debits = [line for line in entry["lines"] if line["side"] == "debit"]
    credits = [line for line in entry["lines"] if line["side"] == "credit"]
    memo = "・".join(x for x in (entry["partner"], entry["description"]) if x)[:250]

    if (len(debits) == 1 and len(credits) == 1 and debits[0]["account_code"].startswith("5")
            and credits[0]["account_code"] == OWNER_CONTRIBUTION):
        item = amap.item(debits[0]["account_code"])
        owner = amap.item(OWNER_CONTRIBUTION)
        body = {
            "company_id": company_id,
            "issue_date": entry["entry_date"],
            "type": "expense",
            "details": [{"account_item_id": item["id"], "tax_code": item["default_tax_code"],
                         "amount": debits[0]["amount"], "description": memo}],
            # 自分のお金で払った ＝ freee の「プライベート資金」から支払い
            "payments": [{"date": entry["entry_date"], "from_walletable_type": "private_account_item",
                          "from_walletable_id": owner["id"], "amount": debits[0]["amount"]}],
        }
        if receipt_id:
            body["receipt_ids"] = [receipt_id]
        return "deal", body

    details = [
        {"entry_side": line["side"], "account_item_id": amap.item(line["account_code"])["id"],
         "tax_code": amap.item(line["account_code"])["default_tax_code"], "amount": line["amount"], "description": memo}
        for line in entry["lines"]
    ]
    body = {"company_id": company_id, "issue_date": entry["entry_date"], "details": details}
    if receipt_id:
        body["receipt_ids"] = [receipt_id]
    return "manual_journal", body


PATHS = {"deal": "/api/1/deals", "manual_journal": "/api/1/manual_journals"}
RESULT_KEYS = {"deal": "deal", "manual_journal": "manual_journal"}


def sync_user(con: pg8000.native.Connection, user_id: str, client, read_receipt=None) -> dict:
    """この人の「送る予定」を freee に送る。as_user の外で呼ぶ（1件ずつトランザクションを分ける）"""
    from . import db

    with db.as_user(con, user_id):
        conn = con.run("select company_id from freee_connections")
        if not conn:
            return {"sent": 0, "failed": 0, "skipped": 0}
        company_id = conn[0][0]
        todo = con.run(
            "select entry_id, op, freee_kind, freee_id, receipt_id from freee_syncs"
            " where status = 'pending' or (status = 'failed' and attempts < :m) order by updated_at",
            m=MAX_ATTEMPTS,
        )
    if not todo:
        return {"sent": 0, "failed": 0, "skipped": 0}

    try:
        items = client.get("/api/1/account_items", company_id=company_id)["account_items"]
    except freee_api.NotConnected:
        with db.as_user(con, user_id):
            con.run("update freee_syncs set status = 'failed', last_error = 'freee とのつながりが切れています。設定からつなぎなおしてね'"
                    " where status = 'pending'")
        return {"sent": 0, "failed": len(todo), "skipped": 0}

    result = {"sent": 0, "failed": 0, "skipped": 0}
    for entry_id, op, kind, freee_id, receipt_id in todo:
        entry_id = str(entry_id)
        try:
            with db.as_user(con, user_id):
                amap = AccountMap(items, ledger.list_accounts(con))
                # 前に送ったものがあれば、まず freee 側を消す（修正・削除どちらも）
                if freee_id and kind:
                    try:
                        client.delete(f"{PATHS[kind]}/{freee_id}", company_id=company_id)
                    except freee_api.FreeeError as e:
                        if e.status != 404:  # すでに freee で消されていたら気にしない
                            raise
                if op == "delete":
                    con.run("delete from freee_syncs where entry_id = cast(:id as uuid)", id=entry_id)
                    result["sent"] += 1
                    continue
                entry = ledger.get_entry(con, entry_id)
                if entry["has_receipt"] and not receipt_id and read_receipt:
                    key = ledger.receipt_key(con, entry_id)
                    if key:
                        content, mime = read_receipt(key)
                        r = client.request("POST", "/api/1/receipts", multipart=(
                            {"company_id": company_id, "description": entry["partner"][:100], "issue_date": entry["entry_date"]},
                            (key.rsplit("/", 1)[-1], content, mime),
                        ))
                        receipt_id = r["receipt"]["id"]
                new_kind, body = build_payload(entry, company_id, amap, receipt_id)
                created = client.post(PATHS[new_kind], body)
                con.run(
                    "update freee_syncs set status = 'sent', freee_kind = :k, freee_id = :f, receipt_id = :r,"
                    " last_error = '', updated_at = now() where entry_id = cast(:id as uuid)",
                    k=new_kind, f=int(created[RESULT_KEYS[new_kind]]["id"]), r=receipt_id, id=entry_id,
                )
                result["sent"] += 1
        except (SkipEntry, ledger.NotFound) as e:
            with db.as_user(con, user_id):
                con.run("update freee_syncs set status = 'skipped', last_error = :e, updated_at = now()"
                        " where entry_id = cast(:id as uuid)", e=str(e) or "記録が見つかりません", id=entry_id)
            result["skipped"] += 1
        except Exception as e:
            traceback.print_exc()
            with db.as_user(con, user_id):
                # freee_id は消さずに残す（次にやりなおすとき、前のものを消してから作る。もう消えていれば 404 で気にしない）
                con.run("update freee_syncs set status = 'failed', attempts = attempts + 1, last_error = :e,"
                        " updated_at = now() where entry_id = cast(:id as uuid)",
                        e=str(e)[:300], id=entry_id)
            result["failed"] += 1
    return result
