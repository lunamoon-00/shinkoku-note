"""消費税（インボイス）。答えは国税庁の計算の順番と、国税通則法の端数のきまりで手計算したもの。"""

import pytest

from shinkoku import consumption, db, ledger, tax_service

from .conftest import ALICE, BOB


@pytest.fixture
def rule(database):
    return database.run("select value from tax_rules where year = 2026 and key = 'consumption'")[0][0]


def test_2割特例(rule):
    r = consumption.calculate(rule, {"method": "two_tenths"}, 5_500_000)
    assert r["tax_base"] == 5_000_000              # 5,500,000 × 100/110
    assert r["national_tax"] == 390_000            # × 7.8%
    assert r["deduction"] == 312_000               # 2割特例：80%を引く
    assert r["payable_national"] == 78_000
    assert r["payable_local"] == 22_000            # 78,000 × 22/78
    assert r["payable_total"] == 100_000           # ＝ 売上の消費税（50万円）の2割


def test_簡易課税_サービス業は50パーセント(rule):
    r = consumption.calculate(rule, {"method": "simplified", "business_category": 5}, 5_500_000)
    assert (r["deduction"], r["payable_national"], r["payable_local"]) == (195_000, 195_000, 55_000)


def test_端数の切り捨て(rule):
    r = consumption.calculate(rule, {"method": "two_tenths"}, 1_234_567)
    assert r["tax_base"] == 1_122_000              # 1,122,333 → 1,000円未満切り捨て
    assert r["national_tax"] == 87_516             # 1,122,000 × 7.8%
    assert r["payable_national"] == 17_500         # 87,516 − 70,012 = 17,504 → 100円未満切り捨て
    assert r["payable_local"] == 4_900             # 17,500 × 22/78 = 4,935 → 4,900


def test_本則課税はまだ計算しないと伝える(rule):
    r = consumption.calculate(rule, {"method": "standard"}, 1_000_000)
    assert r["payable_total"] == 0 and "本則課税" in r["notes"][0]


def sale(con, date, amount):
    with db.as_user(con, ALICE):
        ledger.create_entry(con, ALICE, {"entry_date": date, "status": "confirmed", "lines": [
            {"side": "debit", "account_code": "1200", "amount": amount}, {"side": "credit", "account_code": "4100", "amount": amount}]})


def test_登録日より前の売上は免税_登録していなければ計算しない(app_con):
    sale(app_con, "2026-03-31", 1_100_000)
    sale(app_con, "2026-04-01", 2_200_000)
    with db.as_user(app_con, ALICE):
        assert tax_service.compute(app_con, 2026)["consumption"] is None
        consumption.save_settings(app_con, ALICE, {"registered": True, "registration_number": "T1234-5678-90123",
                                                   "registered_on": "2026-04-01", "method": "two_tenths"})
        c = tax_service.compute(app_con, 2026)["consumption"]
    assert c["taxable_sales"] == 2_200_000 and c["payable_total"] == 40_000
    with db.as_user(app_con, ALICE):
        assert consumption.get_settings(app_con)["registration_number"] == "T1234567890123"


@pytest.mark.parametrize("payload, field", [
    ({"registered": True, "registration_number": "T123", "registered_on": "2026-01-01"}, "registration_number"),
    ({"registered": True}, "registered_on"),
    ({"registered": True, "registered_on": "2026-01-01", "method": "simplified"}, "business_category"),
])
def test_インボイスの設定のチェック(app_con, payload, field):
    with db.as_user(app_con, ALICE):
        with pytest.raises(ledger.ValidationError) as err:
            consumption.save_settings(app_con, ALICE, payload)
    assert field in [d["field"] for d in err.value.details]


def test_他人のインボイスの設定は見えない(app_con):
    with db.as_user(app_con, ALICE):
        consumption.save_settings(app_con, ALICE, {"registered": True, "registered_on": "2026-01-01"})
    with db.as_user(app_con, BOB):
        assert consumption.get_settings(app_con)["registered"] is False
