// 「ふだんの言葉の入力」と「仕訳（借方・貸方）」を行き来する。
// 画面では借方・貸方を見せず、「仕事でお金を使った」「報酬が入った」を選んでもらう。

import type { Entry, EntryInput, EntryLineInput } from "./types";

/** よく使う科目の番号（api/shinkoku/migrations/0002_accounts.sql と同じ） */
export const CODES = {
  cash: "1100", // 現金
  businessBank: "1200", // 普通預金（仕事の口座）
  ownerDrawing: "1900", // 事業主貸（仕事のお金を生活に使った／源泉徴収分）
  ownerContribution: "2900", // 事業主借（生活のお金で仕事の物を買った）
  sales: "4100", // 売上
} as const;

/** 経費を払ったお金の出どころ */
export type PaidFrom = "personal" | "businessBank" | "cash";
export const PAID_FROM: Record<PaidFrom, { label: string; hint: string; code: string }> = {
  personal: {
    label: "自分のお財布・個人の口座・個人のカード",
    hint: "仕事用に分けていないお金から払ったとき。いちばんよくあるパターン",
    code: CODES.ownerContribution,
  },
  businessBank: {
    label: "仕事用の口座",
    hint: "仕事専用に分けている銀行口座から払ったとき",
    code: CODES.businessBank,
  },
  cash: {
    label: "仕事用の現金",
    hint: "仕事専用に分けている現金から払ったとき",
    code: CODES.cash,
  },
};

/** 報酬が振り込まれた先 */
export type DepositTo = "businessBank" | "personal";
export const DEPOSIT_TO: Record<DepositTo, { label: string; hint: string; code: string }> = {
  businessBank: {
    label: "仕事用の口座",
    hint: "仕事専用に分けている銀行口座",
    code: CODES.businessBank,
  },
  personal: {
    label: "個人の口座",
    hint: "生活用と分けていない口座",
    code: CODES.ownerDrawing,
  },
};

export interface ExpenseForm {
  kind: "expense";
  date: string;
  amount: number;
  accountCode: string;
  paidFrom: PaidFrom;
  partner: string;
  memo: string;
}

export interface IncomeForm {
  kind: "income";
  date: string;
  /** 報酬（源泉徴収される前の金額） */
  gross: number;
  /** 実際に振り込まれた金額 */
  received: number;
  depositTo: DepositTo;
  partner: string;
  memo: string;
}

export interface AdvancedForm {
  kind: "advanced";
  date: string;
  amount: number;
  debitCode: string;
  creditCode: string;
  partner: string;
  memo: string;
}

export type EntryForm = ExpenseForm | IncomeForm | AdvancedForm;

/** 源泉徴収された金額（＝報酬 − 振り込まれた金額） */
export function withholdingOf(form: Pick<IncomeForm, "gross" | "received">): number {
  return form.gross - form.received;
}

export interface FormProblem {
  field: string;
  message: string;
}

const isYen = (n: number) => Number.isInteger(n) && n > 0;

/** 画面の入力チェック（APIでも同じチェックをするが、すぐ教えてあげるため） */
export function checkForm(form: EntryForm): FormProblem[] {
  const problems: FormProblem[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date)) problems.push({ field: "date", message: "日付を選んでください" });
  if (form.kind === "expense") {
    if (!isYen(form.amount)) problems.push({ field: "amount", message: "金額を1円以上で入れてください" });
    if (!form.accountCode) problems.push({ field: "accountCode", message: "何に使ったかを選んでください" });
  } else if (form.kind === "income") {
    if (!isYen(form.gross)) problems.push({ field: "gross", message: "報酬を1円以上で入れてください" });
    if (!isYen(form.received)) {
      problems.push({ field: "received", message: "振り込まれた金額を1円以上で入れてください" });
    } else if (form.received > form.gross) {
      problems.push({ field: "received", message: "振り込まれた金額が、報酬より多くなっています" });
    }
  } else {
    if (!isYen(form.amount)) problems.push({ field: "amount", message: "金額を1円以上で入れてください" });
    if (!form.debitCode) problems.push({ field: "debitCode", message: "借方の科目を選んでください" });
    if (!form.creditCode) problems.push({ field: "creditCode", message: "貸方の科目を選んでください" });
    if (form.debitCode && form.debitCode === form.creditCode) {
      problems.push({ field: "creditCode", message: "借方と貸方に同じ科目は使えません" });
    }
  }
  return problems;
}

/** 同じ側・同じ科目の行はまとめる（例：個人の口座に入金＋源泉徴収 → どちらも事業主貸） */
function mergeLines(lines: EntryLineInput[]): EntryLineInput[] {
  const merged = new Map<string, EntryLineInput>();
  for (const line of lines) {
    if (line.amount <= 0) continue;
    const key = `${line.side}:${line.account_code}:${line.tag ?? ""}`; // 源泉徴収の印がちがう行はまとめない
    const found = merged.get(key);
    if (found) found.amount += line.amount;
    else merged.set(key, { ...line });
  }
  return [...merged.values()];
}

/** ふだんの言葉の入力 → API に送る仕訳 */
export function toEntryInput(form: EntryForm): EntryInput {
  const base = { entry_date: form.date, description: form.memo.trim(), partner: form.partner.trim(), status: "confirmed" as const };
  if (form.kind === "expense") {
    return {
      ...base,
      lines: [
        { side: "debit", account_code: form.accountCode, amount: form.amount },
        { side: "credit", account_code: PAID_FROM[form.paidFrom].code, amount: form.amount },
      ],
    };
  }
  if (form.kind === "income") {
    return {
      ...base,
      lines: mergeLines([
        { side: "debit", account_code: DEPOSIT_TO[form.depositTo].code, amount: form.received },
        { side: "debit", account_code: CODES.ownerDrawing, amount: withholdingOf(form), tag: "withholding" },
        { side: "credit", account_code: CODES.sales, amount: form.gross },
      ]),
    };
  }
  return {
    ...base,
    lines: [
      { side: "debit", account_code: form.debitCode, amount: form.amount },
      { side: "credit", account_code: form.creditCode, amount: form.amount },
    ],
  };
}

/** 仕訳 → ふだんの言葉の入力（直すとき）。形が当てはまらなければ「詳しく」で開く */
export function fromEntry(entry: Entry, expenseCodes: Set<string>): EntryForm {
  const debits = entry.lines.filter((l) => l.side === "debit");
  const credits = entry.lines.filter((l) => l.side === "credit");
  const common = { date: entry.entry_date, partner: entry.partner, memo: entry.description };

  // 報酬：貸方が「売上」1行だけ
  if (credits.length === 1 && credits[0].account_code === CODES.sales) {
    const gross = credits[0].amount;
    const withheld = debits.filter((l) => l.tag === "withholding").reduce((s, l) => s + l.amount, 0);
    const deposits = debits.filter((l) => l.tag !== "withholding");
    const onlyKnown = deposits.length === 1 && [CODES.businessBank, CODES.ownerDrawing].includes(deposits[0].account_code as "1200");
    if (onlyKnown) {
      const depositTo = deposits[0].account_code === CODES.businessBank ? "businessBank" : "personal";
      return { kind: "income", ...common, gross, received: gross - withheld, depositTo };
    }
  }

  // 経費：借方が経費1行・貸方が支払い元1行
  if (debits.length === 1 && credits.length === 1 && expenseCodes.has(debits[0].account_code)) {
    const paidFrom = (Object.keys(PAID_FROM) as PaidFrom[]).find((k) => PAID_FROM[k].code === credits[0].account_code);
    if (paidFrom) {
      return { kind: "expense", ...common, amount: debits[0].amount, accountCode: debits[0].account_code, paidFrom };
    }
  }

  // それ以外：借方・貸方1行ずつなら「詳しく」で開く
  return {
    kind: "advanced",
    ...common,
    amount: debits[0]?.amount ?? 0,
    debitCode: debits[0]?.account_code ?? "",
    creditCode: credits[0]?.account_code ?? "",
  };
}

/** 一覧で見せる「何のお金か」 */
export function describeEntry(entry: Entry): { label: string; tone: "in" | "out" | "other" } {
  const sales = entry.lines.find((l) => l.side === "credit" && l.account_code === CODES.sales);
  if (sales) return { label: "報酬", tone: "in" };
  const expense = entry.lines.find((l) => l.side === "debit" && l.account_code.startsWith("5"));
  if (expense) return { label: expense.friendly_name, tone: "out" };
  return { label: entry.lines[0]?.friendly_name ?? "仕訳", tone: "other" };
}
