// API とやりとりするデータの形（api/shinkoku/ledger.py と同じ形）

export type Side = "debit" | "credit";
export type Kind = "asset" | "liability" | "equity" | "revenue" | "expense";

export interface Account {
  code: string;
  name: string;
  friendly_name: string;
  description: string;
  kind: Kind;
  normal_side: Side;
  white_line: string | null;
}

export interface EntryLineInput {
  side: Side;
  account_code: string;
  amount: number;
}

export interface EntryLine extends EntryLineInput {
  account_name: string;
  friendly_name: string;
}

export type EntryStatus = "draft" | "confirmed";

export interface EntryInput {
  entry_date: string;
  description: string;
  partner: string;
  status: EntryStatus;
  lines: EntryLineInput[];
}

export interface Entry {
  id: string;
  entry_date: string;
  description: string;
  partner: string;
  status: EntryStatus;
  source: "manual" | "csv" | "receipt" | "recurring";
  created_at: string;
  updated_at: string;
  lines: EntryLine[];
  total: number;
  has_receipt: boolean;
}

export interface Summary {
  year: number;
  revenue: number;
  expense: number;
  income: number;
  accounts: {
    code: string;
    name: string;
    friendly_name: string;
    kind: Kind;
    white_line: string | null;
    balance: number;
  }[];
}

export interface Profile {
  display_name: string;
  filing_type: "white" | "blue";
  mode: "freee" | "in_app";
  business_name: string;
  onboarded: boolean;
}

export interface LineStatus {
  linked: boolean;
  linked_at: string | null;
}

export interface CsvRow {
  row_id: number;
  date: string;
  description: string;
  amount: number;
  direction: "in" | "out";
  account_code: string;
  include: boolean;
  duplicate: boolean;
  reason: string;
}

export interface CsvPreview {
  import_id: string;
  source: "personal" | "business";
  rows: CsvRow[];
}

export interface RecurringRule {
  id: string;
  name: string;
  account_code: string;
  amount: number;
  business_ratio: number;
  day_of_month: number;
  paid_from: "personal" | "business";
  start_month: string; // "2026-01"
  end_month: string | null;
  active: boolean;
  monthly_expense: number;
}

export type RecurringInput = Omit<RecurringRule, "id" | "active" | "monthly_expense">;
