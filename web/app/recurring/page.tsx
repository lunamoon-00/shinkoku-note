"use client";

// 毎月の固定費（くり返し設定）。1回登録すると、毎月その日に自動で記録する。

import { useMemo, useState, type FormEvent } from "react";
import { RequireSession } from "@/components/session";
import { Button, Card, Choice, EmptyState, Field, Help, Money, Notice, PageTitle, Spinner, cx, inputClass } from "@/components/ui";
import { useLoad } from "@/components/use-load";
import { api, ApiError } from "@/lib/api";
import { parseYen, todayIso, yen } from "@/lib/format";
import type { Account, RecurringInput, RecurringRule } from "@/lib/types";

const thisMonth = () => todayIso().slice(0, 7);
const janOfThisYear = () => `${todayIso().slice(0, 4)}-01`;

function blank(): RecurringInput {
  return { name: "", account_code: "", amount: 0, business_ratio: 100, day_of_month: 27, paid_from: "personal", start_month: janOfThisYear(), end_month: null };
}

/** よく使うものを1回押しで入れる */
const PRESETS: { label: string; icon: string; input: Partial<RecurringInput> }[] = [
  { label: "家賃", icon: "🏠", input: { name: "家賃", account_code: "5050", business_ratio: 30 } },
  { label: "スマホ代", icon: "📱", input: { name: "スマホ代", account_code: "5140", business_ratio: 50 } },
  { label: "ネット代", icon: "🌐", input: { name: "インターネット代", account_code: "5140", business_ratio: 50 } },
  { label: "電気代", icon: "💡", input: { name: "電気代", account_code: "5120", business_ratio: 30 } },
  { label: "サブスク", icon: "🧩", input: { name: "", account_code: "5190", business_ratio: 100 } },
];

function Form({ accounts, onSaved }: { accounts: Account[]; onSaved: (message: string) => void }) {
  const [input, setInput] = useState<RecurringInput>(blank());
  const [amountText, setAmountText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; fields: Record<string, string> } | null>(null);
  const expense = useMemo(() => accounts.filter((a) => a.kind === "expense"), [accounts]);
  const monthly = input.amount > 0 ? Math.max(1, Math.floor((input.amount * input.business_ratio + 50) / 100)) : 0;
  const set = (patch: Partial<RecurringInput>) => setInput((v) => ({ ...v, ...patch }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { created } = await api.createRecurring(input);
      setInput(blank());
      setAmountText("");
      onSaved(created > 0 ? `登録しました。${created}か月分をまとめて記録しました` : "登録しました。記録日になったら自動で記録します");
    } catch (err) {
      if (err instanceof ApiError) {
        setError({ message: err.message, fields: Object.fromEntries(err.details.map((d) => [d.field, d.message])) });
      } else setError({ message: "保存できませんでした", fields: {} });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="flex flex-col gap-5">
      <h2 className="font-bold">新しく登録する</h2>
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <button key={p.label} type="button" onClick={() => set(p.input)}
            className="rounded-full bg-surface-2 px-3.5 py-2 text-[15px] font-bold transition hover:bg-accent-soft">
            <span aria-hidden>{p.icon}</span> {p.label}
          </button>
        ))}
      </div>
      <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
        <Field label="名前" htmlFor="r-name" error={error?.fields.name}>
          <input id="r-name" className={inputClass} maxLength={50} value={input.name} onChange={(e) => set({ name: e.target.value })} placeholder="例：家賃" />
        </Field>
        <Field label="何のお金？" htmlFor="r-account" error={error?.fields.account_code}>
          <select id="r-account" className={cx(inputClass, "appearance-auto")} value={input.account_code} onChange={(e) => set({ account_code: e.target.value })}>
            <option value="">選んでください</option>
            {expense.map((a) => <option key={a.code} value={a.code}>{a.friendly_name}（{a.name}）</option>)}
          </select>
        </Field>
        <Field label="毎月の金額（全額）" htmlFor="r-amount" error={error?.fields.amount}>
          <input id="r-amount" inputMode="numeric" className={cx(inputClass, "num text-right text-xl font-bold")} value={amountText} placeholder="0"
            onChange={(e) => { setAmountText(e.target.value); set({ amount: parseYen(e.target.value) }); }} />
        </Field>
        <Field
          label={`仕事で使う割合：${input.business_ratio}%`}
          htmlFor="r-ratio"
          error={error?.fields.business_ratio}
          help={<Help title="家事按分（かじあんぶん）">家で仕事をしていると、家賃や電気代の一部は仕事のためのお金です。仕事で使っている割合だけを経費にします。割合は、仕事で使う部屋の広さや時間など、説明できる決め方にしておきましょう。</Help>}
        >
          <input id="r-ratio" type="range" min={1} max={100} step={1} value={input.business_ratio}
            onChange={(e) => set({ business_ratio: Number(e.target.value) })} className="w-full accent-[var(--accent)]" />
          {monthly > 0 && (
            <p className="rounded-2xl bg-surface-2 p-3">
              毎月 <Money value={monthly} /> を経費として記録します
              {input.business_ratio < 100 && <span className="block text-sm text-sub">{yen(input.amount)} × {input.business_ratio}%</span>}
            </p>
          )}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="毎月何日？" htmlFor="r-day" error={error?.fields.day_of_month} hint="31日なら月末">
            <select id="r-day" className={cx(inputClass, "appearance-auto")} value={input.day_of_month} onChange={(e) => set({ day_of_month: Number(e.target.value) })}>
              {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d === 31 ? "月末" : `${d}日`}</option>)}
            </select>
          </Field>
          <Field label="いつから？" htmlFor="r-start" error={error?.fields.start_month} hint="過去の月ならまとめて記録">
            <input id="r-start" type="month" className={inputClass} value={input.start_month} max={thisMonth()} onChange={(e) => set({ start_month: e.target.value })} />
          </Field>
        </div>
        <Field label="どのお金で払う？" error={error?.fields.paid_from}>
          <Choice
            name="r-paid"
            value={input.paid_from}
            onChange={(paid_from) => set({ paid_from })}
            options={[
              { value: "personal", label: "自分の口座・カード", hint: "仕事用に分けていないお金" },
              { value: "business", label: "仕事用の口座" },
            ]}
          />
        </Field>
        {error && <Notice tone="danger" title={error.message} />}
        <Button type="submit" loading={busy} full>登録する</Button>
      </form>
    </Card>
  );
}

function RuleCard({ rule, accounts, onChanged }: { rule: RecurringRule; accounts: Account[]; onChanged: (message?: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const account = accounts.find((a) => a.code === rule.account_code);

  async function toggle() {
    setBusy(true);
    try {
      const { created } = await api.setRecurringActive(rule.id, !rule.active);
      onChanged(created ? `${created}か月分を記録しました` : undefined);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    try {
      await api.deleteRecurring(rule.id);
      onChanged("消しました（もう記録した分は、帳簿に残っています）");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className={cx("flex flex-col gap-3", !rule.active && "opacity-60")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-bold">{rule.name}{!rule.active && <span className="ml-2 rounded-full bg-surface-2 px-2 text-xs text-sub">お休み中</span>}</p>
          <p className="text-sm text-sub">
            {account?.friendly_name}・毎月{rule.day_of_month === 31 ? "月末" : `${rule.day_of_month}日`}・{rule.start_month.replace("-", "年")}月から
          </p>
        </div>
        <div className="text-right">
          <Money value={rule.monthly_expense} tone="out" />
          {rule.business_ratio < 100 && <p className="text-xs text-sub">{yen(rule.amount)} の {rule.business_ratio}%</p>}
        </div>
      </div>
      {!confirming ? (
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => void toggle()} loading={busy}>{rule.active ? "お休みする" : "再開する"}</Button>
          <Button variant="ghost" onClick={() => setConfirming(true)}>消す</Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-sub">消すと、これからは記録しません（もう記録した分は残ります）</p>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setConfirming(false)}>やめる</Button>
            <Button variant="danger" onClick={() => void remove()} loading={busy}>消す</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function Recurring() {
  const [state, reload] = useLoad(async () => {
    const [rules, accounts] = await Promise.all([api.recurring(), api.accounts()]);
    return { rules, accounts };
  });
  const [message, setMessage] = useState("");

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-5">
      <PageTitle title="毎月の固定費" lead="家賃・スマホ代・サブスクなどを1回登録すると、毎月その日に自動で記録します" />
      {message && <Notice tone="success" title={message} />}
      {state.status === "loading" && <div className="py-10 text-center text-sub"><Spinner label="読みこんでいます…" /></div>}
      {state.status === "error" && (
        <div className="flex flex-col gap-3">
          <Notice tone="danger" title="読みこめませんでした">{state.message}</Notice>
          <Button variant="secondary" onClick={reload}>もう一度ためす</Button>
        </div>
      )}
      {state.status === "ready" && (
        <>
          {state.data.rules.length === 0 ? (
            <EmptyState icon="🔁" title="まだ登録がありません">下から、毎月払っているものを登録してね</EmptyState>
          ) : (
            <ul className="flex flex-col gap-3">
              {state.data.rules.map((r) => (
                <li key={r.id}>
                  <RuleCard rule={r} accounts={state.data.accounts} onChanged={(m) => { if (m) setMessage(m); reload(); }} />
                </li>
              ))}
            </ul>
          )}
          <Form accounts={state.data.accounts} onSaved={(m) => { setMessage(m); reload(); }} />
        </>
      )}
    </div>
  );
}

export default function RecurringPage() {
  return (
    <RequireSession>
      <Recurring />
    </RequireSession>
  );
}
