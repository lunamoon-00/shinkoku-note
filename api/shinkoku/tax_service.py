"""確定申告の計算を、帳簿と入力から組み立てる（DB とつなぐ部分）。

- 帳簿から：売上・経費（確定した記録だけ）・源泉徴収された分（印つきの行）
- 利用者が入れたもの：控除・家族・ほかの所得・事業専従者・税額控除・予定納税（年ごとに1つの JSON）
- ルール：tax_rules（年ごと・国税庁の出典つき）
"""

from __future__ import annotations

import datetime as dt
import json

import pg8000.native

from . import ledger, tax

RELATIONS = ("spouse", "child", "parent", "other")
DISABILITY = (None, "normal", "special")
MAX_YEN = 1_000_000_000


def rules_for(con: pg8000.native.Connection, year: int) -> tuple[dict, dict]:
    rows = con.run("select key, value, source_url from tax_rules where year = :y", y=year)
    if not rows:
        raise ledger.ValidationError(f"{year}年分の税のルールがまだ入っていません（国税庁の資料が出たら入れます）")
    return {k: v for k, v, _ in rows}, {k: u for k, _, u in rows}


def books(con: pg8000.native.Connection, year: int) -> dict:
    s = ledger.summary(con, year)
    withheld = con.run(
        "select coalesce(sum(l.amount), 0)::bigint from journal_lines l join journal_entries e on e.id = l.entry_id"
        " where l.tag = 'withholding' and e.status = 'confirmed'"
        "   and e.entry_date >= make_date(:y, 1, 1) and e.entry_date < make_date(:y + 1, 1, 1)",
        y=year,
    )[0][0]
    return {"revenue": s["revenue"], "expense": s["expense"], "withholding": withheld}


def get_inputs(con: pg8000.native.Connection, year: int) -> dict:
    rows = con.run("select inputs from tax_inputs where year = :y", y=year)
    if not rows:
        return {}
    v = rows[0][0]
    return v if isinstance(v, dict) else json.loads(v)


# ───────── 入力のチェック ─────────
def _yen(v, field: str, errors: list) -> int:
    if v in (None, ""):
        return 0
    if not isinstance(v, int) or isinstance(v, bool) or not 0 <= v <= MAX_YEN:
        errors.append({"field": field, "message": "金額は0円以上の整数で入れてください"})
        return 0
    return v


def validate_inputs(payload: dict, year: int) -> dict:
    if not isinstance(payload, dict):
        raise ledger.ValidationError("送られてきた形がおかしいです")
    errors: list[dict] = []
    clean: dict = {}
    for key in ("social_insurance", "small_business_mutual_aid", "donations", "prepaid_tax", "withholding_extra"):
        clean[key] = _yen(payload.get(key), key, errors)

    li = payload.get("life_insurance") or {}
    clean["life_insurance"] = {k: _yen(li.get(k), f"life_insurance.{k}", errors)
                               for k in ("new_general", "new_medical", "new_pension", "old_general", "old_pension")}
    eq = payload.get("earthquake_insurance") or {}
    clean["earthquake_insurance"] = {k: _yen(eq.get(k), f"earthquake_insurance.{k}", errors) for k in ("earthquake", "old_long_term")}
    med = payload.get("medical") or {}
    mode = med.get("mode", "medical")
    if mode not in ("medical", "self_medication"):
        errors.append({"field": "medical.mode", "message": "医療費控除かセルフメディケーションかを選んでください"})
    clean["medical"] = {"mode": mode, "paid": _yen(med.get("paid"), "medical.paid", errors),
                        "reimbursed": _yen(med.get("reimbursed"), "medical.reimbursed", errors)}
    credits = payload.get("tax_credits") or {}
    clean["tax_credits"] = {"housing_loan": _yen(credits.get("housing_loan"), "tax_credits.housing_loan", errors)}

    me = payload.get("self") or {}
    if me.get("disability") not in DISABILITY:
        errors.append({"field": "self.disability", "message": "障害者の区分を選びなおしてください"})
    if me.get("widow") and me.get("single_parent"):
        errors.append({"field": "self.single_parent", "message": "寡婦控除とひとり親控除は、どちらか一方だけです"})
    clean["self"] = {"disability": me.get("disability"), "widow": bool(me.get("widow")),
                     "single_parent": bool(me.get("single_parent")), "working_student": bool(me.get("working_student"))}

    clean["family"] = []
    family = payload.get("family") or []
    if not isinstance(family, list) or len(family) > 20:
        errors.append({"field": "family", "message": "家族の入れ方がおかしいです"})
        family = []
    for i, f in enumerate(family):
        f = f if isinstance(f, dict) else {}
        if f.get("relation") not in RELATIONS:
            errors.append({"field": f"family[{i}].relation", "message": "続柄を選んでください"})
        try:
            birth = dt.date.fromisoformat(str(f.get("birth_date")))
            if birth.year < 1900 or birth > dt.date(year, 12, 31):
                raise ValueError
        except ValueError:
            errors.append({"field": f"family[{i}].birth_date", "message": "生年月日を入れてください"})
            birth = None
        if f.get("disability") not in DISABILITY:
            errors.append({"field": f"family[{i}].disability", "message": "障害者の区分を選びなおしてください"})
        clean["family"].append({
            "name": str(f.get("name", ""))[:20],  # 画面で見分けるための呼び名（本名でなくてよい）
            "relation": f.get("relation"),
            "birth_date": birth.isoformat() if birth else None,
            "income": _yen(f.get("income"), f"family[{i}].income", errors),
            "living_together": bool(f.get("living_together")),
            "disability": f.get("disability"),
            "is_senjusha": bool(f.get("is_senjusha")),
        })
    if sum(1 for f in clean["family"] if f["relation"] == "spouse") > 1:
        errors.append({"field": "family", "message": "配偶者は1人だけです"})
    # 事業専従者は、家族の「専従者」の印から作る
    clean["senjusha"] = [{"relation": "spouse" if f["relation"] == "spouse" else "other"} for f in clean["family"] if f["is_senjusha"]]

    others = payload.get("other_incomes") or []
    clean["other_incomes"] = [
        {"label": str(o.get("label", ""))[:30], "income": _yen(o.get("income"), f"other_incomes[{i}].income", errors)}
        for i, o in enumerate(others if isinstance(others, list) else []) if isinstance(o, dict)
    ][:10]
    if errors:
        raise ledger.ValidationError("入力を確かめてください", errors)
    return clean


def save_inputs(con: pg8000.native.Connection, user_id: str, year: int, payload: dict) -> dict:
    clean = validate_inputs(payload, year)
    con.run(
        "insert into tax_inputs (user_id, year, inputs) values (:u, :y, cast(:i as jsonb))"
        " on conflict (user_id, year) do update set inputs = excluded.inputs, updated_at = now()",
        u=user_id, y=year, i=json.dumps(clean, ensure_ascii=False),
    )
    ledger._audit(con, user_id, "tax.inputs", str(year))
    return clean


def compute(con: pg8000.native.Connection, year: int) -> dict:
    rules, sources = rules_for(con, year)
    b = books(con, year)
    inputs = get_inputs(con, year)
    result = tax.calculate(year, rules, b, inputs)
    return {"inputs": inputs, "books": b, "result": result.to_dict(), "sources": sources}
