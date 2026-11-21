"""消費税（インボイス登録した人だけ）。

計算のながれ（国税庁 No.6351・No.6505・2割特例、国税通則法の端数のきまり）
  1. 課税売上（税込）：インボイスの登録日より後の、確定した売上（10%として計算）
  2. 課税標準額 ＝ 税込 × 100/110（1,000円未満切り捨て）
  3. 消費税額（国）＝ 課税標準額 × 7.8%（1円未満切り捨て）
  4. 控除する税額：2割特例 → 消費税額 × 80%／簡易課税 → 消費税額 × みなし仕入率
  5. 納める消費税（国）＝ 3 − 4（100円未満切り捨て）
  6. 地方消費税 ＝ 5 × 22/78（100円未満切り捨て）
本則課税（仕入れの消費税を1件ずつ引く）は、このアプリではまだ計算しない。
"""

from __future__ import annotations

import datetime as dt
import re

import pg8000.native

from . import ledger

METHODS = ("two_tenths", "simplified", "standard")
CATEGORY_LABELS = {
    1: "第1種（卸売業）", 2: "第2種（小売業など）", 3: "第3種（製造業・建設業など）",
    4: "第4種（飲食店業・そのほか）", 5: "第5種（サービス業・運輸通信業・金融保険業）", 6: "第6種（不動産業）",
}


def calculate(rule: dict, settings: dict, taxable_sales: int) -> dict:
    """taxable_sales：登録日より後の、税込の課税売上（10%）"""
    base = taxable_sales * 100 // 110 // 1000 * 1000
    national = base * int(rule["national_rate_permille"]) // 1000
    method = settings["method"]
    notes: list[str] = []
    if method == "two_tenths":
        deduction = national * (100 - int(rule["special_payable_percent"])) // 100
    elif method == "simplified":
        rate = int(rule["deemed_rates"][str(settings["business_category"])])
        deduction = national * rate // 100
    else:
        deduction = 0
        notes.append("本則課税（仕入れの消費税を1件ずつ引く計算）は、このアプリではまだ計算できません。2割特例か簡易課税を選ぶか、税理士に相談してね")
    payable_national = max(0, national - deduction) // 100 * 100
    num, den = rule["local_ratio"]
    payable_local = payable_national * int(num) // int(den) // 100 * 100
    if method == "standard":
        payable_national = payable_local = 0
    notes.append("売上はすべて10%の課税売上として計算しています（8%の売上や、消費税がかからない売上があるときは、税務署に確認してね）")
    return {
        "method": method,
        "taxable_sales": taxable_sales,
        "tax_base": base,
        "national_tax": national,
        "deduction": deduction,
        "payable_national": payable_national,
        "payable_local": payable_local,
        "payable_total": payable_national + payable_local,
        "notes": notes,
    }


# ───────── 設定 ─────────
def get_settings(con: pg8000.native.Connection) -> dict:
    rows = con.run("select registered, registration_number, registered_on, method, business_category from invoice_settings")
    if not rows:
        return {"registered": False, "registration_number": None, "registered_on": None, "method": "two_tenths", "business_category": None}
    r, num, on, m, cat = rows[0]
    return {"registered": r, "registration_number": num, "registered_on": on.isoformat() if on else None,
            "method": m, "business_category": cat}


def save_settings(con: pg8000.native.Connection, user_id: str, payload: dict) -> dict:
    if not isinstance(payload, dict):
        raise ledger.ValidationError("送られてきた形がおかしいです")
    errors = []
    registered = bool(payload.get("registered"))
    number = payload.get("registration_number") or None
    on = None
    method = payload.get("method", "two_tenths")
    category = payload.get("business_category")
    if registered:
        if number is not None:
            number = re.sub(r"[\s-]", "", str(number)).upper()
            if not re.fullmatch(r"T\d{13}", number):
                errors.append({"field": "registration_number", "message": "登録番号は「T」と13けたの数字です"})
        try:
            on = dt.date.fromisoformat(str(payload.get("registered_on")))
        except ValueError:
            errors.append({"field": "registered_on", "message": "登録日を入れてください（登録通知書に書いてあります）"})
        if method not in METHODS:
            errors.append({"field": "method", "message": "計算のしかたを選んでください"})
        if method == "simplified" and category not in CATEGORY_LABELS:
            errors.append({"field": "business_category", "message": "簡易課税の事業区分を選んでください"})
    if errors:
        raise ledger.ValidationError("入力を確かめてください", errors)
    con.run(
        "insert into invoice_settings (user_id, registered, registration_number, registered_on, method, business_category)"
        " values (:u, :r, :n, :o, :m, :c) on conflict (user_id) do update set registered = excluded.registered,"
        " registration_number = excluded.registration_number, registered_on = excluded.registered_on,"
        " method = excluded.method, business_category = excluded.business_category, updated_at = now()",
        u=user_id, r=registered, n=number if registered else None, o=on, m=method if method in METHODS else "two_tenths",
        c=category if method == "simplified" else None,
    )
    ledger._audit(con, user_id, "invoice.settings", str(registered))
    return get_settings(con)


def taxable_sales(con: pg8000.native.Connection, year: int, registered_on: str) -> int:
    """登録日（ふくむ）より後の、確定した売上（売上・雑収入）の税込の合計"""
    start = max(dt.date(year, 1, 1), dt.date.fromisoformat(registered_on))
    return con.run(
        "select coalesce(sum(l.amount), 0)::bigint from journal_lines l join journal_entries e on e.id = l.entry_id"
        " join accounts a on a.code = l.account_code"
        " where a.kind = 'revenue' and l.side = 'credit' and e.status = 'confirmed'"
        "   and e.entry_date >= :s and e.entry_date < make_date(:y + 1, 1, 1)",
        s=start, y=year,
    )[0][0]


def for_year(con: pg8000.native.Connection, year: int, rules: dict) -> dict | None:
    settings = get_settings(con)
    if not settings["registered"] or not settings["registered_on"]:
        return None
    if dt.date.fromisoformat(settings["registered_on"]).year > year:
        return None  # その年はまだ登録前
    if "consumption" not in rules:
        raise ledger.ValidationError(f"{year}年分の消費税のルールがまだ入っていません")
    rule = rules["consumption"]
    if settings["method"] == "two_tenths" and rule.get("special") != "two_tenths":
        raise ledger.ValidationError(f"{year}年分は2割特例が使えません。計算のしかたを選びなおしてね")
    result = calculate(rule, settings, taxable_sales(con, year, settings["registered_on"]))
    result["registered_on"] = settings["registered_on"]
    result["category_label"] = CATEGORY_LABELS.get(settings["business_category"]) if settings["method"] == "simplified" else None
    return result
