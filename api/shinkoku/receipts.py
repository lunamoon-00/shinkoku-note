"""レシートの写真 → 仕訳。読み取りの結果から、自動で確定するか・確認待ちにするかを決める。

ここの関数は「as_user で、その人として開いたトランザクション」の中で呼ぶ。
写真の保存（S3）と読み取り（Gemini）は引数で受け取るので、テストでは差しかえられる。
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import re
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass

import pg8000.native

from . import ledger

PAID_FROM_PERSONAL = "2900"  # 事業主借：自分のお財布・個人の口座・カードで払った（いちばん多い）
CONFIDENT = 0.8  # AI の自信がこれ以上なら、初めてのお店でも自動で確定する
UNSURE_ACCOUNTS = {"5900"}  # 「雑費」を選んだときは迷っている合図なので、確認してもらう

Store = Callable[[str, bytes, str], None]  # (保存先のキー, 中身, 種類) → S3 に保存
Reader = Callable[[bytes, str, list[dict]], dict]  # (写真, 種類, 科目の一覧) → 読み取り結果


@dataclass
class Outcome:
    status: str  # auto_confirmed / needs_review / duplicate / not_receipt
    message: str  # LINE で返す文
    entry: dict | None = None
    entry_user: str = ""  # だれの記録か（freee に送る係を起こすため）


def partner_key(name: str) -> str:
    """お店の名前をそろえる（全角・半角・大文字小文字・空白のちがいを無視）"""
    s = unicodedata.normalize("NFKC", name).lower()
    return re.sub(r"[\s・\-ー_.,、。()（）「」]+", "", s)


def image_hash(image: bytes) -> str:
    return hashlib.sha256(image).hexdigest()


def _parse_date(text: str, today: dt.date) -> dt.date | None:
    try:
        d = dt.date.fromisoformat(text)
    except ValueError:
        return None
    # 未来の日付や、2年以上前は読みまちがいの可能性が高い
    if d > today or d < today.replace(year=today.year - 2):
        return None
    return d


def decide(ai: dict, rule_account: str | None, today: dt.date) -> tuple[str, list[str]]:
    """自動で確定するか決める。戻り値は (使う科目, 確認してほしい理由の一覧)。理由がなければ自動で確定。"""
    reasons: list[str] = []
    if _parse_date(str(ai.get("date", "")), today) is None:
        reasons.append("日付が読めなかったので、今日の日付にしています")
    if not str(ai.get("store", "")).strip():
        reasons.append("お店の名前が読めませんでした")
    if str(ai.get("unclear", "")).strip():
        reasons.append(f"読みにくいところがありました（{str(ai['unclear']).strip()[:40]}）")

    if rule_account:
        account = rule_account  # 前に自分で選んだ科目を優先
    else:
        account = str(ai.get("account_code", ""))
        confidence = float(ai.get("confidence") or 0)
        if account in UNSURE_ACCOUNTS or confidence < CONFIDENT:
            reasons.append("初めてのお店なので、何に使ったか（科目）を確かめてください")
    return account, reasons


def _expense_accounts(con: pg8000.native.Connection) -> list[dict]:
    return [a for a in ledger.list_accounts(con) if a["kind"] == "expense"]


def process_receipt(
    con: pg8000.native.Connection,
    user_id: str,
    image: bytes,
    mime_type: str,
    *,
    via: str,
    store: Store,
    reader: Reader,
    today: dt.date | None = None,
) -> Outcome:
    today = today or dt.date.today()
    digest = image_hash(image)

    # 同じ写真をもう送っていないか
    dup = con.run(
        "select f.status, e.entry_date from import_files f"
        " left join journal_entries e on e.import_file_id = f.id"
        " where f.image_hash = :h",
        h=digest,
    )
    if dup:
        when = f"（{dup[0][1].month}/{dup[0][1].day}の分）" if dup[0][1] else ""
        return Outcome("duplicate", f"🔁 この写真はもう受け取っています{when}。二重には記録しません")

    import_id = con.run(
        "insert into import_files (user_id, kind, via, s3_key, image_hash)"
        " values (:u, 'receipt', :via, '', :h) returning id",
        u=user_id, via=via, h=digest,
    )[0][0]
    ext = {"image/png": "png", "image/webp": "webp"}.get(mime_type, "jpg")
    key = f"receipts/{user_id}/{today.year}/{import_id}.{ext}"
    store(key, image, mime_type)

    accounts = _expense_accounts(con)
    ai = reader(image, mime_type, accounts)

    def finish(status: str, reason: str = "") -> None:
        con.run(
            "update import_files set s3_key = :k, status = :s, review_reason = :r, ai_result = cast(:ai as jsonb),"
            " updated_at = now() where id = :id",
            k=key, s=status, r=reason, ai=json.dumps(ai, ensure_ascii=False), id=import_id,
        )

    if not ai.get("is_receipt"):
        finish("not_receipt")
        return Outcome("not_receipt", "🤔 レシートや領収書が見つかりませんでした。レシート全体が写るように撮ってみてね")

    total = ai.get("total")
    if not isinstance(total, int) or total <= 0:
        finish("needs_review", "金額が読めませんでした")
        return Outcome(
            "needs_review",
            "💦 金額が読めませんでした。明るいところで撮りなおすか、アプリの「記録する」から入れてね",
        )

    store_name = str(ai.get("store", "")).strip()[:100]
    rule = con.run("select account_code from partner_rules where partner_key = :k", k=partner_key(store_name)) if store_name else []
    account, reasons = decide(ai, rule[0][0] if rule else None, today)
    if account not in {a["code"] for a in accounts}:
        account, reasons = "5900", [*reasons, "科目を選べませんでした"]
    entry_date = _parse_date(str(ai.get("date", "")), today) or today
    status = "needs_review" if reasons else "auto_confirmed"

    entry = ledger.create_entry(con, user_id, {
        "entry_date": entry_date.isoformat(),
        "description": str(ai.get("items", "")).strip()[:200],
        "partner": store_name,
        "status": "draft" if reasons else "confirmed",
        "source": "receipt",
        "lines": [
            {"side": "debit", "account_code": account, "amount": total},
            {"side": "credit", "account_code": PAID_FROM_PERSONAL, "amount": total},
        ],
    })
    con.run("update journal_entries set import_file_id = :f where id = cast(:e as uuid)", f=import_id, e=entry["id"])
    finish(status, "・".join(reasons))

    acc = next(a for a in accounts if a["code"] == account)
    head = f"{entry_date.month}/{entry_date.day} {store_name or 'お店不明'}\n{acc['friendly_name']}（{acc['name']}） {total:,}円"
    if reasons:
        msg = "📝 下書きにしたよ。アプリの「確認待ち」から確かめてね\n" + head + "\n" + "\n".join(f"・{r}" for r in reasons)
    else:
        msg = "📒 記録したよ\n" + head + "\nちがっていたら、アプリで直してね"
    return Outcome(status, msg, ledger.get_entry(con, entry["id"]))


def learn_partner(con: pg8000.native.Connection, user_id: str, entry: dict) -> None:
    """レシートから入った記録を本人が確定・修正したら、「このお店はこの科目」を覚える"""
    if entry.get("source") != "receipt" or not entry.get("partner"):
        return
    expense = next((line for line in entry["lines"] if line["side"] == "debit" and line["account_code"].startswith("5")), None)
    if not expense:
        return
    con.run(
        "insert into partner_rules (user_id, partner_key, account_code) values (:u, :k, :c)"
        " on conflict (user_id, partner_key) do update set account_code = excluded.account_code, updated_at = now()",
        u=user_id, k=partner_key(entry["partner"]), c=expense["account_code"],
    )
