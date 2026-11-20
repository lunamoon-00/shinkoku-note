"""帳簿の中身（仕訳の登録・一覧・確定・削除、科目ごとの合計、利用者の設定）。

ここの関数はすべて「as_user で、ログイン中の人として開いたトランザクション」の中で呼ぶ。
DBのRLSで他人の行は見えないので、他人の仕訳を指定しても「見つからない」になる。
"""

from __future__ import annotations

import datetime as dt
import uuid
from dataclasses import dataclass, field

import pg8000.native

MAX_AMOUNT = 10_000_000_000  # 100億円。打ちまちがい防止の上限
STATUSES = ("draft", "confirmed")
SOURCES = ("manual", "csv", "receipt", "recurring")
SIDES = ("debit", "credit")


# ───────── エラー（画面にそのまま出せる、やさしい日本語で） ─────────
@dataclass
class ValidationError(Exception):
    message: str
    details: list[dict] = field(default_factory=list)


class NotFound(Exception):
    pass


def _err(field_name: str, message: str) -> dict:
    return {"field": field_name, "message": message}


# ───────── 入力チェック ─────────
def validate_entry(payload: dict, account_codes: set[str]) -> dict:
    """仕訳の入力を確かめて、きれいにした形で返す。おかしければ ValidationError。"""
    if not isinstance(payload, dict):
        raise ValidationError("送られてきた形がおかしいです")
    errors: list[dict] = []

    entry_date = None
    raw_date = payload.get("entry_date")
    try:
        entry_date = dt.date.fromisoformat(str(raw_date))
    except ValueError:
        errors.append(_err("entry_date", "日付は 2026-01-31 の形で入れてください"))

    description = str(payload.get("description", "")).strip()
    partner = str(payload.get("partner", "")).strip()
    if len(description) > 200:
        errors.append(_err("description", "メモは200文字までです"))
    if len(partner) > 100:
        errors.append(_err("partner", "取引先・お店の名前は100文字までです"))

    status = payload.get("status", "draft")
    if status not in STATUSES:
        errors.append(_err("status", "状態は draft（下書き）か confirmed（確定）です"))
    source = payload.get("source", "manual")
    if source not in SOURCES:
        errors.append(_err("source", "入れ方の種類がおかしいです"))

    lines = payload.get("lines")
    clean_lines: list[dict] = []
    if not isinstance(lines, list) or len(lines) < 2:
        errors.append(_err("lines", "借方と貸方の行が、少なくとも1行ずつ必要です"))
        lines = lines if isinstance(lines, list) else []
    for i, line in enumerate(lines):
        if not isinstance(line, dict):
            errors.append(_err(f"lines[{i}]", "行の形がおかしいです"))
            continue
        side = line.get("side")
        code = str(line.get("account_code", ""))
        amount = line.get("amount")
        if side not in SIDES:
            errors.append(_err(f"lines[{i}].side", "借方（debit）か貸方（credit）を選んでください"))
        if code not in account_codes:
            errors.append(_err(f"lines[{i}].account_code", "その科目は見つかりません"))
        # 金額は円の整数だけ（1.5 や "100" は受け付けない。True/False も数として扱わない）
        if not isinstance(amount, int) or isinstance(amount, bool) or amount <= 0:
            errors.append(_err(f"lines[{i}].amount", "金額は1円以上の整数で入れてください"))
        elif amount > MAX_AMOUNT:
            errors.append(_err(f"lines[{i}].amount", "金額が大きすぎます。打ちまちがいがないか確かめてください"))
        clean_lines.append({"side": side, "account_code": code, "amount": amount})

    if not errors:
        debit = sum(line["amount"] for line in clean_lines if line["side"] == "debit")
        credit = sum(line["amount"] for line in clean_lines if line["side"] == "credit")
        if debit == 0 or credit == 0:
            errors.append(_err("lines", "借方と貸方の行が、少なくとも1行ずつ必要です"))
        elif debit != credit:
            errors.append(_err("lines", f"借方の合計 {debit:,} 円と貸方の合計 {credit:,} 円が合っていません"))

    if errors:
        raise ValidationError("入力を確かめてください", errors)
    return {
        "entry_date": entry_date,
        "description": description,
        "partner": partner,
        "status": status,
        "source": source,
        "lines": clean_lines,
    }


# ───────── 勘定科目 ─────────
def list_accounts(con: pg8000.native.Connection) -> list[dict]:
    rows = con.run(
        "select code, name, friendly_name, description, kind, normal_side, white_line"
        " from accounts order by sort_order"
    )
    keys = ["code", "name", "friendly_name", "description", "kind", "normal_side", "white_line"]
    return [dict(zip(keys, r)) for r in rows]


def account_codes(con: pg8000.native.Connection) -> set[str]:
    return {r[0] for r in con.run("select code from accounts")}


# ───────── 仕訳 ─────────
def _audit(con: pg8000.native.Connection, user_id: str, action: str, target: str) -> None:
    con.run("insert into audit_logs (user_id, action, target) values (:u, :a, :t)", u=user_id, a=action, t=target)


def _insert_lines(con: pg8000.native.Connection, user_id: str, entry_id: str, lines: list[dict]) -> None:
    for line in lines:
        con.run(
            "insert into journal_lines (entry_id, user_id, side, account_code, amount)"
            " values (:e, :u, :s, :c, :a)",
            e=entry_id, u=user_id, s=line["side"], c=line["account_code"], a=line["amount"],
        )


def create_entry(con: pg8000.native.Connection, user_id: str, payload: dict) -> dict:
    data = validate_entry(payload, account_codes(con))
    entry_id = str(uuid.uuid4())
    con.run(
        "insert into journal_entries (id, user_id, entry_date, description, partner, status, source)"
        " values (cast(:id as uuid), :u, :d, :desc, :p, :st, :src)",
        id=entry_id, u=user_id, d=data["entry_date"], desc=data["description"],
        p=data["partner"], st=data["status"], src=data["source"],
    )
    _insert_lines(con, user_id, entry_id, data["lines"])
    _audit(con, user_id, "entry.create", entry_id)
    return get_entry(con, entry_id)


def update_entry(con: pg8000.native.Connection, user_id: str, entry_id: str, payload: dict) -> dict:
    get_entry(con, entry_id)  # 自分の仕訳でなければ NotFound
    data = validate_entry(payload, account_codes(con))
    con.run(
        "update journal_entries set entry_date = :d, description = :desc, partner = :p,"
        " status = :st, updated_at = now() where id = cast(:id as uuid)",
        id=entry_id, d=data["entry_date"], desc=data["description"], p=data["partner"], st=data["status"],
    )
    con.run("delete from journal_lines where entry_id = cast(:id as uuid)", id=entry_id)
    _insert_lines(con, user_id, entry_id, data["lines"])
    _audit(con, user_id, "entry.update", entry_id)
    return get_entry(con, entry_id)


def confirm_entry(con: pg8000.native.Connection, user_id: str, entry_id: str) -> dict:
    get_entry(con, entry_id)
    con.run(
        "update journal_entries set status = 'confirmed', updated_at = now() where id = cast(:id as uuid)",
        id=entry_id,
    )
    _audit(con, user_id, "entry.confirm", entry_id)
    return get_entry(con, entry_id)


def delete_entry(con: pg8000.native.Connection, user_id: str, entry_id: str) -> None:
    get_entry(con, entry_id)
    con.run("delete from journal_entries where id = cast(:id as uuid)", id=entry_id)
    _audit(con, user_id, "entry.delete", entry_id)


def _check_uuid(entry_id: str) -> str:
    try:
        return str(uuid.UUID(str(entry_id)))
    except ValueError:
        raise NotFound() from None


def get_entry(con: pg8000.native.Connection, entry_id: str) -> dict:
    entry_id = _check_uuid(entry_id)
    rows = con.run(
        "select id, entry_date, description, partner, status, source, created_at, updated_at"
        " from journal_entries where id = cast(:id as uuid)",
        id=entry_id,
    )
    if not rows:
        raise NotFound()
    entries = _with_lines(con, rows)
    return entries[0]


def list_entries(con: pg8000.native.Connection, year: int, status: str | None = None) -> list[dict]:
    if status is not None and status not in STATUSES:
        raise ValidationError("状態は draft（下書き）か confirmed（確定）です")
    rows = con.run(
        "select id, entry_date, description, partner, status, source, created_at, updated_at"
        " from journal_entries"
        " where entry_date >= make_date(:y, 1, 1) and entry_date < make_date(:y + 1, 1, 1)"
        "   and (cast(:st as text) is null or status = cast(:st as text))"
        " order by entry_date, created_at",
        y=year, st=status,
    )
    return _with_lines(con, rows)


def _with_lines(con: pg8000.native.Connection, rows: list) -> list[dict]:
    if not rows:
        return []
    ids = [str(r[0]) for r in rows]
    line_rows = con.run(
        "select l.entry_id, l.side, l.account_code, a.name, a.friendly_name, l.amount"
        " from journal_lines l join accounts a on a.code = l.account_code"
        " where l.entry_id = any(cast(:ids as uuid[])) order by l.entry_id, l.side desc, l.id",
        ids=ids,
    )
    lines_by_entry: dict[str, list[dict]] = {i: [] for i in ids}
    for entry_id, side, code, name, friendly, amount in line_rows:
        lines_by_entry[str(entry_id)].append(
            {"side": side, "account_code": code, "account_name": name, "friendly_name": friendly, "amount": amount}
        )
    out = []
    for r in rows:
        eid = str(r[0])
        out.append(
            {
                "id": eid,
                "entry_date": r[1].isoformat(),
                "description": r[2],
                "partner": r[3],
                "status": r[4],
                "source": r[5],
                "created_at": r[6].isoformat(),
                "updated_at": r[7].isoformat(),
                "lines": lines_by_entry[eid],
                "total": sum(line["amount"] for line in lines_by_entry[eid] if line["side"] == "debit"),
            }
        )
    return out


# ───────── 集計 ─────────
def summary(con: pg8000.native.Connection, year: int) -> dict:
    """科目ごとの合計（確定した仕訳だけ）と、売上・経費・差し引き（所得の目安）。"""
    rows = con.run(
        "select a.code, a.name, a.friendly_name, a.kind, a.white_line,"
        "       coalesce(t.debit_total, 0), coalesce(t.credit_total, 0), a.normal_side"
        " from account_totals t join accounts a on a.code = t.account_code"
        " where t.year = :y order by a.sort_order",
        y=year,
    )
    accounts = []
    revenue = expense = 0
    for code, name, friendly, kind, white_line, debit, credit, normal in rows:
        balance = (debit - credit) if normal == "debit" else (credit - debit)
        accounts.append(
            {"code": code, "name": name, "friendly_name": friendly, "kind": kind,
             "white_line": white_line, "balance": balance}
        )
        if kind == "revenue":
            revenue += balance
        elif kind == "expense":
            expense += balance
    return {"year": year, "revenue": revenue, "expense": expense, "income": revenue - expense, "accounts": accounts}


# ───────── 利用者の設定 ─────────
PROFILE_FIELDS = ("display_name", "filing_type", "mode", "business_name")


def get_profile(con: pg8000.native.Connection, user_id: str) -> dict:
    con.run("insert into profiles (user_id) values (:u) on conflict (user_id) do nothing", u=user_id)
    r = con.run(
        "select display_name, filing_type, mode, business_name, onboarded_at is not null"
        " from profiles where user_id = :u",
        u=user_id,
    )[0]
    return {**dict(zip(PROFILE_FIELDS, r[:4])), "onboarded": r[4]}


def update_profile(con: pg8000.native.Connection, user_id: str, payload: dict) -> dict:
    if not isinstance(payload, dict):
        raise ValidationError("送られてきた形がおかしいです")
    current = get_profile(con, user_id)
    errors = []
    new = {k: payload.get(k, current[k]) for k in PROFILE_FIELDS}
    if new["filing_type"] not in ("white", "blue"):
        errors.append(_err("filing_type", "白色（white）か青色（blue）を選んでください"))
    if new["mode"] not in ("freee", "in_app"):
        errors.append(_err("mode", "freee連携（freee）かアプリ内（in_app）を選んでください"))
    for k in ("display_name", "business_name"):
        if not isinstance(new[k], str) or len(new[k]) > 50:
            errors.append(_err(k, "50文字までで入れてください"))
    onboarded = payload.get("onboarded")
    if onboarded is not None and not isinstance(onboarded, bool):
        errors.append(_err("onboarded", "はい（true）かいいえ（false）で入れてください"))
    if errors:
        raise ValidationError("入力を確かめてください", errors)
    con.run(
        "update profiles set display_name = :dn, filing_type = :ft, mode = :m, business_name = :bn,"
        " onboarded_at = case when cast(:ob as boolean) is true then coalesce(onboarded_at, now())"
        "                     when cast(:ob as boolean) is false then null else onboarded_at end,"
        " updated_at = now() where user_id = :u",
        dn=new["display_name"].strip(), ft=new["filing_type"], m=new["mode"], bn=new["business_name"].strip(),
        ob=onboarded, u=user_id,
    )
    _audit(con, user_id, "profile.update", user_id)
    return get_profile(con, user_id)
