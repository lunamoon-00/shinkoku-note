"use client";

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
  const [state, reload] = useLoad(() => api.entries(year), year);
  const saved = params.get("saved");
  const deleted = params.get("deleted");

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PageTitle title="記録の一覧" lead="さわると、くわしく見たり直したりできます" />
        <YearPicker year={year} onChange={setYear} />
      </div>
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
          <EmptyState icon="📭" title={`${year}年の記録はまだありません`} action={<ButtonLink href="/record/">＋ 記録する</ButtonLink>} />
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
