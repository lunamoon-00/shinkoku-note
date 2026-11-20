"""銀行・カードの CSV を読んで、取りこむ前の確認用の行にする。

1. 文字コードを見分ける（UTF-8 → だめなら Shift_JIS）
2. 見出しから「日付・内容・金額（出金／入金）」の列を見分ける
3. 1行ずつ、日付と金額を読む（2026/11/05・2026年11月5日・20261105、￥1,234・-1,234 など）
4. 1行ずつ「指紋」を作る（同じ行を二度取りこまないため）
"""

from __future__ import annotations

import csv
import datetime as dt
import hashlib
import io
import json
import re
import unicodedata
from dataclasses import asdict, dataclass

MAX_BYTES = 1_000_000
MAX_ROWS = 1000


class CsvError(Exception):
    """CSV が読めないとき（画面にそのまま出せる、やさしい日本語で）"""


@dataclass
class Row:
    row_id: int
    date: str  # YYYY-MM-DD
    description: str
    amount: int  # 円（いつもプラス）
    direction: str  # out＝出ていった / in＝入ってきた
    row_hash: str

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Mapping:
    date: int
    description: int
    out: int | None = None  # 出金の列（カードなら利用金額の列）
    in_: int | None = None  # 入金の列
    signed: int | None = None  # 「金額」1列でプラス・マイナスで出入りがわかる形


# ───────── 1. 文字コード ─────────
def decode(raw: bytes) -> str:
    if len(raw) > MAX_BYTES:
        raise CsvError("ファイルが大きすぎます（1MBまで）。期間を分けて書き出してみてね")
    for enc in ("utf-8-sig", "cp932"):  # cp932 ＝ Windows の Shift_JIS
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    raise CsvError("文字コードが読めませんでした。UTF-8 か Shift_JIS の CSV にしてね")


def _norm(s: str) -> str:
    return re.sub(r"\s", "", unicodedata.normalize("NFKC", s or ""))


# ───────── 2. 列を見分ける ─────────
DATE_WORDS = ("取引日", "利用日", "ご利用日", "日付", "年月日", "お取引日", "取扱日", "計上日")
DESC_WORDS = ("ご利用店名", "利用店名", "摘要", "内容", "お取引内容", "取引内容", "明細", "ご利用先", "利用先", "店名", "備考")
OUT_WORDS = ("お支払金額", "支払金額", "出金", "お引出", "引出", "ご利用金額", "利用金額", "支払額", "引落")
IN_WORDS = ("お預り金額", "お預入", "預入", "入金", "預り")
SIGNED_WORDS = ("金額", "取引金額")


def _find(header: list[str], words: tuple[str, ...], used: set[int]) -> int | None:
    for word in words:  # 先に書いた言葉ほど優先
        for i, h in enumerate(header):
            if i not in used and word in _norm(h):
                return i
    return None


def detect_mapping(header: list[str]) -> Mapping | None:
    used: set[int] = set()
    date = _find(header, DATE_WORDS, used)
    if date is None:
        return None
    used.add(date)
    desc = _find(header, DESC_WORDS, used)
    if desc is None:
        return None
    used.add(desc)
    out = _find(header, OUT_WORDS, used)
    if out is not None:
        used.add(out)
    in_ = _find(header, IN_WORDS, used)
    if in_ is not None:
        used.add(in_)
    if out is None and in_ is None:
        signed = _find(header, SIGNED_WORDS, used)
        if signed is None:
            return None
        return Mapping(date=date, description=desc, signed=signed)
    return Mapping(date=date, description=desc, out=out, in_=in_)


# ───────── 3. 日付と金額 ─────────
def parse_date(text: str) -> dt.date | None:
    s = _norm(text)
    m = re.fullmatch(r"(\d{4})[/\-.年](\d{1,2})[/\-.月](\d{1,2})日?", s) or re.fullmatch(r"(\d{4})(\d{2})(\d{2})", s)
    if not m:
        return None
    try:
        return dt.date(int(m[1]), int(m[2]), int(m[3]))
    except ValueError:
        return None


def parse_amount(text: str) -> int | None:
    """"￥1,234" → 1234、"-1,234" → -1234、"" → None。小数（1.5円）は読めないものとして None"""
    s = _norm(text).replace("¥", "").replace("\\", "").replace(",", "").replace("円", "")
    if s in ("", "-"):
        return None
    if re.fullmatch(r"[+\-]?\d+", s):
        return int(s)
    if re.fullmatch(r"\(\d+\)", s):  # (1234) をマイナスとして書く形
        return -int(s[1:-1])
    return None


def row_hash(source: str, date: dt.date, description: str, amount: int, direction: str, occurrence: int) -> str:
    """同じ日に同じお店で同じ金額を2回使うこともあるので、何回目かも指紋に入れる"""
    key = f"{source}|{date.isoformat()}|{_norm(description)}|{amount}|{direction}|{occurrence}"
    return hashlib.sha256(key.encode()).hexdigest()


# ───────── 4. まとめて読む ─────────
def parse(raw: bytes, source: str, mapping_fallback=None) -> list[Row]:
    """CSV → 行の一覧。mapping_fallback(header, samples) は、見出しで見分けられないときに使う（AI）"""
    text = decode(raw)
    records = [r for r in csv.reader(io.StringIO(text)) if any(c.strip() for c in r)]
    if len(records) < 2:
        raise CsvError("中身が見つかりませんでした。見出しの行と、明細の行がある CSV か確かめてね")

    # 見出しの前に、口座番号などの行があることもあるので、最初の10行から見出しをさがす
    mapping = None
    start = 0
    for i, rec in enumerate(records[:10]):
        mapping = detect_mapping(rec)
        if mapping:
            start = i + 1
            break
    if mapping is None and mapping_fallback is not None:
        mapping, start = mapping_fallback(records[:10])
    if mapping is None:
        raise CsvError("日付・内容・金額の列が見つかりませんでした。銀行やカードのサイトから書き出した CSV か確かめてね")

    body = records[start:]
    if len(body) > MAX_ROWS:
        raise CsvError(f"行が多すぎます（{MAX_ROWS}行まで）。期間を分けて書き出してみてね")

    rows: list[Row] = []
    seen: dict[tuple, int] = {}
    for rec in body:
        def cell(i: int | None) -> str:
            return rec[i] if i is not None and i < len(rec) else ""

        date = parse_date(cell(mapping.date))
        if date is None:
            continue  # 合計の行などは飛ばす
        description = unicodedata.normalize("NFKC", cell(mapping.description)).strip()[:100]
        if mapping.signed is not None:
            n = parse_amount(cell(mapping.signed))
            if not n:
                continue
            amount, direction = abs(n), ("in" if n > 0 else "out")
        else:
            out = parse_amount(cell(mapping.out)) if mapping.out is not None else None
            inn = parse_amount(cell(mapping.in_)) if mapping.in_ is not None else None
            if out:
                # カードの返金（マイナスの利用）は「入ってきた」として扱う
                amount, direction = abs(out), ("out" if out > 0 else "in")
            elif inn:
                amount, direction = abs(inn), "in"
            else:
                continue
        key = (date, _norm(description), amount, direction)
        seen[key] = seen.get(key, 0) + 1
        rows.append(Row(
            row_id=len(rows) + 1,
            date=date.isoformat(),
            description=description,
            amount=amount,
            direction=direction,
            row_hash=row_hash(source, date, description, amount, direction, seen[key]),
        ))
    if not rows:
        raise CsvError("取りこめる明細の行がありませんでした")
    return rows


# ───────── 5. 確認画面に出す（科目の候補をつける） ─────────
PAID_FROM = {"personal": "2900", "business": "1200"}  # 出ていったお金：どこから払ったか
DEPOSIT_TO = {"personal": "1900", "business": "1200"}  # 入ってきたお金：どこに入ったか
SALES = "4100"
REVENUE_CODES = {"4100", "4900"}
SUGGEST = 0.5  # AI の自信がこれ以上で、仕事っぽいなら、最初から✅をつけておく


def ai_mapping(records):
    """見出しで見分けられないときに、Gemini に列を聞く"""
    import traceback

    from . import gemini

    try:
        found = gemini.detect_columns(records)
    except Exception:  # AI が止まっていても「列が見つからない」として案内する
        traceback.print_exc()
        found = None
    if not found:
        return None, 0
    a, start = found

    def pick(k):
        return a[k] if isinstance(a.get(k), int) and a[k] >= 0 else None

    return Mapping(date=a["date"], description=a["description"], out=pick("out"), in_=pick("in"), signed=pick("signed")), start


def preview(con, user_id: str, raw: bytes, source: str, *, filename: str, classifier, store, mapper=ai_mapping) -> dict:
    from . import ledger, receipts

    if source not in PAID_FROM:
        raise ledger.ValidationError("どこの明細かを選んでください")
    try:
        rows = parse(raw, source, mapping_fallback=mapper)
    except CsvError as e:
        raise ledger.ValidationError(str(e)) from None

    # もう取りこんだ行
    hashes = [r.row_hash for r in rows]
    done = {h for (h,) in con.run(
        "select import_row_hash from journal_entries where import_row_hash = any(cast(:h as text[]))", h=hashes
    )}
    # 覚えたお店
    rules = {k: c for k, c in con.run("select partner_key, account_code from partner_rules")}
    expense = [a for a in ledger.list_accounts(con) if a["kind"] == "expense"]
    expense_codes = {a["code"] for a in expense}

    unknown = sorted({r.description for r in rows if r.direction == "out" and r.row_hash not in done
                      and receipts.partner_key(r.description) not in rules})[:200]
    ai = classifier(unknown, expense) if unknown else {}

    out_rows = []
    for r in rows:
        item = r.to_dict()
        duplicate = r.row_hash in done
        if r.direction == "in":
            item.update(account_code=SALES, include=(source == "business" and not duplicate),
                        reason="入ってきたお金。仕事の報酬なら✅をつけてね")
        else:
            rule = rules.get(receipts.partner_key(r.description))
            guess = ai.get(r.description, {})
            if rule:
                item.update(account_code=rule, include=not duplicate, reason="前に選んだ科目です")
            else:
                code = guess.get("account_code") if guess.get("account_code") in expense_codes else "5900"
                likely = bool(guess.get("business_likely")) and float(guess.get("confidence") or 0) >= SUGGEST
                item.update(account_code=code, include=likely and not duplicate,
                            reason="AI のおすすめ（仕事っぽい）" if likely else "仕事の分なら✅をつけてね")
        item["duplicate"] = duplicate
        if duplicate:
            item["reason"] = "もう取りこみ済みです"
        out_rows.append(item)

    import_id = con.run(
        "insert into import_files (user_id, kind, via, s3_key, status, ai_result)"
        " values (:u, 'csv', 'web', '', 'needs_review', cast(:r as jsonb)) returning id",
        u=user_id, r=json.dumps({"source": source, "filename": filename[:100], "rows": out_rows}, ensure_ascii=False),
    )[0][0]
    key = f"csv/{user_id}/{import_id}.csv"
    store(key, raw, "text/csv")  # 元の CSV もとっておく（あとで見なおせるように）
    con.run("update import_files set s3_key = :k where id = :id", k=key, id=import_id)
    return {"import_id": str(import_id), "source": source, "rows": out_rows}


# ───────── 6. ✅の行を取りこむ ─────────
def commit(con, user_id: str, import_id: str, choices: list) -> dict:
    import uuid

    from . import ledger, receipts

    try:
        import_id = str(uuid.UUID(str(import_id)))
    except ValueError:
        raise ledger.NotFound() from None
    found = con.run(
        "select status, ai_result from import_files where id = cast(:id as uuid) and kind = 'csv'", id=import_id
    )
    if not found:
        raise ledger.NotFound()
    status, data = found[0]
    data = data if isinstance(data, dict) else json.loads(data)
    if status == "done":
        raise ledger.ValidationError("このCSVはもう取りこみ済みです")
    if not isinstance(choices, list):
        raise ledger.ValidationError("送られてきた形がおかしいです")

    rows = {r["row_id"]: r for r in data["rows"]}
    expense_codes = {a["code"] for a in ledger.list_accounts(con) if a["kind"] == "expense"}
    source = data["source"]
    created = skipped = 0
    for choice in choices:
        row = rows.get(choice.get("row_id")) if isinstance(choice, dict) else None
        if not row or not choice.get("include") or row["duplicate"]:
            skipped += 1
            continue
        code = str(choice.get("account_code", row["account_code"]))
        allowed = REVENUE_CODES if row["direction"] == "in" else expense_codes
        if code not in allowed:
            raise ledger.ValidationError(f"{row['date']} {row['description']} の科目がおかしいです")
        if row["direction"] == "out":
            lines = [{"side": "debit", "account_code": code, "amount": row["amount"]},
                     {"side": "credit", "account_code": PAID_FROM[source], "amount": row["amount"]}]
        else:
            lines = [{"side": "debit", "account_code": DEPOSIT_TO[source], "amount": row["amount"]},
                     {"side": "credit", "account_code": code, "amount": row["amount"]}]
        # 同じ行がほかの取りこみで先に入っていたら飛ばす（二重防止）
        if con.run("select 1 from journal_entries where import_row_hash = :h", h=row["row_hash"]):
            skipped += 1
            continue
        entry = ledger.create_entry(con, user_id, {
            "entry_date": row["date"], "description": "", "partner": row["description"],
            "status": "confirmed", "source": "csv", "lines": lines,
        })
        con.run(
            "update journal_entries set import_file_id = cast(:f as uuid), import_row_hash = :h where id = cast(:e as uuid)",
            f=import_id, h=row["row_hash"], e=entry["id"],
        )
        if row["direction"] == "out" and row["description"]:
            con.run(
                "insert into partner_rules (user_id, partner_key, account_code) values (:u, :k, :c)"
                " on conflict (user_id, partner_key) do update set account_code = excluded.account_code, updated_at = now()",
                u=user_id, k=receipts.partner_key(row["description"]), c=code,
            )
        created += 1
    con.run("update import_files set status = 'done', updated_at = now() where id = cast(:id as uuid)", id=import_id)
    ledger._audit(con, user_id, "import.csv", import_id)
    return {"created": created, "skipped": skipped}
