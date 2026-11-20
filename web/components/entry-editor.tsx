// 記録する・直す画面の入力フォーム。
// 「仕事でお金を使った」「報酬が入った」を選ぶだけで、借方・貸方は自動で組み立てる。
"use client";

import { useMemo, useState, type FormEvent } from "react";
import { ApiError } from "@/lib/api";
import {
  checkForm,
  DEPOSIT_TO,
  PAID_FROM,
  toEntryInput,
  withholdingOf,
  type DepositTo,
  type EntryForm,
  type PaidFrom,
} from "@/lib/entry-builder";
import { parseYen, todayIso, yen } from "@/lib/format";
import type { Account, EntryInput } from "@/lib/types";
import { Button, Card, Choice, Field, Help, inputClass, Money, Notice, cx } from "./ui";

type Kind = EntryForm["kind"];

export function blankForm(kind: Kind): EntryForm {
  const common = { date: todayIso(), partner: "", memo: "" };
  if (kind === "expense") return { kind, ...common, amount: 0, accountCode: "", paidFrom: "personal" };
  if (kind === "income") return { kind, ...common, gross: 0, received: 0, depositTo: "businessBank" };
  return { kind, ...common, amount: 0, debitCode: "", creditCode: "" };
}

/** 金額の入力欄（全角・カンマもOK、スマホは数字のキーボード） */
function YenInput({ id, value, onChange, invalid }: { id: string; value: number; onChange: (n: number) => void; invalid?: boolean }) {
  const formatted = value ? value.toLocaleString("ja-JP") : "";
  // 入力中は打った文字のまま、それ以外は「3,300」の形で見せる（外から値が変わっても追いつく）
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <div className="relative">
      <input
        id={id}
        inputMode="numeric"
        autoComplete="off"
        className={cx(inputClass, "num pr-10 text-right text-xl font-bold")}
        aria-invalid={invalid || undefined}
        value={editing ?? formatted}
        placeholder="0"
        onFocus={() => setEditing(formatted)}
        onChange={(e) => {
          setEditing(e.target.value);
          onChange(parseYen(e.target.value));
        }}
        onBlur={() => setEditing(null)}
      />
      <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-sub">円</span>
    </div>
  );
}

/** 科目を選ぶ（ふだんの言葉で。正式な名前はカッコで添える） */
function AccountSelect({ id, accounts, value, onChange, placeholder, invalid }: {
  id: string; accounts: Account[]; value: string; onChange: (code: string) => void; placeholder: string; invalid?: boolean;
}) {
  return (
    <select id={id} className={cx(inputClass, "appearance-auto")} value={value} aria-invalid={invalid || undefined} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {accounts.map((a) => (
        <option key={a.code} value={a.code}>
          {a.friendly_name}（{a.name}）
        </option>
      ))}
    </select>
  );
}

export function EntryEditor({
  accounts,
  initial,
  submitLabel,
  onSubmit,
  allowKindChange = true,
}: {
  accounts: Account[];
  initial: EntryForm;
  submitLabel: string;
  onSubmit: (input: EntryInput) => Promise<void>;
  allowKindChange?: boolean;
}) {
  const [form, setForm] = useState<EntryForm>(initial);
  const [showProblems, setShowProblems] = useState(false);
  const [serverError, setServerError] = useState("");
  const [busy, setBusy] = useState(false);

  const expenseAccounts = useMemo(() => accounts.filter((a) => a.kind === "expense"), [accounts]);
  const problems = checkForm(form);
  const problemOf = (field: string) => (showProblems ? problems.find((p) => p.field === field)?.message : undefined);
  const selected = form.kind === "expense" ? accounts.find((a) => a.code === form.accountCode) : undefined;

  // フォームの一部だけを変える（種類ごとの形を保ったまま）
  const patch = (p: Partial<EntryForm>) => setForm((f) => ({ ...f, ...p }) as EntryForm);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setShowProblems(true);
    setServerError("");
    if (problems.length) return;
    setBusy(true);
    try {
      await onSubmit(toEntryInput(form));
    } catch (err) {
      setServerError(err instanceof ApiError ? [err.message, ...err.details.map((d) => d.message)].join("・") : "保存できませんでした");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
      {allowKindChange && (
        <Card>
          <Field label="どんなお金？">
            <Choice<Kind>
              name="kind"
              value={form.kind}
              onChange={(k) => {
                setShowProblems(false);
                setForm({ ...blankForm(k), date: form.date, partner: form.partner, memo: form.memo });
              }}
              options={[
                { value: "expense", label: "仕事でお金を使った", icon: "🧾", hint: "道具・交通費・スマホ代など（経費）" },
                { value: "income", label: "報酬が入った", icon: "💴", hint: "仕事のお金が振り込まれた（売上）" },
                { value: "advanced", label: "そのほか（詳しく入力）", icon: "🛠️", hint: "借方・貸方を自分で選ぶ。簿記を知っている人向け" },
              ]}
            />
          </Field>
        </Card>
      )}

      <Card className="flex flex-col gap-5">
        <Field label="日付" htmlFor="date" error={problemOf("date")}>
          <input id="date" type="date" className={inputClass} value={form.date} aria-invalid={!!problemOf("date") || undefined}
            onChange={(e) => patch({ date: e.target.value })} />
        </Field>

        {form.kind === "expense" && (
          <>
            <Field label="金額" htmlFor="amount" error={problemOf("amount")}>
              <YenInput id="amount" value={form.amount} invalid={!!problemOf("amount")} onChange={(n) => patch({ amount: n })} />
            </Field>
            <Field
              label="何に使った？"
              htmlFor="account"
              error={problemOf("accountCode")}
              hint={selected ? selected.description : "いちばん近いものを選んでください。迷ったら「そのほかの経費」でOK"}
            >
              <AccountSelect id="account" accounts={expenseAccounts} value={form.accountCode} placeholder="選んでください"
                invalid={!!problemOf("accountCode")} onChange={(code) => patch({ accountCode: code })} />
            </Field>
            <Field label="どのお金で払った？" help={<Help title="どうして聞くの？">仕事用と生活用のお金を分けていない人がほとんどです。その場合は「自分のお財布・個人の口座」を選べばOK。帳簿では「生活のお金で仕事の物を買った（事業主借）」として記録します。</Help>}>
              <Choice<PaidFrom>
                name="paidFrom"
                value={form.paidFrom}
                onChange={(v) => patch({ paidFrom: v })}
                options={(Object.keys(PAID_FROM) as PaidFrom[]).map((k) => ({ value: k, label: PAID_FROM[k].label, hint: PAID_FROM[k].hint }))}
              />
            </Field>
          </>
        )}

        {form.kind === "income" && (
          <>
            <Field
              label="報酬はいくら？"
              htmlFor="gross"
              hint="請求書に書いた金額（税金を引かれる前）"
              error={problemOf("gross")}
            >
              <YenInput id="gross" value={form.gross} invalid={!!problemOf("gross")} onChange={(n) => patch({ gross: n, ...(form.received === 0 || form.received === form.gross ? { received: n } : {}) })} />
            </Field>
            <Field
              label="実際に振り込まれたのはいくら？"
              htmlFor="received"
              hint="通帳やネットバンクに入っていた金額"
              error={problemOf("received")}
              help={<Help title="源泉徴収（げんせんちょうしゅう）">業務委託の報酬は、払う側が先に所得税を差し引いて、残りを振り込むことがあります。この差し引かれた分が「源泉徴収」です。確定申告で計算しなおすと、払いすぎた分が戻ってくることも。報酬と振り込まれた金額の差を、自動で記録します。</Help>}
            >
              <YenInput id="received" value={form.received} invalid={!!problemOf("received")} onChange={(n) => patch({ received: n })} />
            </Field>
            {form.gross > 0 && form.received > 0 && form.received <= form.gross && (
              <div className="rounded-2xl bg-surface-2 p-4">
                {withholdingOf(form) > 0 ? (
                  <p>
                    源泉徴収された税金：<Money value={withholdingOf(form)} />
                    <span className="block text-sm text-sub">確定申告で使うので、自動で記録しておきます</span>
                  </p>
                ) : (
                  <p className="text-sub">源泉徴収はなし（報酬がそのまま振り込まれた）</p>
                )}
              </div>
            )}
            <Field label="どこに振り込まれた？">
              <Choice<DepositTo>
                name="depositTo"
                value={form.depositTo}
                onChange={(v) => patch({ depositTo: v })}
                options={(Object.keys(DEPOSIT_TO) as DepositTo[]).map((k) => ({ value: k, label: DEPOSIT_TO[k].label, hint: DEPOSIT_TO[k].hint }))}
              />
            </Field>
          </>
        )}

        {form.kind === "advanced" && (
          <>
            <Field label="金額" htmlFor="amount" error={problemOf("amount")}>
              <YenInput id="amount" value={form.amount} invalid={!!problemOf("amount")} onChange={(n) => patch({ amount: n })} />
            </Field>
            <Field label="借方（増えた資産・使った費用）" htmlFor="debit" error={problemOf("debitCode")}>
              <AccountSelect id="debit" accounts={accounts} value={form.debitCode} placeholder="選んでください"
                invalid={!!problemOf("debitCode")} onChange={(code) => patch({ debitCode: code })} />
            </Field>
            <Field label="貸方（減った資産・入ってきた収益）" htmlFor="credit" error={problemOf("creditCode")}>
              <AccountSelect id="credit" accounts={accounts} value={form.creditCode} placeholder="選んでください"
                invalid={!!problemOf("creditCode")} onChange={(code) => patch({ creditCode: code })} />
            </Field>
          </>
        )}

        <Field label={form.kind === "income" ? "取引先" : "どこで・だれに？"} htmlFor="partner" hint="なくてもOK">
          <input id="partner" className={inputClass} maxLength={100} value={form.partner} onChange={(e) => patch({ partner: e.target.value })}
            placeholder={form.kind === "income" ? "例：株式会社〇〇" : "例：家電量販店"} />
        </Field>
        <Field label="メモ" htmlFor="memo" hint="あとで見て思い出せるように。なくてもOK">
          <input id="memo" className={inputClass} maxLength={200} value={form.memo} onChange={(e) => patch({ memo: e.target.value })}
            placeholder={form.kind === "income" ? "例：10月分のデザイン料" : "例：USBケーブル"} />
        </Field>
      </Card>

      {showProblems && problems.length > 0 && <Notice tone="danger" title="入力を確かめてください">赤い文字のところを直してください</Notice>}
      {serverError && <Notice tone="danger" title="保存できませんでした">{serverError}</Notice>}

      <Button type="submit" loading={busy} full>
        {submitLabel}
        {form.kind === "expense" && form.amount > 0 && <span className="num font-normal">（{yen(form.amount)}）</span>}
        {form.kind === "income" && form.gross > 0 && <span className="num font-normal">（{yen(form.gross)}）</span>}
      </Button>
    </form>
  );
}
