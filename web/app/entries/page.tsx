"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { EntryList, YearPicker } from "@/components/entry-list";
import { RequireSession } from "@/components/session";
import { Button, ButtonLink, Card, EmptyState, Notice, PageTitle, Spinner } from "@/components/ui";
import { useLoad } from "@/components/use-load";
import { api } from "@/lib/api";

function Entries() {
  const params = useSearchParams();
  const [year, setYear] = useState(new Date().getFullYear());
  const onlyDraft = params.get("status") === "draft";
  const [state, reload] = useLoad(() => api.entries(year, onlyDraft ? "draft" : undefined), `${year}-${onlyDraft}`);
  const saved = params.get("saved");
  const deleted = params.get("deleted");

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PageTitle title="記録の一覧" lead="さわると、くわしく見たり直したりできます" />
        <YearPicker year={year} onChange={setYear} />
      </div>
      <nav className="flex gap-2" aria-label="しぼりこみ">
        {[
          { href: "/entries/", label: "すべて", active: !onlyDraft },
          { href: "/entries/?status=draft", label: "確認待ち", active: onlyDraft },
        ].map((t) => (
          <Link key={t.href} href={t.href} aria-current={t.active ? "page" : undefined}
            className={`rounded-full px-4 py-2 text-[15px] font-bold ${t.active ? "bg-accent text-on-accent" : "bg-surface text-sub shadow-card"}`}>
            {t.label}
          </Link>
        ))}
      </nav>
      {saved && <Notice tone="success" title="記録しました" />}
      {deleted && <Notice tone="success" title="消しました" />}

      {state.status === "loading" && <div className="py-10 text-center text-sub"><Spinner label="読みこんでいます…" /></div>}
      {state.status === "error" && (
        <div className="flex flex-col gap-3">
          <Notice tone="danger" title="読みこめませんでした">{state.message}</Notice>
          <Button variant="secondary" onClick={reload}>もう一度ためす</Button>
        </div>
      )}
      {state.status === "ready" &&
        (state.data.length > 0 ? (
          <Card>
            <p className="text-sm text-sub">{state.data.length}件（新しい順）</p>
            <EntryList entries={[...state.data].reverse()} />
          </Card>
        ) : (
          onlyDraft ? (
            <EmptyState icon="✨" title="確認待ちはありません">LINE で送ったレシートは、自信がないときだけここに入ります</EmptyState>
          ) : (
            <EmptyState icon="📭" title={`${year}年の記録はまだありません`} action={<ButtonLink href="/record/">＋ 記録する</ButtonLink>} />
          )
        ))}
    </div>
  );
}

export default function EntriesPage() {
  return (
    <RequireSession>
      <Suspense>
        <Entries />
      </Suspense>
    </RequireSession>
  );
}
