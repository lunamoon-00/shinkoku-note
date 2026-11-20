// 「ふだんの言葉の入力」→ 仕訳 の変換が正しいかを確かめる。
// 借方と貸方の合計が必ず合うこと、源泉徴収を自動で記録することが大事。

import { describe, expect, it } from "vitest";
import accounts from "./mock-accounts.json";
import { checkForm, CODES, describeEntry, fromEntry, toEntryInput, withholdingOf, type EntryForm } from "./entry-builder";
import { parseYen, todayIso, yen } from "./format";
import type { Entry } from "./types";

const expenseCodes = new Set(accounts.filter((a) => a.kind === "expense").map((a) => a.code));
const balanced = (input: ReturnType<typeof toEntryInput>) => {
  const sum = (side: string) => input.lines.filter((l) => l.side === side).reduce((s, l) => s + l.amount, 0);
  return sum("debit") === sum("credit");
};
const asEntry = (input: ReturnType<typeof toEntryInput>): Entry => ({
  id: "x", entry_date: input.entry_date, description: input.description, partner: input.partner, status: input.status,
  source: "manual", created_at: "", updated_at: "", total: 0, has_receipt: false,
  lines: input.lines.map((l) => ({ ...l, account_name: "", friendly_name: accounts.find((a) => a.code === l.account_code)!.friendly_name })),
});

describe("経費（仕事でお金を使った）", () => {
  const form: EntryForm = { kind: "expense", date: "2026-01-10", amount: 3300, accountCode: "5190", paidFrom: "personal", partner: " 家電量販店 ", memo: "USBケーブル" };

  it("自分のお金で払った → 消耗品費 / 事業主借", () => {
    const input = toEntryInput(form);
    expect(input.lines).toEqual([
      { side: "debit", account_code: "5190", amount: 3300 },
      { side: "credit", account_code: CODES.ownerContribution, amount: 3300 },
    ]);
    expect(input.partner).toBe("家電量販店");
    expect(balanced(input)).toBe(true);
  });

  it("直すときは同じ入力にもどる", () => {
    expect(fromEntry(asEntry(toEntryInput(form)), expenseCodes)).toEqual({ ...form, partner: "家電量販店" });
  });
});

describe("報酬（報酬が入った）", () => {
  const form: EntryForm = { kind: "income", date: "2026-01-31", gross: 100_000, received: 89_790, depositTo: "businessBank", partner: "A社", memo: "" };

  it("源泉徴収（差額）を自動で記録する", () => {
    expect(withholdingOf(form)).toBe(10_210);
    const input = toEntryInput(form);
    expect(input.lines).toEqual([
      { side: "debit", account_code: CODES.businessBank, amount: 89_790 },
      { side: "debit", account_code: CODES.ownerDrawing, amount: 10_210 },
      { side: "credit", account_code: CODES.sales, amount: 100_000 },
    ]);
    expect(balanced(input)).toBe(true);
  });

  it("源泉徴収がなければ2行だけ", () => {
    expect(toEntryInput({ ...form, received: 100_000 }).lines).toHaveLength(2);
  });

  it("個人の口座に入ったら、事業主貸にまとめる", () => {
    const input = toEntryInput({ ...form, depositTo: "personal" });
    expect(input.lines).toEqual([
      { side: "debit", account_code: CODES.ownerDrawing, amount: 100_000 },
      { side: "credit", account_code: CODES.sales, amount: 100_000 },
    ]);
  });

  it("直すときは同じ入力にもどる", () => {
    expect(fromEntry(asEntry(toEntryInput(form)), expenseCodes)).toEqual(form);
  });

  it("一覧では「報酬」と出る", () => {
    expect(describeEntry(asEntry(toEntryInput(form)))).toEqual({ label: "報酬", tone: "in" });
  });
});

describe("入力チェック", () => {
  it("振り込まれた金額が報酬より多いとおかしい", () => {
    const problems = checkForm({ kind: "income", date: "2026-01-31", gross: 1000, received: 2000, depositTo: "businessBank", partner: "", memo: "" });
    expect(problems.map((p) => p.field)).toEqual(["received"]);
  });

  it("金額0・科目なし・日付なしを教える", () => {
    const problems = checkForm({ kind: "expense", date: "", amount: 0, accountCode: "", paidFrom: "personal", partner: "", memo: "" });
    expect(problems.map((p) => p.field)).toEqual(["date", "amount", "accountCode"]);
  });

  it("詳しく入力で、借方と貸方が同じ科目はだめ", () => {
    const problems = checkForm({ kind: "advanced", date: "2026-01-01", amount: 1, debitCode: "1200", creditCode: "1200", partner: "", memo: "" });
    expect(problems.map((p) => p.field)).toEqual(["creditCode"]);
  });

  it("形が当てはまらない仕訳は「詳しく」で開く", () => {
    const entry = asEntry({ entry_date: "2026-01-01", description: "", partner: "", status: "confirmed", lines: [
      { side: "debit", account_code: "1200", amount: 500 }, { side: "credit", account_code: "1100", amount: 500 },
    ] });
    expect(fromEntry(entry, expenseCodes)).toMatchObject({ kind: "advanced", debitCode: "1200", creditCode: "1100", amount: 500 });
  });
});

describe("金額と日付の見せ方", () => {
  it("円の表示", () => expect(yen(1234567)).toBe("1,234,567円"));
  it("全角やカンマの入力も数にする", () => {
    expect(parseYen("３，３００")).toBe(3300);
    expect(parseYen("3,300円")).toBe(3300);
    expect(parseYen("1.5")).toBe(0);
    expect(parseYen("")).toBe(0);
  });
  it("今日は日本時間で数える", () => expect(todayIso(new Date("2026-11-20T16:00:00Z"))).toBe("2026-11-21"));
});
