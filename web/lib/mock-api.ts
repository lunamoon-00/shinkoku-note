// お試しモードのAPI。ブラウザの中だけで、本物のAPI（api/shinkoku）と同じ形の答えを返す。
// データはタブを閉じるまで残る（sessionStorage）。

import accountsJson from "./mock-accounts.json";
import type { Account, CsvRow, Entry, EntryInput, Profile, RecurringRule, TaxInputs } from "./types";

const accounts = accountsJson as Account[];
const byCode = new Map(accounts.map((a) => [a.code, a]));

interface Db {
  profile: Profile;
  entries: Entry[];
  lineLinked?: boolean;
  imports?: Record<string, { source: string; rows: CsvRow[]; done: boolean }>;
  recurring?: RecurringRule[];
  freee?: { sources: string[] };
  tax?: Record<string, TaxInputs>;
}

const KEY = "shinkoku-mock-db";
const empty = (): Db => ({
  profile: { display_name: "", filing_type: "white", mode: "in_app", business_name: "", onboarded: false },
  entries: [],
});

function load(): Db {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Db) : empty();
  } catch {
    return empty();
  }
}
function save(db: Db) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(db));
  } catch {
    /* 保存できなくても動く */
  }
}

const json = (status: number, body: unknown) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const fail = (status: number, code: string, message: string, details: { field: string; message: string }[] = []) =>
  json(status, { error: { code, message, details } });

function validate(input: EntryInput) {
  const details: { field: string; message: string }[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.entry_date ?? "")) details.push({ field: "entry_date", message: "日付は 2026-01-31 の形で入れてください" });
  const lines = Array.isArray(input.lines) ? input.lines : [];
  lines.forEach((l, i) => {
    if (!byCode.has(l.account_code)) details.push({ field: `lines[${i}].account_code`, message: "その科目は見つかりません" });
    if (!Number.isInteger(l.amount) || l.amount <= 0) details.push({ field: `lines[${i}].amount`, message: "金額は1円以上の整数で入れてください" });
  });
  const debit = lines.filter((l) => l.side === "debit").reduce((s, l) => s + l.amount, 0);
  const credit = lines.filter((l) => l.side === "credit").reduce((s, l) => s + l.amount, 0);
  if (!details.length && (debit === 0 || credit === 0 || debit !== credit)) {
    details.push({ field: "lines", message: "借方と貸方の合計が合っていません" });
  }
  return details;
}

function toEntry(id: string, input: EntryInput, prev?: Entry): Entry {
  const now = new Date().toISOString();
  const lines = input.lines.map((l) => {
    const a = byCode.get(l.account_code)!;
    return { ...l, account_name: a.name, friendly_name: a.friendly_name };
  });
  return {
    id,
    entry_date: input.entry_date,
    description: input.description ?? "",
    partner: input.partner ?? "",
    status: input.status ?? "draft",
    source: prev?.source ?? "manual",
    created_at: prev?.created_at ?? now,
    updated_at: now,
    lines,
    total: lines.filter((l) => l.side === "debit").reduce((s, l) => s + l.amount, 0),
    has_receipt: prev?.has_receipt ?? false,
  };
}

/** e2eテストで「DBが起動中」を試すため：true にすると次の1回だけ 503 を返す */
declare global {
  interface Window {
    __mockWakeOnce?: boolean;
  }
}

export async function mockFetch(method: string, path: string, body?: unknown): Promise<Response> {
  await new Promise((r) => setTimeout(r, 150)); // 通信っぽく少し待つ
  if (typeof window !== "undefined" && window.__mockWakeOnce) {
    window.__mockWakeOnce = false;
    return fail(503, "DB_STARTING", "データベースを起こしています。数秒後にもう一度ためしてください");
  }
  const url = new URL(path, "http://mock");
  const db = load();
  const route = `${method} ${url.pathname.replace(/\/entries\/[^/]+/, "/entries/{id}").replace(/\/imports\/(?!csv)[^/]+/, "/imports/{id}").replace(/\/recurring\/[^/]+/, "/recurring/{id}").replace(/\/tax\/\d+/, "/tax/{year}")}`;
  const status = url.searchParams.get("status");
  const id = decodeURIComponent(url.pathname.split("/")[2] ?? "");
  const year = Number(url.searchParams.get("year") ?? new Date().getFullYear());
  const find = () => db.entries.find((e) => e.id === id);

  switch (route) {
    case "GET /me":
      return json(200, db.profile);
    case "PUT /me": {
      const patch = body as Partial<Profile>;
      db.profile = { ...db.profile, ...patch };
      save(db);
      return json(200, db.profile);
    }
    case "GET /accounts":
      return json(200, { accounts });
    case "GET /entries":
      return json(200, {
        entries: db.entries
          .filter((e) => e.entry_date.startsWith(`${year}-`) && (!status || e.status === status))
          .sort((a, b) => a.entry_date.localeCompare(b.entry_date) || a.created_at.localeCompare(b.created_at)),
      });
    case "POST /entries": {
      const details = validate(body as EntryInput);
      if (details.length) return fail(400, "VALIDATION", "入力を確かめてください", details);
      const entry = toEntry(crypto.randomUUID(), body as EntryInput);
      db.entries.push(entry);
      save(db);
      return json(201, entry);
    }
    case "GET /entries/{id}": {
      const e = find();
      return e ? json(200, e) : fail(404, "NOT_FOUND", "見つかりませんでした");
    }
    case "PUT /entries/{id}": {
      const e = find();
      if (!e) return fail(404, "NOT_FOUND", "見つかりませんでした");
      const details = validate(body as EntryInput);
      if (details.length) return fail(400, "VALIDATION", "入力を確かめてください", details);
      const updated = toEntry(e.id, body as EntryInput, e);
      db.entries = db.entries.map((x) => (x.id === e.id ? updated : x));
      save(db);
      return json(200, updated);
    }
    case "POST /entries/{id}/confirm": {
      const e = find();
      if (!e) return fail(404, "NOT_FOUND", "見つかりませんでした");
      e.status = "confirmed";
      save(db);
      return json(200, e);
    }
    case "DELETE /entries/{id}": {
      if (!find()) return fail(404, "NOT_FOUND", "見つかりませんでした");
      db.entries = db.entries.filter((e) => e.id !== id);
      save(db);
      return json(204, null);
    }
    case "POST /imports/csv": {
      // お試しモードの簡単な読み取り（本物は api/shinkoku/csv_import.py）
      const b = body as { content_base64: string; source: string };
      const bytes = Uint8Array.from(atob(b.content_base64), (c) => c.charCodeAt(0));
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        text = new TextDecoder("shift_jis").decode(bytes);
      }
      const lines = text.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split(","));
      const header = lines[0] ?? [];
      const col = (...words: string[]) => header.findIndex((h) => words.some((w) => h.includes(w)));
      const dateCol = col("日付", "利用日", "取引日");
      const descCol = col("店名", "摘要", "内容");
      const outCol = col("支払", "利用金額", "出金");
      const inCol = col("預り", "入金");
      if (dateCol < 0 || descCol < 0 || (outCol < 0 && inCol < 0)) {
        return fail(400, "VALIDATION", "日付・内容・金額の列が見つかりませんでした。銀行やカードのサイトから書き出した CSV か確かめてね");
      }
      const rows: CsvRow[] = lines.slice(1).flatMap((r, i) => {
        const date = (r[dateCol] ?? "").replace(/\//g, "-");
        const out = Number(r[outCol] ?? 0) || 0;
        const inn = Number(r[inCol] ?? 0) || 0;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || (!out && !inn)) return [];
        const direction = out ? "out" : "in";
        return [{
          row_id: i + 1, date, description: r[descCol] ?? "", amount: out || inn, direction,
          account_code: direction === "out" ? "5190" : "4100", include: direction === "out" || b.source === "business",
          duplicate: false, reason: direction === "out" ? "AI のおすすめ（仕事っぽい）" : "入ってきたお金。仕事の報酬なら✅をつけてね",
        } as CsvRow];
      });
      const importId = crypto.randomUUID();
      db.imports = { ...(db.imports ?? {}), [importId]: { source: b.source, rows, done: false } };
      save(db);
      return json(200, { import_id: importId, source: b.source, rows });
    }
    case "POST /imports/{id}/commit": {
      const imp = db.imports?.[id];
      if (!imp) return fail(404, "NOT_FOUND", "見つかりませんでした");
      if (imp.done) return fail(400, "VALIDATION", "このCSVはもう取りこみ済みです");
      const choices = (body as { rows: { row_id: number; include: boolean; account_code: string }[] }).rows;
      let created = 0;
      for (const c of choices) {
        const row = imp.rows.find((r) => r.row_id === c.row_id);
        if (!row || !c.include) continue;
        const from = imp.source === "business" ? "1200" : row.direction === "out" ? "2900" : "1900";
        const lines = row.direction === "out"
          ? [{ side: "debit" as const, account_code: c.account_code, amount: row.amount }, { side: "credit" as const, account_code: from, amount: row.amount }]
          : [{ side: "debit" as const, account_code: from, amount: row.amount }, { side: "credit" as const, account_code: c.account_code, amount: row.amount }];
        db.entries.push({ ...toEntry(crypto.randomUUID(), { entry_date: row.date, description: "", partner: row.description, status: "confirmed", lines }), source: "csv" });
        created++;
      }
      imp.done = true;
      save(db);
      return json(200, { created, skipped: choices.length - created });
    }
    case "GET /recurring":
      return json(200, { rules: db.recurring ?? [] });
    case "POST /recurring": {
      const input = body as Omit<RecurringRule, "id" | "active" | "monthly_expense">;
      if (!input.name || !input.amount || !input.account_code) {
        return fail(400, "VALIDATION", "入力を確かめてください", [{ field: "name", message: "名前を入れてください" }]);
      }
      const rule: RecurringRule = {
        ...input, id: crypto.randomUUID(), active: true,
        monthly_expense: Math.max(1, Math.floor((input.amount * input.business_ratio + 50) / 100)),
      };
      db.recurring = [...(db.recurring ?? []), rule];
      // お試しモード：いつから〜先月までの分を記録する
      const [y, m] = rule.start_month.split("-").map(Number);
      const now = new Date();
      let created = 0;
      for (let d = new Date(y, m - 1, 1); d < new Date(now.getFullYear(), now.getMonth(), 1); d.setMonth(d.getMonth() + 1)) {
        const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(Math.min(rule.day_of_month, 28)).padStart(2, "0")}`;
        const from = rule.paid_from === "business" ? "1200" : "2900";
        db.entries.push({
          ...toEntry(crypto.randomUUID(), { entry_date: date, description: `${rule.name}（${d.getMonth() + 1}月分）`, partner: rule.name, status: "confirmed", lines: [
            { side: "debit", account_code: rule.account_code, amount: rule.monthly_expense },
            { side: "credit", account_code: from, amount: rule.monthly_expense },
          ] }),
          source: "recurring",
        });
        created++;
      }
      save(db);
      return json(201, { rule, created });
    }
    case "PUT /recurring/{id}/active": {
      const rule = db.recurring?.find((r) => r.id === id);
      if (!rule) return fail(404, "NOT_FOUND", "見つかりませんでした");
      rule.active = (body as { active: boolean }).active;
      save(db);
      return json(200, { rule, created: 0 });
    }
    case "DELETE /recurring/{id}":
      db.recurring = (db.recurring ?? []).filter((r) => r.id !== id);
      save(db);
      return json(204, null);
    case "GET /freee":
      return json(200, db.freee
        ? { connected: true, company_id: 1, company_name: "お試し事業所", connected_at: new Date().toISOString(),
            send_sources: db.freee.sources, counts: { pending: 0, sent: 3, failed: 0, skipped: 0 }, problems: [] }
        : { connected: false });
    case "POST /freee/connect":
      // お試しモードでは freee に行かず、すぐ「つながった」ことにして設定画面に戻る
      db.freee = { sources: ["receipt", "recurring", "manual"] };
      db.profile.mode = "freee";
      save(db);
      return json(200, { url: "/settings/?freee=connected" });
    case "PUT /freee/sources":
      if (!db.freee) return fail(404, "NOT_FOUND", "見つかりませんでした");
      db.freee.sources = (body as { sources: string[] }).sources;
      save(db);
      return mockFetch("GET", "/freee");
    case "DELETE /freee":
      delete db.freee;
      db.profile.mode = "in_app";
      save(db);
      return json(204, null);
    case "GET /entries/{id}/freee":
      return json(200, { sync: db.freee ? { status: "sent", error: "", kind: "deal", freee_id: 1 } : null });
    case "GET /tax/{year}":
    case "PUT /tax/{year}/inputs": {
      // お試しモードのかんたんな計算（本物は api/shinkoku/tax.py。ここは画面の確認用）
      const y = String(url.pathname.split("/")[2]);
      if (route.startsWith("PUT")) {
        db.tax = { ...(db.tax ?? {}), [y]: body as TaxInputs };
        save(db);
      }
      const inputs = db.tax?.[y] ?? {};
      const entries = db.entries.filter((e) => e.status === "confirmed" && e.entry_date.startsWith(`${y}-`));
      const sum = (f: (l: Entry["lines"][number]) => boolean) => entries.flatMap((e) => e.lines).filter(f).reduce((s, l) => s + l.amount, 0);
      const revenue = sum((l) => l.side === "credit" && l.account_code.startsWith("4"));
      const expense = sum((l) => l.side === "debit" && l.account_code.startsWith("5"));
      const withholding = sum((l) => l.tag === "withholding");
      const income = Math.max(0, revenue - expense);
      const deductions = { social_insurance: inputs.social_insurance ?? 0, donation: Math.max(0, (inputs.donations ?? 0) - 2000), basic: 1_040_000 };
      const total = Object.values(deductions).reduce((s, v) => s + v, 0);
      const taxable = Math.floor(Math.max(0, income - total) / 1000) * 1000;
      const tax = Math.floor(taxable * 0.05);
      const rec = Math.floor((tax * 21) / 1000);
      const balance = tax + rec - withholding;
      const checked = inputs.checked ?? {};
      const labels: Record<string, string> = { books: "売上と経費の記録", social_insurance: "健康保険・年金など", family: "家族" };
      return json(200, {
        inputs,
        books: { revenue, expense, withholding },
        white_lines: [{ line: "売上（収入）金額", amount: revenue }, { line: "消耗品費", amount: expense }],
        checklist: [{ key: "drafts", label: "確認待ちの記録をぜんぶ確定した", done: true, warn: "" },
          ...Object.entries(labels).map(([key, label]) => ({ key, label, done: !!checked[key], warn: "" }))],
        result: {
          year: Number(y), revenue, expense, business_income_before_senjusha: income, senjusha_deduction: 0, business_income: income, salary_income: 0,
          other_income: 0, total_income: income, total_deductions: total, taxable_income: taxable, tax_rate_percent: taxable ? 5 : 0,
          income_tax: tax, tax_credits: 0, base_income_tax: tax, reconstruction_tax: rec, total_tax: tax + rec, withholding,
          prepaid_tax: 0, payable: balance > 0 ? Math.floor(balance / 100) * 100 : 0, refund: balance < 0 ? -balance : 0,
          deductions, notes: [],
        },
        sources: { basic_deduction: "https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1199.htm" },
      });
    }
    case "GET /review":
      return json(200, { count: db.entries.filter((e) => e.status === "draft").length });
    case "GET /line":
      return json(200, { linked: !!db.lineLinked, linked_at: db.lineLinked ? new Date().toISOString() : null });
    case "POST /line/link-code":
      // お試しモードでは、番号を出したら「つながった」ことにする
      db.lineLinked = true;
      save(db);
      return json(200, { code: "123456", expires_in_minutes: 10 });
    case "DELETE /line":
      db.lineLinked = false;
      save(db);
      return json(204, null);
    case "GET /entries/{id}/receipt": {
      const e = find();
      if (!e?.has_receipt) return fail(404, "NOT_FOUND", "この記録にはレシートの写真がありません");
      return json(200, { url: "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400"><rect width="300" height="400" fill="#fff"/><text x="150" y="200" text-anchor="middle" font-size="20">レシート（お試し）</text></svg>') });
    }
    case "GET /summary": {
      const totals = new Map<string, number>();
      for (const e of db.entries) {
        if (e.status !== "confirmed" || !e.entry_date.startsWith(`${year}-`)) continue;
        for (const l of e.lines) {
          const a = byCode.get(l.account_code)!;
          const sign = l.side === a.normal_side ? 1 : -1;
          totals.set(a.code, (totals.get(a.code) ?? 0) + sign * l.amount);
        }
      }
      const list = accounts
        .filter((a) => totals.has(a.code))
        .map((a) => ({ code: a.code, name: a.name, friendly_name: a.friendly_name, kind: a.kind, white_line: a.white_line, balance: totals.get(a.code)! }));
      const revenue = list.filter((a) => a.kind === "revenue").reduce((s, a) => s + a.balance, 0);
      const expense = list.filter((a) => a.kind === "expense").reduce((s, a) => s + a.balance, 0);
      return json(200, { year, revenue, expense, income: revenue - expense, accounts: list });
    }
  }
  return fail(404, "NOT_FOUND", "その窓口はありません");
}
