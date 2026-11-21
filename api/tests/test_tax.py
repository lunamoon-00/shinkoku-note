"""税額の計算。答えは国税庁の計算式で手計算したもの（式をコメントに書いておく）。"""

import pytest

from shinkoku import db, tax

from .conftest import ALICE


@pytest.fixture
def rules(database):
    """DB に入れた年ごとのルールを読む（本番と同じものを使う）"""
    def load(year):
        return {k: v for k, v in database.run("select key, value from tax_rules where year = :y", y=year)}
    return {2025: load(2025), 2026: load(2026)}


def calc(rules, year=2026, revenue=3_000_000, expense=600_000, withholding=0, **inputs):
    return tax.calculate(year, rules[year], {"revenue": revenue, "expense": expense, "withholding": withholding}, inputs)


# ───────── 基本の流れ ─────────
def test_いちばん簡単な例_2026年分(rules):
    r = calc(rules, social_insurance=300_000, withholding=306_300)
    L = r.lines
    assert L["business_income"] == 2_400_000                 # 3,000,000 − 600,000
    assert r.deductions["basic"] == 1_040_000                # 合計所得 489万円以下 → 104万円（令和8年分）
    assert L["total_deductions"] == 1_340_000                # 30万 + 104万
    assert L["taxable_income"] == 1_060_000                  # 2,400,000 − 1,340,000
    assert L["income_tax"] == 53_000                         # 1,060,000 × 5%
    assert L["reconstruction_tax"] == 1_113                  # 53,000 × 2.1%（1円未満切り捨て）
    assert L["total_tax"] == 54_113
    assert (L["payable"], L["refund"]) == (0, 252_187)       # 54,113 − 306,300 → 戻ってくる（切り捨てない）


def test_同じ人の2025年分は_基礎控除が88万円になる(rules):
    r = calc(rules, year=2025, social_insurance=300_000)
    assert r.deductions["basic"] == 880_000                  # 合計所得 132万超336万以下 → 88万円（令和7年分）
    assert r.lines["taxable_income"] == 1_220_000            # 2,400,000 − 300,000 − 880,000
    assert r.lines["income_tax"] == 61_000


def test_払うときは100円未満切り捨て(rules):
    r = calc(rules, revenue=8_000_000, expense=1_000_000)
    # 合計所得 700万 → 基礎控除 62万（655万超）→ 課税 6,380,000 → 20% − 427,500 = 848,500
    assert r.deductions["basic"] == 620_000
    assert r.lines["income_tax"] == 848_500
    assert r.lines["reconstruction_tax"] == 17_818            # 848,500 × 0.021 = 17,818.5 → 17,818
    assert r.lines["payable"] == 866_300                      # 866,318 → 100円未満切り捨て


def test_課税される所得は1000円未満切り捨て(rules):
    r = calc(rules, revenue=2_000_999, expense=0)             # 2,000,999 − 1,040,000 = 960,999 → 960,000
    assert r.lines["taxable_income"] == 960_000


def test_赤字なら税金は0円で_源泉徴収はぜんぶ戻る(rules):
    r = calc(rules, revenue=500_000, expense=900_000, withholding=51_050)
    assert r.lines["total_income"] == 0 and r.lines["income_tax"] == 0
    assert r.lines["refund"] == 51_050


@pytest.mark.parametrize("income, basic", [
    (1_320_000, 1_040_000), (4_890_000, 1_040_000), (4_890_001, 670_000), (6_550_000, 670_000),
    (6_550_001, 620_000), (23_500_000, 620_000), (24_000_000, 480_000), (24_500_000, 320_000),
    (25_000_000, 160_000), (25_000_001, 0),
])
def test_基礎控除の表のさかいめ_2026年分(rules, income, basic):
    assert calc(rules, revenue=income, expense=0).deductions["basic"] == basic


@pytest.mark.parametrize("taxable, expected", [
    (1_949_000, 97_450), (1_950_000, 97_500), (3_299_000, 232_400), (3_300_000, 232_500),
    (6_949_000, 962_300), (8_999_000, 1_433_770), (9_000_000, 1_434_000), (40_000_000, 13_204_000),
])
def test_速算表のさかいめ(rules, taxable, expected):
    # 課税所得 = 売上 − 基礎控除 になるように売上を作る
    basic = tax._table(rules[2026]["basic_deduction"], taxable + 620_000)
    r = calc(rules, revenue=taxable + basic, expense=0)
    assert r.lines["taxable_income"] == taxable
    assert r.lines["income_tax"] == expected


# ───────── 所得控除 ─────────
@pytest.mark.parametrize("p, new, old", [
    (20_000, 20_000, 20_000), (40_000, 30_000, 32_500), (80_000, 40_000, 45_000), (100_000, 40_000, 50_000), (200_000, 40_000, 50_000),
])
def test_生命保険料の式(p, new, old):
    assert tax.life_new(p) == new
    assert tax.life_old(p) == old


def test_生命保険料_新と旧の組み合わせと上限(rules):
    # 一般：旧 50,000 → 37,500 と 新 30,000 → 25,000 → 合計 62,500 → 上限 40,000
    # 介護医療：新 80,000 → 40,000／個人年金：新 100,000 → 40,000 → 合計 120,000
    r = calc(rules, year=2025, life_insurance={"old_general": 50_000, "new_general": 30_000, "new_medical": 80_000, "new_pension": 100_000})
    assert r.deductions["life_insurance"] == 120_000
    # 旧が6万円をこえていたら旧だけ：旧 100,000 → 50,000
    r = calc(rules, year=2025, life_insurance={"old_general": 100_000, "new_general": 100_000})
    assert r.deductions["life_insurance"] == 50_000


def test_2026年分は23歳未満の扶養親族がいると一般生命保険料の上限が6万円(rules):
    child = {"relation": "child", "birth_date": "2010-04-01", "income": 0}  # 2026年末で16歳
    r = calc(rules, life_insurance={"new_general": 200_000}, family=[child])
    assert r.deductions["life_insurance"] == 60_000
    assert calc(rules, year=2025, life_insurance={"new_general": 200_000}, family=[child]).deductions["life_insurance"] == 40_000


def test_地震保険料(rules):
    assert calc(rules, earthquake_insurance={"earthquake": 30_000, "old_long_term": 15_000}).deductions["earthquake_insurance"] == 42_500
    assert calc(rules, earthquake_insurance={"earthquake": 60_000}).deductions["earthquake_insurance"] == 50_000


def test_医療費控除は10万円をこえた分_所得が200万円未満なら5パーセントをこえた分(rules):
    assert calc(rules, medical={"paid": 250_000, "reimbursed": 30_000}).deductions["medical"] == 120_000
    # 合計所得 150万 → 5% = 75,000 をこえた分
    assert calc(rules, revenue=1_500_000, expense=0, medical={"paid": 100_000}).deductions["medical"] == 25_000


def test_セルフメディケーションは12000円をこえた分で上限88000円(rules):
    assert calc(rules, medical={"mode": "self_medication", "paid": 30_000}).deductions["medical"] == 18_000
    assert calc(rules, medical={"mode": "self_medication", "paid": 200_000}).deductions["medical"] == 88_000


def test_ふるさと納税は2000円を引いた額(rules):
    assert calc(rules, donations=50_000).deductions["donation"] == 48_000


def test_配偶者控除と配偶者特別控除_2026年分は62万円がさかいめ(rules):
    spouse = {"relation": "spouse", "birth_date": "1990-01-01"}
    assert calc(rules, family=[{**spouse, "income": 620_000}]).deductions["spouse"] == 380_000
    r = calc(rules, family=[{**spouse, "income": 620_001}])
    assert (r.deductions["spouse"], r.deductions["spouse_special"]) == (0, 380_000)
    assert calc(rules, family=[{**spouse, "income": 1_100_000}]).deductions["spouse_special"] == 260_000
    assert calc(rules, family=[{**spouse, "income": 1_330_001}]).deductions["spouse_special"] == 0
    # 2025年分は 58万円がさかいめ
    assert calc(rules, year=2025, family=[{**spouse, "income": 600_000}]).deductions["spouse_special"] == 380_000


def test_70歳以上の配偶者は老人控除対象配偶者(rules):
    r = calc(rules, family=[{"relation": "spouse", "birth_date": "1955-06-01", "income": 0}])
    assert r.deductions["spouse"] == 480_000


def test_扶養控除_年齢で金額が変わる(rules):
    fam = [
        {"relation": "child", "birth_date": "2015-01-01", "income": 0},   # 11歳：扶養控除なし（16歳未満）
        {"relation": "child", "birth_date": "2008-01-01", "income": 0},   # 18歳：一般 38万
        {"relation": "child", "birth_date": "2005-01-01", "income": 0},   # 21歳：特定 63万
        {"relation": "parent", "birth_date": "1950-01-01", "income": 0, "living_together": True},  # 76歳・同居：58万
    ]
    assert calc(rules, family=fam).deductions["dependents"] == 380_000 + 630_000 + 580_000


def test_特定親族特別控除_2026年分(rules):
    student = {"relation": "child", "birth_date": "2005-01-01", "income": 900_000}  # 21歳・合計所得90万
    r = calc(rules, family=[student])
    assert (r.deductions["dependents"], r.deductions["specific_relative"]) == (0, 610_000)


def test_事業専従者控除と_そのときは配偶者控除が使えない(rules):
    r = calc(rules, senjusha=[{"relation": "spouse"}],
             family=[{"relation": "spouse", "birth_date": "1990-01-01", "income": 0, "is_senjusha": True}])
    assert r.lines["senjusha_deduction"] == 860_000            # 86万 と 240万÷2=120万 の少ない方
    assert r.lines["business_income"] == 1_540_000
    assert r.deductions["spouse"] == 0


def test_専従者控除は_事業所得を人数たす1でわった額までにおさえる(rules):
    r = calc(rules, revenue=1_000_000, expense=0, senjusha=[{"relation": "spouse"}])
    assert r.lines["senjusha_deduction"] == 500_000            # 100万 ÷ 2


def test_本人の人的控除(rules):
    r = calc(rules, self={"disability": "special", "single_parent": True})
    assert r.deductions["disability"] == 400_000
    assert r.deductions["widow_or_single_parent"] == 350_000


def test_住宅ローン控除と予定納税(rules):
    r = calc(rules, revenue=6_000_000, expense=0, tax_credits={"housing_loan": 100_000}, prepaid_tax=50_000)
    # 合計所得 600万 → 基礎 67万 → 課税 5,330,000 → 20% − 427,500 = 638,500 → − 100,000 = 538,500
    assert r.lines["income_tax"] == 638_500
    assert r.lines["base_income_tax"] == 538_500
    assert r.lines["reconstruction_tax"] == 11_308
    assert r.lines["payable"] == 499_800                       # 549,808 − 50,000 = 499,808 → 499,800


def test_DBのルールには_2025年と2026年の全部の項目と出典がある(database):
    rows = database.run("select year, count(*), count(*) filter (where source_url like 'https://%') from tax_rules group by year order by year")
    assert rows == [[2025, 20, 20], [2026, 20, 20]]


# ───────── 帳簿・入力とつないだ計算 ─────────
def test_帳簿から売上と経費と_印つきの源泉徴収を集めて計算する(app_con):
    from shinkoku import ledger, tax_service

    with db.as_user(app_con, ALICE):
        ledger.create_entry(app_con, ALICE, {"entry_date": "2026-03-31", "status": "confirmed", "lines": [
            {"side": "debit", "account_code": "1200", "amount": 897_900},
            {"side": "debit", "account_code": "1900", "amount": 102_100, "tag": "withholding"},
            {"side": "credit", "account_code": "4100", "amount": 1_000_000}]})
        ledger.create_entry(app_con, ALICE, {"entry_date": "2026-04-01", "status": "confirmed", "lines": [
            {"side": "debit", "account_code": "1900", "amount": 50_000},   # 生活費の引き出し（源泉徴収ではない）
            {"side": "credit", "account_code": "1200", "amount": 50_000}]})
        ledger.create_entry(app_con, ALICE, {"entry_date": "2026-05-01", "status": "confirmed", "lines": [
            {"side": "debit", "account_code": "5190", "amount": 100_000},
            {"side": "credit", "account_code": "2900", "amount": 100_000}]})
        tax_service.save_inputs(app_con, ALICE, 2026, {"social_insurance": 200_000})
        out = tax_service.compute(app_con, 2026)
    assert out["books"] == {"revenue": 1_000_000, "expense": 100_000, "withholding": 102_100}
    # 900,000 − (200,000 + 1,040,000) → 0 → 税金0円 → 源泉徴収 102,100円がぜんぶ戻る
    assert out["result"]["taxable_income"] == 0 and out["result"]["refund"] == 102_100
    assert out["sources"]["basic_deduction"].startswith("https://www.nta.go.jp/")


def test_源泉徴収の印は_借方の事業主貸にだけつけられる(app_con):
    from shinkoku import ledger

    with db.as_user(app_con, ALICE):
        with pytest.raises(ledger.ValidationError):
            ledger.create_entry(app_con, ALICE, {"entry_date": "2026-01-01", "status": "confirmed", "lines": [
                {"side": "debit", "account_code": "5190", "amount": 100, "tag": "withholding"},
                {"side": "credit", "account_code": "2900", "amount": 100}]})


@pytest.mark.parametrize("payload, field", [
    ({"social_insurance": -1}, "social_insurance"),
    ({"social_insurance": 1.5}, "social_insurance"),
    ({"family": [{"relation": "cat", "birth_date": "2000-01-01"}]}, "family[0].relation"),
    ({"family": [{"relation": "child", "birth_date": "2030-01-01"}]}, "family[0].birth_date"),
    ({"family": [{"relation": "spouse", "birth_date": "1990-01-01"}, {"relation": "spouse", "birth_date": "1991-01-01"}]}, "family"),
    ({"self": {"widow": True, "single_parent": True}}, "self.single_parent"),
    ({"medical": {"mode": "both"}}, "medical.mode"),
])
def test_おかしな入力は理由を伝えて断る(payload, field):
    from shinkoku import ledger, tax_service

    with pytest.raises(ledger.ValidationError) as err:
        tax_service.validate_inputs(payload, 2026)
    assert field in [d["field"] for d in err.value.details]


def test_ルールがない年は_まだですと伝える(app_con):
    from shinkoku import ledger, tax_service

    with db.as_user(app_con, ALICE):
        with pytest.raises(ledger.ValidationError, match="2027年分の税のルール"):
            tax_service.compute(app_con, 2027)


def test_入力は本人のぶんしか見えない(app_con):
    from shinkoku import tax_service

    from .conftest import BOB

    with db.as_user(app_con, ALICE):
        tax_service.save_inputs(app_con, ALICE, 2026, {"social_insurance": 123})
    with db.as_user(app_con, BOB):
        assert tax_service.get_inputs(app_con, 2026) == {}
