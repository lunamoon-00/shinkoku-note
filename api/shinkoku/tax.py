"""確定申告の計算（白色申告・事業所得）。

数字のルールはコードに書かず、DB の tax_rules（年ごと、国税庁の出典つき）から読む。
ここは「入力 → 計算の途中と結果」を返すだけの関数で、DB を使わない（テストしやすいように）。

計算の順番（国税庁のタックスアンサーの流れ）
  1. 事業所得 ＝ 売上 − 経費 − 事業専従者控除
  2. 合計所得金額 ＝ 事業所得 ＋ ほかの所得
  3. 所得控除の合計（社会保険料・生命保険料・医療費・寄附金・配偶者・扶養・基礎 …）
  4. 課税される所得金額 ＝ 合計所得 − 所得控除（1,000円未満切り捨て）
  5. 所得税 ＝ 速算表
  6. 基準所得税額 ＝ 所得税 − 税額控除（住宅ローン控除など）
  7. 復興特別所得税 ＝ 基準所得税額 × 2.1%（1円未満切り捨て）
  8. 申告納税額 ＝ 7までの合計 − 源泉徴収税額 − 予定納税額（払うときは100円未満切り捨て。戻るときは切り捨てない）
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field


def _table(rows: list, value: int) -> object:
    """[上限（以下）, 値] の表から、value が入る行の値を返す。上限 None は「それより上ぜんぶ」"""
    for upper, *rest in rows:
        if upper is None or value <= upper:
            return rest[0] if len(rest) == 1 else rest
    return None


def _age(birth: str, year: int) -> int:
    """その年の12月31日時点の年齢（国税庁の扶養などの判定のしかた）"""
    b = dt.date.fromisoformat(birth)
    end = dt.date(year, 12, 31)
    return end.year - b.year - ((end.month, end.day) < (b.month, b.day))


# ───────── 生命保険料・地震保険料の計算式（国税庁 No.1140・No.1145） ─────────
def life_new(p: int) -> int:
    if p <= 20_000:
        return p
    if p <= 40_000:
        return p // 2 + 10_000
    if p <= 80_000:
        return p // 4 + 20_000
    return 40_000


def life_old(p: int) -> int:
    if p <= 25_000:
        return p
    if p <= 50_000:
        return p // 2 + 12_500
    if p <= 100_000:
        return p // 4 + 25_000
    return 50_000


def life_new_young(p: int) -> int:
    """令和8年分から：23歳未満の扶養親族がいる人の、新契約の一般生命保険料"""
    if p <= 30_000:
        return p
    if p <= 60_000:
        return p // 2 + 15_000
    if p <= 120_000:
        return p // 4 + 30_000
    return 60_000


def _life_category(new: int, old: int, new_fn, combined_cap: int) -> int:
    """新契約と旧契約の両方があるときの組み合わせ方（旧が6万円超なら旧だけ）"""
    old_d = life_old(old) if old else 0
    new_d = new_fn(new) if new else 0
    if old and old > 60_000:
        return old_d
    if old and new:
        return min(old_d + new_d, combined_cap)
    return old_d or new_d


def life_insurance_deduction(li: dict, young_dependent: bool) -> int:
    general_fn = life_new_young if young_dependent else life_new
    general_cap = 60_000 if young_dependent else 40_000
    general = _life_category(li.get("new_general", 0), li.get("old_general", 0), general_fn, general_cap)
    medical = life_new(li.get("new_medical", 0)) if li.get("new_medical") else 0
    pension = _life_category(li.get("new_pension", 0), li.get("old_pension", 0), life_new, 40_000)
    return min(general + medical + pension, 120_000)


def earthquake_deduction(eq: dict, cap: int) -> int:
    quake = min(eq.get("earthquake", 0), 50_000)
    p = eq.get("old_long_term", 0)
    old = p if p <= 10_000 else (p // 2 + 5_000 if p <= 20_000 else 15_000)
    return min(quake + old, cap)


# ───────── お給料（国税庁 No.1410） ─────────
def salary_income(rule: dict, gross: int) -> int:
    """給与の収入金額（源泉徴収票の支払金額）→ 給与所得の金額"""
    if gross <= rule["flat_upto"]:
        return max(0, gross - rule["flat"])
    for upper, amount in rule["special"]:
        if gross <= upper:
            return amount
    if gross < 6_600_000:
        a = gross // 4000 * 4000  # 所得税法別表第五：4,000円未満を切り捨てた額で計算する
        deduction = a * 30 // 100 + 80_000 if a <= 3_600_000 else a * 20 // 100 + 440_000
        return a - deduction
    if gross < 8_500_000:
        return gross * 90 // 100 - 1_100_000
    return gross - 1_950_000


# ───────── 計算 ─────────
@dataclass
class Result:
    year: int
    lines: dict = field(default_factory=dict)  # 計算の途中と結果（画面・申告書の欄に使う）
    deductions: dict = field(default_factory=dict)  # 所得控除の内訳
    notes: list = field(default_factory=list)  # 確かめてほしいこと

    def to_dict(self) -> dict:
        return {"year": self.year, **self.lines, "deductions": self.deductions, "notes": self.notes}


def calculate(year: int, rules: dict, books: dict, inputs: dict) -> Result:
    """books：帳簿から（売上・経費・源泉徴収）／inputs：利用者が入れたもの（控除・家族など）"""
    r = Result(year)
    L = r.lines
    family = inputs.get("family", [])
    dep_limit = int(rules["dependent_income_limit"])

    # 1. 事業所得
    revenue, expense = books["revenue"], books["expense"]
    before = revenue - expense
    senjusha = 0
    workers = inputs.get("senjusha", [])
    for w in workers:
        cap = rules["senjusha"]["spouse" if w.get("relation") == "spouse" else "other"]
        senjusha += min(cap, max(0, before) // (len(workers) + 1))
    business = before - senjusha
    L.update(revenue=revenue, expense=expense, business_income_before_senjusha=before,
             senjusha_deduction=senjusha, business_income=business)

    # 2. お給料と合計所得金額（事業の赤字は、ほかの所得と差し引ける）
    salary = 0
    salary_withheld = salary_social = 0
    gross_total = 0
    for s in inputs.get("salaries", []):
        override = s.get("income_after_deduction")
        if override:
            salary += int(override)  # 源泉徴収票の「給与所得控除後の金額」を優先
        else:
            gross_total += int(s.get("gross", 0))  # 2枚以上あるときは、支払金額を合計してから表をあてる（No.1410 注4）
        salary_withheld += int(s.get("withheld", 0))
        salary_social += int(s.get("social_insurance", 0))
    if gross_total:
        salary += salary_income(rules["salary"], gross_total)
    other = sum(max(0, int(o.get("income", 0))) for o in inputs.get("other_incomes", []))
    total_income = max(0, business + salary + other)
    L.update(salary_income=salary, other_income=other, total_income=total_income)

    # 3. 所得控除
    D = r.deductions
    # 社会保険料：自分で払った分（国保・国民年金など）＋ お給料から引かれていた分（源泉徴収票）
    D["social_insurance"] = int(inputs.get("social_insurance", 0)) + salary_social
    D["small_business"] = int(inputs.get("small_business_mutual_aid", 0))

    young_dep = bool(rules.get("life_insurance_young_dependent")) and any(
        f.get("relation") != "spouse" and int(f.get("income", 0)) <= dep_limit and _age(f["birth_date"], year) < 23
        for f in family if f.get("birth_date")
    )
    D["life_insurance"] = life_insurance_deduction(inputs.get("life_insurance", {}), young_dep)
    D["earthquake_insurance"] = earthquake_deduction(inputs.get("earthquake_insurance", {}), rules["earthquake"]["cap"])

    med = inputs.get("medical", {})
    if med.get("mode") == "self_medication":
        sm = rules["self_medication"]
        D["medical"] = min(sm["cap"], max(0, int(med.get("paid", 0)) - int(med.get("reimbursed", 0)) - sm["floor"]))
    else:
        m = rules["medical"]
        floor = m["floor"] if total_income >= m["floor_rate_under"] else min(m["floor"], total_income * m["floor_rate_percent"] // 100)
        D["medical"] = min(m["cap"], max(0, int(med.get("paid", 0)) - int(med.get("reimbursed", 0)) - floor))

    donation = int(inputs.get("donations", 0))
    if donation:
        dn = rules["donation"]
        D["donation"] = max(0, min(donation, total_income * dn["income_rate_percent"] // 100) - dn["floor"])
    else:
        D["donation"] = 0

    # 本人の状況（障害者・寡婦・ひとり親・勤労学生）
    me = inputs.get("self", {})
    dis = rules["disability_amounts"]
    D["disability"] = {"normal": dis["normal"], "special": dis["special"]}.get(me.get("disability"), 0)
    D["widow_or_single_parent"] = 0
    if me.get("single_parent") and total_income <= rules["single_parent"]["income_limit"]:
        D["widow_or_single_parent"] = rules["single_parent"]["amount"]
    elif me.get("widow") and total_income <= rules["widow"]["income_limit"]:
        D["widow_or_single_parent"] = rules["widow"]["amount"]
    D["working_student"] = rules["working_student_amount"] if (
        me.get("working_student") and total_income <= int(rules["working_student_income_limit"])) else 0

    # 配偶者・扶養（白色の事業専従者は対象外）
    D["spouse"] = D["spouse_special"] = D["dependents"] = D["specific_relative"] = 0
    for f in family:
        if f.get("is_senjusha"):
            continue
        income = int(f.get("income", 0))
        age = _age(f["birth_date"], year) if f.get("birth_date") else 30
        # 家族の障害者控除（16歳未満の子もふくむ）
        if f.get("disability") in ("normal", "special") and (income <= dep_limit):
            key = "special_living_together" if (f["disability"] == "special" and f.get("living_together")) else f["disability"]
            D["disability"] += dis[key]
        if f.get("relation") == "spouse":
            if income <= dep_limit:
                row = _table(rules["spouse_deduction"], total_income)
                if row is not None and total_income <= 10_000_000:
                    D["spouse"] = row[1] if age >= 70 else row[0]
            elif income <= 1_330_000 and total_income <= 10_000_000:
                tier = 0 if total_income <= 9_000_000 else (1 if total_income <= 9_500_000 else 2)
                amounts = _table(rules["spouse_special"], income)
                D["spouse_special"] = amounts[tier] if amounts else 0
            continue
        amounts = rules["dependent_amounts"]
        if income <= dep_limit:
            if age >= 70:
                D["dependents"] += amounts["elderly_living_with_parent" if (f.get("relation") == "parent" and f.get("living_together")) else "elderly"]
            elif 19 <= age < 23:
                D["dependents"] += amounts["specific"]
            elif age >= 16:
                D["dependents"] += amounts["general"]
        elif 19 <= age < 23 and income <= 1_230_000:
            D["specific_relative"] += _table(rules["specific_relative"], income) or 0

    basic = _table(rules["basic_deduction"], total_income)
    D["basic"] = int(basic or 0)
    total_deductions = sum(D.values())
    L["total_deductions"] = total_deductions

    # 4〜5. 課税される所得金額・所得税
    taxable = max(0, total_income - total_deductions) // 1000 * 1000
    rate_row = _table(rules["rate_table"], taxable)
    income_tax = max(0, taxable * rate_row[0] // 100 - rate_row[1]) if taxable else 0
    L.update(taxable_income=taxable, tax_rate_percent=rate_row[0] if taxable else 0, income_tax=income_tax)

    # 6〜7. 税額控除・復興特別所得税
    credits = int(inputs.get("tax_credits", {}).get("housing_loan", 0))
    base_tax = max(0, income_tax - credits)
    reconstruction = base_tax * int(rules["reconstruction_rate_permille"]) // 1000
    L.update(tax_credits=min(credits, income_tax), base_income_tax=base_tax,
             reconstruction_tax=reconstruction, total_tax=base_tax + reconstruction)

    # 8. 源泉徴収・予定納税を引く
    withheld = books.get("withholding", 0) + int(inputs.get("withholding_extra", 0)) + salary_withheld
    prepaid = int(inputs.get("prepaid_tax", 0))
    balance = base_tax + reconstruction - withheld - prepaid
    L.update(withholding=withheld, prepaid_tax=prepaid)
    if balance >= 0:
        L.update(payable=balance // 100 * 100, refund=0)
    else:
        L.update(payable=0, refund=-balance)

    # 確かめてほしいこと
    if workers and any(f.get("relation") == "spouse" and not f.get("is_senjusha") for f in family) and any(
            w.get("relation") == "spouse" for w in workers):
        r.notes.append("配偶者を事業専従者にしているときは、配偶者控除は使えません。家族の「専従者」の印を確かめてね")
    if total_income > 10_000_000:
        r.notes.append("合計所得が1,000万円をこえているので、配偶者控除・配偶者特別控除は使えません")
    return r
