"""控除証明書などの写真 → 確定申告の準備（tax_documents）。

読み取った金額は、計算のときに「手で入れた金額」に足して使う（merge_inputs）。
支払調書は、帳簿の源泉徴収と二重にならないように、参考として残すだけ（計算には足さない）。
"""

from __future__ import annotations

import datetime as dt
import json

import pg8000.native

from . import ledger, receipts

LABELS = {
    "social_insurance": "社会保険料（国民年金・国民健康保険など）",
    "small_business": "小規模企業共済・iDeCoの掛金",
    "life_insurance": "生命保険料",
    "earthquake": "地震保険料",
    "donation": "ふるさと納税・寄附",
    "salary": "お給料（源泉徴収票）",
    "medical_notice": "医療費（医療費のお知らせ）",
    "payment_record": "報酬の支払調書（参考）",
}


def _amounts(kind: str, doc: dict) -> dict:
    g = lambda k: max(0, int(doc.get(k) or 0))  # noqa: E731
    if kind == "life_insurance":
        return {"new_general": g("life_new_general"), "new_medical": g("life_new_medical"),
                "new_pension": g("life_new_pension"), "old_general": g("life_old_general"), "old_pension": g("life_old_pension")}
    if kind == "earthquake":
        return {"earthquake": g("eq_earthquake"), "old_long_term": g("eq_old_long")}
    if kind == "salary":
        return {"gross": g("salary_gross"), "income_after_deduction": g("salary_after_deduction"),
                "withheld": g("salary_withheld"), "social_insurance": g("salary_social")}
    return {"amount": g("amount")}


def _total(kind: str, amounts: dict) -> int:
    return amounts["gross"] if kind == "salary" else sum(amounts.values())


def process_certificate(con: pg8000.native.Connection, user_id: str, image: bytes, mime: str, doc: dict, *,
                        store, today: dt.date) -> receipts.Outcome:
    kind = doc.get("doc_type")
    if kind not in LABELS:
        return receipts.Outcome("not_receipt", "🤔 レシートや控除証明書が見つかりませんでした。書類全体が写るように撮ってみてね")
    digest = receipts.image_hash(image)
    if con.run("select 1 from import_files where image_hash = :h", h=digest):
        return receipts.Outcome("duplicate", "🔁 この写真はもう受け取っています。二重には入れません")

    # 対象の年：書類に書いてあればそれ、なければ申告の時期（1〜3月は去年、それ以外は今年）
    year = int(doc.get("year") or 0)
    if not 2025 <= year <= today.year:
        year = today.year - 1 if today.month <= 3 else today.year
    amounts = _amounts(kind, doc)
    if _total(kind, amounts) <= 0:
        return receipts.Outcome("needs_review", f"💦 {LABELS[kind]}の書類みたいだけど、金額が読めませんでした。アプリの「確定申告の準備」から手で入れてね")

    import_id = con.run(
        "insert into import_files (user_id, kind, via, s3_key, image_hash, status, ai_result)"
        " values (:u, 'certificate', 'line', '', :h, 'auto_confirmed', cast(:ai as jsonb)) returning id",
        u=user_id, h=digest, ai=json.dumps(doc, ensure_ascii=False),
    )[0][0]
    ext = {"image/png": "png", "image/webp": "webp"}.get(mime, "jpg")
    key = f"certificates/{user_id}/{year}/{import_id}.{ext}"
    store(key, image, mime)
    con.run("update import_files set s3_key = :k where id = :id", k=key, id=import_id)
    con.run(
        "insert into tax_documents (user_id, year, kind, issuer, amounts, import_file_id)"
        " values (:u, :y, :k, :i, cast(:a as jsonb), :f)",
        u=user_id, y=year, k=kind, i=str(doc.get("issuer", ""))[:100], a=json.dumps(amounts), f=import_id,
    )
    ledger._audit(con, user_id, "tax.document", kind)
    if kind == "payment_record":
        return receipts.Outcome("auto_confirmed",
                                f"📄 支払調書を受け取ったよ（{year}年分）。帳簿の源泉徴収と見くらべられるように、とっておくね")
    return receipts.Outcome(
        "auto_confirmed",
        f"📄 {LABELS[kind]}の書類を読み取ったよ\n{year}年分・{_total(kind, amounts):,}円\n"
        "アプリの「確定申告の準備」に入れたよ。ちがっていたら、そこで消して手で入れてね",
    )


def list_documents(con: pg8000.native.Connection, year: int) -> list[dict]:
    rows = con.run("select id, kind, issuer, amounts, created_at from tax_documents where year = :y order by created_at", y=year)
    out = []
    for i, k, issuer, amounts, created in rows:
        amounts = amounts if isinstance(amounts, dict) else json.loads(amounts)
        out.append({"id": str(i), "kind": k, "label": LABELS[k], "issuer": issuer, "amounts": amounts,
                    "total": _total(k, amounts), "created_at": created.isoformat()})
    return out


def delete_document(con: pg8000.native.Connection, user_id: str, doc_id: str) -> None:
    import uuid

    try:
        doc_id = str(uuid.UUID(str(doc_id)))
    except ValueError:
        raise ledger.NotFound() from None
    if not con.run("delete from tax_documents where id = cast(:id as uuid) returning id", id=doc_id):
        raise ledger.NotFound()
    ledger._audit(con, user_id, "tax.document.delete", doc_id)


def merge_inputs(inputs: dict, documents: list[dict]) -> dict:
    """手で入れた金額に、写真から読み取った金額を足した「計算用の入力」を作る（保存はしない）"""
    m = json.loads(json.dumps(inputs))  # 深いコピー
    add = lambda key, v: m.__setitem__(key, int(m.get(key) or 0) + v)  # noqa: E731
    for d in documents:
        a = d["amounts"]
        if d["kind"] == "social_insurance":
            add("social_insurance", a["amount"])
        elif d["kind"] == "small_business":
            add("small_business_mutual_aid", a["amount"])
        elif d["kind"] == "donation":
            add("donations", a["amount"])
        elif d["kind"] == "medical_notice":
            med = m.setdefault("medical", {"mode": "medical"})
            med["paid"] = int(med.get("paid") or 0) + a["amount"]
        elif d["kind"] == "life_insurance":
            li = m.setdefault("life_insurance", {})
            for k, v in a.items():
                li[k] = int(li.get(k) or 0) + v
        elif d["kind"] == "earthquake":
            eq = m.setdefault("earthquake_insurance", {})
            for k, v in a.items():
                eq[k] = int(eq.get(k) or 0) + v
        elif d["kind"] == "salary":
            m.setdefault("salaries", []).append({"payer": d["issuer"], **a})
        # payment_record（支払調書）は足さない：帳簿の源泉徴収と二重になるため
    return m
