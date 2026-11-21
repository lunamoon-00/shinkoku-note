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
  /** "withholding" ＝ 源泉徴収された分（確定申告で使う） */
  tag?: "withholding";
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

export type FreeeSource = "receipt" | "recurring" | "manual" | "csv";

export type FreeeStatus =
  | { connected: false }
  | {
      connected: true;
      company_id: number;
      company_name: string;
      connected_at: string;
      send_sources: FreeeSource[];
      counts: { pending: number; sent: number; failed: number; skipped: number };
      problems: { entry_id: string; error: string; entry_date: string | null; partner: string }[];
    };

export interface FreeeEntrySync {
  status: "pending" | "sent" | "failed" | "skipped";
  error: string;
  kind: "deal" | "manual_journal" | null;
  freee_id: number | null;
}

export type Disability = "normal" | "special" | null;

export interface FamilyMember {
  name: string;
  relation: "spouse" | "child" | "parent" | "other";
  birth_date: string | null;
  income: number;
  living_together: boolean;
  disability: Disability;
  is_senjusha: boolean;
}

export interface TaxInputs {
  social_insurance?: number;
  small_business_mutual_aid?: number;
  donations?: number;
  prepaid_tax?: number;
  withholding_extra?: number;
  life_insurance?: { new_general?: number; new_medical?: number; new_pension?: number; old_general?: number; old_pension?: number };
  earthquake_insurance?: { earthquake?: number; old_long_term?: number };
  medical?: { mode: "medical" | "self_medication"; paid?: number; reimbursed?: number };
  tax_credits?: { housing_loan?: number };
  self?: { disability: Disability; widow: boolean; single_parent: boolean; working_student: boolean };
  family?: FamilyMember[];
  salaries?: { payer: string; gross: number; income_after_deduction: number; withheld: number; social_insurance: number }[];
  other_incomes?: { label: string; income: number }[];
  checked?: Record<string, boolean>;
}

export interface TaxResult {
  year: number;
  revenue: number;
  expense: number;
  business_income_before_senjusha: number;
  senjusha_deduction: number;
  business_income: number;
  salary_income: number;
  other_income: number;
  total_income: number;
  total_deductions: number;
  taxable_income: number;
  tax_rate_percent: number;
  income_tax: number;
  tax_credits: number;
  base_income_tax: number;
  reconstruction_tax: number;
  total_tax: number;
  withholding: number;
  prepaid_tax: number;
  payable: number;
  refund: number;
  deductions: Record<string, number>;
  notes: string[];
}

export interface TaxDocument {
  id: string;
  kind: string;
  label: string;
  issuer: string;
  amounts: Record<string, number>;
  total: number;
  created_at: string;
}

export interface FixedAsset {
  id: string;
  name: string;
  acquired_on: string;
  cost: number;
  useful_life: number;
  method: "straight" | "lump3";
  business_ratio: number;
  disposed_on: string | null;
  depreciation?: number;
  expense?: number;
  book_value?: number | null;
}

export interface TaxOverview {
  inputs: TaxInputs;
  documents: TaxDocument[];
  assets: FixedAsset[];
  books: { revenue: number; expense: number; withholding: number; depreciation: number };
  white_lines: { line: string; amount: number }[];
  checklist: { key: string; label: string; done: boolean; warn: string }[];
  result: TaxResult;
  consumption: ConsumptionResult | null;
  sources: Record<string, string>;
}

export interface InvoiceSettings {
  registered: boolean;
  registration_number: string | null;
  registered_on: string | null;
  method: "two_tenths" | "simplified" | "standard";
  business_category: number | null;
}

export interface ConsumptionResult {
  method: InvoiceSettings["method"];
  taxable_sales: number;
  tax_base: number;
  national_tax: number;
  deduction: number;
  payable_national: number;
  payable_local: number;
  payable_total: number;
  notes: string[];
  registered_on: string;
  category_label: string | null;
}
