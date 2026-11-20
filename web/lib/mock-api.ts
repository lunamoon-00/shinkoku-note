// お試しモードのAPI。ブラウザの中だけで、本物のAPI（api/shinkoku）と同じ形の答えを返す。
// データはタブを閉じるまで残る（sessionStorage）。

import accountsJson from "./mock-accounts.json";
import type { Account, Entry, EntryInput, Profile } from "./types";

const accounts = accountsJson as Account[];
const byCode = new Map(accounts.map((a) => [a.code, a]));

interface Db {
  profile: Profile;
  entries: Entry[];
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
  const route = `${method} ${url.pathname.replace(/\/entries\/[^/]+/, "/entries/{id}")}`;
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
          .filter((e) => e.entry_date.startsWith(`${year}-`))
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
