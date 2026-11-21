"""減価償却（国税庁 No.2100・No.2106、耐用年数省令 別表第八）。

- 定額法：1年分 ＝ 取得価額 × 償却率。使い始めた年と、売った・捨てた年は、使った月数／12
  最後は帳簿の値段を 1円 だけ残す（備忘価額）
- 一括償却（10万円以上20万円未満を選んだとき）：取得価額の 1/3 ずつ3年。月数で分けない
- 仕事で使う割合（家事按分）をかけた分だけを、その年の経費にする
- 1円未満の端数は切り捨て（国税庁のページに書いていないので、ここでは切り捨てにそろえている）
"""

from __future__ import annotations

import datetime as dt
import uuid

import pg8000.native

from . import ledger


def schedule(asset: dict, rates: dict, until_year: int) -> list[dict]:
    """その資産の、使い始めた年〜until_year の年ごとの償却費"""
    acquired = dt.date.fromisoformat(str(asset["acquired_on"]))
    disposed = dt.date.fromisoformat(str(asset["disposed_on"])) if asset.get("disposed_on") else None
    cost = int(asset["cost"])
    ratio = int(asset.get("business_ratio", 100))
    rows = []

    if asset.get("method") == "lump3":
        parts = [cost // 3, cost // 3, cost - 2 * (cost // 3)]
        for i, dep in enumerate(parts):
            year = acquired.year + i
            if year > until_year:
                break
            rows.append({"year": year, "depreciation": dep, "expense": dep * ratio // 100})
        return rows

    rate = int(rates[str(int(asset["useful_life"]))])  # 千分率
    annual = cost * rate // 1000
    book = cost
    year = acquired.year
    while book > 1 and year <= until_year:
        if disposed and year > disposed.year:
            break
        # その年に使っていた月数（使い始めた月・売った月もふくめて数える）
        first = acquired.month if year == acquired.year else 1
        last = disposed.month if (disposed and year == disposed.year) else 12
        months = last - first + 1
        dep = min(annual * months // 12, book - 1)
        book -= dep
        rows.append({"year": year, "depreciation": dep, "expense": dep * ratio // 100, "book_value": book})
        year += 1
    return rows


# ───────── DB ─────────
FIELDS = ("id", "name", "acquired_on", "cost", "useful_life", "method", "business_ratio", "disposed_on")


def _row(r) -> dict:
    d = dict(zip(FIELDS, r))
    d["id"] = str(d["id"])
    d["acquired_on"] = d["acquired_on"].isoformat()
    d["disposed_on"] = d["disposed_on"].isoformat() if d["disposed_on"] else None
    return d


def list_assets(con: pg8000.native.Connection) -> list[dict]:
    return [_row(r) for r in con.run(f"select {', '.join(FIELDS)} from fixed_assets order by acquired_on, created_at")]


def create_asset(con: pg8000.native.Connection, user_id: str, payload: dict) -> dict:
    if not isinstance(payload, dict):
        raise ledger.ValidationError("送られてきた形がおかしいです")
    errors = []
    name = str(payload.get("name", "")).strip()
    if not 1 <= len(name) <= 50:
        errors.append({"field": "name", "message": "名前を50文字までで入れてください"})
    try:
        acquired = dt.date.fromisoformat(str(payload.get("acquired_on")))
    except ValueError:
        acquired = None
        errors.append({"field": "acquired_on", "message": "使い始めた日を入れてください"})
    cost = payload.get("cost")
    if not isinstance(cost, int) or isinstance(cost, bool) or not 1 <= cost <= 1_000_000_000:
        errors.append({"field": "cost", "message": "買った値段を1円以上で入れてください"})
        cost = 0
    method = payload.get("method", "straight")
    if method not in ("straight", "lump3"):
        errors.append({"field": "method", "message": "経費にするやり方を選んでください"})
    if method == "lump3" and cost and not 100_000 <= cost < 200_000:
        errors.append({"field": "method", "message": "3年で1/3ずつ（一括償却）は、10万円以上20万円未満のものだけです"})
    if method == "straight" and cost and cost < 100_000:
        errors.append({"field": "cost", "message": "10万円未満のものは、買った年にふつうの経費として記録してね（減価償却はいりません）"})
    life = payload.get("useful_life", 4)
    if method == "straight" and (not isinstance(life, int) or isinstance(life, bool) or not 2 <= life <= 100):
        errors.append({"field": "useful_life", "message": "耐用年数を2〜100年で入れてください"})
    ratio = payload.get("business_ratio", 100)
    if not isinstance(ratio, int) or isinstance(ratio, bool) or not 1 <= ratio <= 100:
        errors.append({"field": "business_ratio", "message": "仕事で使う割合は1〜100%で入れてください"})
    if errors:
        raise ledger.ValidationError("入力を確かめてください", errors)
    row = con.run(
        "insert into fixed_assets (user_id, name, acquired_on, cost, useful_life, method, business_ratio)"
        f" values (:u, :n, :a, :c, :l, :m, :r) returning {', '.join(FIELDS)}",
        u=user_id, n=name, a=acquired, c=cost, l=life if method == "straight" else 3, m=method, r=ratio,
    )[0]
    ledger._audit(con, user_id, "asset.create", str(row[0]))
    return _row(row)


def delete_asset(con: pg8000.native.Connection, user_id: str, asset_id: str) -> None:
    try:
        asset_id = str(uuid.UUID(str(asset_id)))
    except ValueError:
        raise ledger.NotFound() from None
    if not con.run("delete from fixed_assets where id = cast(:id as uuid) returning id", id=asset_id):
        raise ledger.NotFound()
    ledger._audit(con, user_id, "asset.delete", asset_id)


def for_year(con: pg8000.native.Connection, year: int, rates: dict) -> dict:
    """その年の減価償却費（資産ごと・合計）"""
    items = []
    for a in list_assets(con):
        rows = [r for r in schedule(a, rates, year) if r["year"] == year]
        if rows:
            items.append({**a, "depreciation": rows[0]["depreciation"], "expense": rows[0]["expense"],
                          "book_value": rows[0].get("book_value")})
    return {"items": items, "total": sum(i["expense"] for i in items)}
