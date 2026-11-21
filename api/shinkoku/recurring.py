"""くり返し設定：毎月おなじお金（家賃・スマホ代・サブスクなど）を、自動で記録する。

- 仕事で使う割合（家事按分）をかけた金額だけを経費にする
- 「いつから」を過去の月にすると、その月からの分をまとめて記録する（今年の申告に間に合わせるため）
- どの設定の何月分を記録したかを覚えるので、何回動かしても二重にならない
"""

from __future__ import annotations

import calendar
import datetime as dt
import uuid

import pg8000.native

from . import ledger

PAID_FROM = {"personal": "2900", "business": "1200"}
JST = dt.timezone(dt.timedelta(hours=9))


def today_jst(now: dt.datetime | None = None) -> dt.date:
    return (now or dt.datetime.now(dt.timezone.utc)).astimezone(JST).date()


def business_amount(amount: int, ratio: int) -> int:
    """家事按分：80,000円 × 30% → 24,000円（1円未満は四捨五入。少なくとも1円）"""
    return max(1, (amount * ratio + 50) // 100)


def due_date(month: dt.date, day: int) -> dt.date:
    """その月の記録日（31日にしていたら、短い月は月末）"""
    last = calendar.monthrange(month.year, month.month)[1]
    return month.replace(day=min(day, last))


def _add_month(d: dt.date) -> dt.date:
    return dt.date(d.year + (d.month == 12), d.month % 12 + 1, 1)


def due_months(start: dt.date, end: dt.date | None, day: int, today: dt.date) -> list[dt.date]:
    """記録日がもう来ている月の一覧（いつから〜今月、いつまで があればそこまで）"""
    months, m = [], start
    while m <= today.replace(day=1) and (end is None or m <= end):
        if due_date(m, day) <= today:
            months.append(m)
        m = _add_month(m)
    return months


# ───────── 設定の読み書き ─────────
FIELDS = ("id", "name", "account_code", "amount", "business_ratio", "day_of_month", "paid_from", "start_month", "end_month", "active")


def _row(r) -> dict:
    d = dict(zip(FIELDS, r))
    d["id"] = str(d["id"])
    d["start_month"] = d["start_month"].isoformat()[:7]
    d["end_month"] = d["end_month"].isoformat()[:7] if d["end_month"] else None
    d["monthly_expense"] = business_amount(d["amount"], d["business_ratio"])
    return d


def list_rules(con: pg8000.native.Connection) -> list[dict]:
    rows = con.run(f"select {', '.join(FIELDS)} from recurring_rules order by active desc, created_at")
    return [_row(r) for r in rows]


def _month(text, field: str, errors: list) -> dt.date | None:
    try:
        y, m = str(text).split("-")
        return dt.date(int(y), int(m), 1)
    except ValueError:
        errors.append({"field": field, "message": "月は 2026-01 の形で選んでください"})
        return None


def create_rule(con: pg8000.native.Connection, user_id: str, payload: dict) -> dict:
    if not isinstance(payload, dict):
        raise ledger.ValidationError("送られてきた形がおかしいです")
    errors: list[dict] = []
    name = str(payload.get("name", "")).strip()
    if not 1 <= len(name) <= 50:
        errors.append({"field": "name", "message": "名前を50文字までで入れてください"})
    expense = {a["code"] for a in ledger.list_accounts(con) if a["kind"] == "expense"}
    if payload.get("account_code") not in expense:
        errors.append({"field": "account_code", "message": "何のお金かを選んでください"})
    amount = payload.get("amount")
    if not isinstance(amount, int) or isinstance(amount, bool) or not 1 <= amount <= 10_000_000:
        errors.append({"field": "amount", "message": "毎月の金額を1円以上で入れてください"})
    ratio = payload.get("business_ratio", 100)
    if not isinstance(ratio, int) or isinstance(ratio, bool) or not 1 <= ratio <= 100:
        errors.append({"field": "business_ratio", "message": "仕事で使う割合は1〜100%で入れてください"})
    day = payload.get("day_of_month")
    if not isinstance(day, int) or isinstance(day, bool) or not 1 <= day <= 31:
        errors.append({"field": "day_of_month", "message": "毎月何日かを1〜31で選んでください"})
    paid_from = payload.get("paid_from", "personal")
    if paid_from not in PAID_FROM:
        errors.append({"field": "paid_from", "message": "どのお金で払うかを選んでください"})
    start = _month(payload.get("start_month"), "start_month", errors)
    end = _month(payload["end_month"], "end_month", errors) if payload.get("end_month") else None
    if start and end and end < start:
        errors.append({"field": "end_month", "message": "「いつまで」が「いつから」より前になっています"})
    if start and start.year < today_jst().year - 1:
        errors.append({"field": "start_month", "message": "「いつから」は去年の1月以降にしてください"})
    if errors:
        raise ledger.ValidationError("入力を確かめてください", errors)
    rule_id = con.run(
        "insert into recurring_rules (user_id, name, account_code, amount, business_ratio, day_of_month, paid_from, start_month, end_month)"
        " values (:u, :n, :a, :amt, :r, :d, :p, :s, :e) returning id",
        u=user_id, n=name, a=payload["account_code"], amt=amount, r=ratio, d=day, p=paid_from, s=start, e=end,
    )[0][0]
    ledger._audit(con, user_id, "recurring.create", str(rule_id))
    return get_rule(con, str(rule_id))


def get_rule(con: pg8000.native.Connection, rule_id: str) -> dict:
    try:
        rule_id = str(uuid.UUID(str(rule_id)))
    except ValueError:
        raise ledger.NotFound() from None
    rows = con.run(f"select {', '.join(FIELDS)} from recurring_rules where id = cast(:id as uuid)", id=rule_id)
    if not rows:
        raise ledger.NotFound()
    return _row(rows[0])


def set_active(con: pg8000.native.Connection, user_id: str, rule_id: str, active: bool) -> dict:
    get_rule(con, rule_id)
    con.run("update recurring_rules set active = :a where id = cast(:id as uuid)", a=bool(active), id=rule_id)
    ledger._audit(con, user_id, "recurring.active" if active else "recurring.pause", rule_id)
    return get_rule(con, rule_id)


def delete_rule(con: pg8000.native.Connection, user_id: str, rule_id: str) -> None:
    """設定を消す。もう記録した分は、帳簿に残す"""
    get_rule(con, rule_id)
    con.run("delete from recurring_rules where id = cast(:id as uuid)", id=rule_id)
    ledger._audit(con, user_id, "recurring.delete", rule_id)


# ───────── 記録する ─────────
def run_for_user(con: pg8000.native.Connection, user_id: str, today: dt.date) -> int:
    """記録日が来ているのに、まだ記録していない月を記録する。記録した件数を返す"""
    created = 0
    for rule in list_rules(con):
        if not rule["active"]:
            continue
        start = dt.date.fromisoformat(rule["start_month"] + "-01")
        end = dt.date.fromisoformat(rule["end_month"] + "-01") if rule["end_month"] else None
        done = {m for (m,) in con.run("select month from recurring_runs where rule_id = cast(:id as uuid)", id=rule["id"])}
        for month in due_months(start, end, rule["day_of_month"], today):
            if month in done:
                continue
            amount = rule["monthly_expense"]
            entry = ledger.create_entry(con, user_id, {
                "entry_date": due_date(month, rule["day_of_month"]).isoformat(),
                "description": f"{rule['name']}（{month.month}月分"
                               + (f"・仕事の割合{rule['business_ratio']}%" if rule["business_ratio"] < 100 else "") + "）",
                "partner": rule["name"],
                "status": "confirmed",
                "source": "recurring",
                "lines": [
                    {"side": "debit", "account_code": rule["account_code"], "amount": amount},
                    {"side": "credit", "account_code": PAID_FROM[rule["paid_from"]], "amount": amount},
                ],
            })
            con.run(
                "insert into recurring_runs (rule_id, user_id, month, entry_id) values (cast(:r as uuid), :u, :m, cast(:e as uuid))",
                r=rule["id"], u=user_id, m=month, e=entry["id"],
            )
            created += 1
    return created
