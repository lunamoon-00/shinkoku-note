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
# 「確認した」の印をつける項目（チェックリストに使う）
SECTIONS = ("books", "salary", "social_insurance", "small_business", "life_insurance", "earthquake", "medical",
            "donations", "family", "self", "other_income", "credits")
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

    salaries = payload.get("salaries") or []
    clean["salaries"] = []
    for i, s in enumerate(salaries if isinstance(salaries, list) else []):
        s = s if isinstance(s, dict) else {}
        clean["salaries"].append({
            "payer": str(s.get("payer", ""))[:30],
            "gross": _yen(s.get("gross"), f"salaries[{i}].gross", errors),                       # 支払金額
            "income_after_deduction": _yen(s.get("income_after_deduction"), f"salaries[{i}].income_after_deduction", errors),
            "withheld": _yen(s.get("withheld"), f"salaries[{i}].withheld", errors),               # 源泉徴収税額
            "social_insurance": _yen(s.get("social_insurance"), f"salaries[{i}].social_insurance", errors),  # 社会保険料等の金額
        })
    clean["salaries"] = clean["salaries"][:5]

    others = payload.get("other_incomes") or []
    clean["other_incomes"] = [
        {"label": str(o.get("label", ""))[:30], "income": _yen(o.get("income"), f"other_incomes[{i}].income", errors)}
        for i, o in enumerate(others if isinstance(others, list) else []) if isinstance(o, dict)
    ][:10]
    checked = payload.get("checked") or {}
    clean["checked"] = {k: True for k in SECTIONS if isinstance(checked, dict) and checked.get(k) is True}
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


def white_lines(con: pg8000.native.Connection, year: int) -> list[dict]:
    """収支内訳書（一般用）の欄ごとの合計（確定した記録だけ）"""
    s = ledger.summary(con, year)
    lines: dict[str, int] = {}
    for a in s["accounts"]:
        if a["white_line"]:
            lines[a["white_line"]] = lines.get(a["white_line"], 0) + a["balance"]
    return [{"line": k, "amount": v} for k, v in lines.items()]


CHECK_LABELS = {
    "books": "売上と経費の記録（今年の分をぜんぶ入れた）",
    "salary": "お給料（会社の源泉徴収票）",
    "social_insurance": "健康保険・年金など（社会保険料）",
    "small_business": "小規模企業共済・iDeCo",
    "life_insurance": "生命保険料",
    "earthquake": "地震保険料",
    "medical": "医療費",
    "donations": "ふるさと納税・寄附",
    "family": "家族（配偶者・子・親など）",
    "self": "本人のこと（障害者・ひとり親など）",
    "other_income": "ほかの所得（副業のお給料など）",
    "credits": "住宅ローン控除・予定納税",
}


def checklist(con: pg8000.native.Connection, year: int, inputs: dict, b: dict) -> list[dict]:
    """申告の前にそろえるもの。done＝そろった、warn＝気をつけること"""
    checked = inputs.get("checked", {})
    items = []
    drafts = con.run(
        "select count(*) from journal_entries where status = 'draft'"
        " and entry_date >= make_date(:y, 1, 1) and entry_date < make_date(:y + 1, 1, 1)", y=year,
    )[0][0]
    items.append({"key": "drafts", "label": "確認待ちの記録をぜんぶ確定した", "done": drafts == 0,
                  "warn": f"確認待ちが {drafts}件 あります。確定するまで計算に入りません" if drafts else ""})
    for key, label in CHECK_LABELS.items():
        warn = ""
        if key == "books" and b["revenue"] == 0:
            warn = "売上が0円です。報酬の記録を入れたか確かめてね"
        if key == "social_insurance" and checked.get(key) and not inputs.get("social_insurance"):
            warn = "国民健康保険や国民年金を払っていたら、金額を入れてね（払っていなければこのままでOK）"
        items.append({"key": key, "label": label, "done": bool(checked.get(key)), "warn": warn})
    return items


def compute(con: pg8000.native.Connection, year: int) -> dict:
    rules, sources = rules_for(con, year)
    b = books(con, year)
    inputs = get_inputs(con, year)
    result = tax.calculate(year, rules, b, inputs)
    return {
        "inputs": inputs,
        "books": b,
        "white_lines": white_lines(con, year),
        "checklist": checklist(con, year, inputs, b),
        "result": result.to_dict(),
        "sources": sources,
    }
