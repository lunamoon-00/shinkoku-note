"""CSV の読み取り（DB を使わない部分）。銀行・カードでよくある形で試す。"""

import pytest

from shinkoku import csv_import as ci

BANK = (
    "口座番号,1234567\n"
    "取引日,摘要,お支払金額,お預り金額,残高\n"
    '2026/11/01,カ）デザイン,"",89790,"1,089,790"\n'
    "2026/11/05,ﾃﾞﾝｷﾀﾞｲ,4980,,1084810\n"
    "2026/11/05,ﾃﾞﾝｷﾀﾞｲ,4980,,1079830\n"
    "合計,,9960,89790,\n"
)

CARD = "ご利用日,ご利用店名,ご利用金額,支払区分\n2026年11月3日,ＡＭＡＺＯＮ．ＣＯ．ＪＰ,\"￥3,300\",1回\n2026年11月4日,返品,-1100,1回\n"

SIGNED = "日付,内容,金額\n20261102,スマホ代,-4980\n20261110,振込 Ａ社,100000\n"


def test_銀行の形_見出しの前の行と合計の行は飛ばす():
    rows = ci.parse(BANK.encode("cp932"), "personal")
    assert [(r.date, r.amount, r.direction) for r in rows] == [
        ("2026-11-01", 89790, "in"), ("2026-11-05", 4980, "out"), ("2026-11-05", 4980, "out"),
    ]
    assert rows[1].description == "デンキダイ"  # 半角カナはそろえる


def test_同じ日に同じお店で同じ金額が2回あっても_別の行として数える():
    rows = ci.parse(BANK.encode("cp932"), "personal")
    assert rows[1].row_hash != rows[2].row_hash


def test_同じCSVを読みなおすと_同じ指紋になる():
    a = ci.parse(BANK.encode("cp932"), "personal")
    b = ci.parse(BANK.encode("utf-8"), "personal")
    assert [r.row_hash for r in a] == [r.row_hash for r in b]


def test_どこの明細かがちがえば_指紋もちがう():
    a = ci.parse(BANK.encode(), "personal")
    b = ci.parse(BANK.encode(), "business")
    assert a[0].row_hash != b[0].row_hash


def test_カードの形_全角と円マークと返品():
    rows = ci.parse(CARD.encode("utf-8-sig"), "personal")
    assert [(r.date, r.description, r.amount, r.direction) for r in rows] == [
        ("2026-11-03", "AMAZON.CO.JP", 3300, "out"), ("2026-11-04", "返品", 1100, "in"),
    ]


def test_金額1列でプラスマイナスの形():
    rows = ci.parse(SIGNED.encode(), "business")
    assert [(r.amount, r.direction) for r in rows] == [(4980, "out"), (100000, "in")]


@pytest.mark.parametrize("text, expected", [
    ("1,234", 1234), ("￥1,234", 1234), ("-1,234", -1234), ("1234円", 1234), ("(500)", -500), ("", None), ("1.5", None),
])
def test_金額の読み方(text, expected):
    assert ci.parse_amount(text) == expected


@pytest.mark.parametrize("text, expected", [
    ("2026/11/05", "2026-11-05"), ("2026-1-5", "2026-01-05"), ("2026年11月5日", "2026-11-05"),
    ("20261105", "2026-11-05"), ("2026/02/30", None), ("合計", None),
])
def test_日付の読み方(text, expected):
    d = ci.parse_date(text)
    assert (d.isoformat() if d else None) == expected


def test_見出しがわからないときは_AIに聞く():
    odd = "A,B,C\n2026/11/01,なにか,500\n"
    called = []

    def fallback(records):
        called.append(records)
        return ci.Mapping(date=0, description=1, out=2), 1

    rows = ci.parse(odd.encode(), "personal", mapping_fallback=fallback)
    assert called and rows[0].amount == 500


@pytest.mark.parametrize("content, message", [
    (b"\x00" * (ci.MAX_BYTES + 1), "大きすぎます"),
    ("日付,内容,金額\n".encode(), "中身が見つかりませんでした"),
    ("A,B,C\n1,2,3\n".encode(), "列が見つかりませんでした"),
    ("\xff\xfe\xfa".encode("latin-1"), "文字コード"),
])
def test_読めないCSVは理由を伝えて断る(content, message):
    with pytest.raises(ci.CsvError, match=message):
        ci.parse(content, "personal")
