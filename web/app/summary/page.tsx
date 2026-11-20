"use client";

import { useState } from "react";
import { YearPicker } from "@/components/entry-list";
import { RequireSession } from "@/components/session";
import { Button, Card, EmptyState, Help, Money, Notice, PageTitle, Spinner } from "@/components/ui";
import { useLoad } from "@/components/use-load";
import { api } from "@/lib/api";
import type { Summary } from "@/lib/types";

function Bar({ value, max, tone }: { value: number; max: number; tone: "in" | "out" }) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <div className="h-2 overflow-hidden rounded-full bg-surface-2" aria-hidden>
      <div className={tone === "in" ? "h-full rounded-full bg-in" : "h-full rounded-full bg-out"} style={{ width: `${pct}%` }} />
    </div>
  );
}

function Group({ title, items, tone, help }: { title: string; items: Summary["accounts"]; tone: "in" | "out"; help?: React.ReactNode }) {
  const max = Math.max(0, ...items.map((i) => i.balance));
  const total = items.reduce((s, i) => s + i.balance, 0);
  return (
    <Card>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="font-bold">{title}{help}</h2>
        <Money value={total} tone={tone} />
      </div>
      {items.length === 0 ? (
        <p className="text-sub">まだありません</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {[...items].sort((a, b) => b.balance - a.balance).map((i) => (
            <li key={i.code} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-3">
                <span>
                  {i.friendly_name}
                  <span className="ml-1 text-sm text-sub">（{i.name}）</span>
                </span>
                <Money value={i.balance} />
              </div>
              <Bar value={i.balance} max={max} tone={tone} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function SummaryView() {
  const [year, setYear] = useState(new Date().getFullYear());
  const [state, reload] = useLoad(() => api.summary(year), year);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PageTitle title="集計" lead="確定した記録だけを、科目ごとに合計しています" />
        <YearPicker year={year} onChange={setYear} />
      </div>
      {state.status === "loading" && <div className="py-10 text-center text-sub"><Spinner label="読みこんでいます…" /></div>}
      {state.status === "error" && (
        <div className="flex flex-col gap-3">
          <Notice tone="danger" title="読みこめませんでした">{state.message}</Notice>
          <Button variant="secondary" onClick={reload}>もう一度ためす</Button>
        </div>
      )}
      {state.status === "ready" &&
        (state.data.accounts.length === 0 ? (
          <EmptyState icon="📊" title={`${year}年の確定した記録はまだありません`} />
        ) : (
          <>
            <Card>
              <p className="text-sm font-bold text-sub">もうけの目安（売上 − 経費）</p>
              <p className="mt-1 text-3xl"><Money value={state.data.income} /></p>
            </Card>
            <Group title="入ってきたお金" tone="in" items={state.data.accounts.filter((a) => a.kind === "revenue")} />
            <Group
              title="使ったお金"
              tone="out"
              items={state.data.accounts.filter((a) => a.kind === "expense")}
              help={<Help title="科目ごとの合計">確定申告の書類（収支内訳書）では、この科目ごとの合計を書きます。書類の形にするのは、もうすぐ使えるようになります。</Help>}
            />
          </>
        ))}
    </div>
  );
}

export default function SummaryPage() {
  return (
    <RequireSession>
      <SummaryView />
    </RequireSession>
  );
}
