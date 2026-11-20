"use client";

import Link from "next/link";
import { EntryList } from "@/components/entry-list";
import { RequireSession, useSession } from "@/components/session";
import { ButtonLink, Button, Card, EmptyState, Help, Money, Notice, Spinner } from "@/components/ui";
import { useLoad } from "@/components/use-load";
import { api } from "@/lib/api";

function greeting(hour: number) {
  if (hour < 10) return "おはよう";
  if (hour < 18) return "こんにちは";
  return "おつかれさま";
}

function Home() {
  const { profile } = useSession();
  const year = new Date().getFullYear();
  const [state, reload] = useLoad(async () => {
    const [summary, entries] = await Promise.all([api.summary(year), api.entries(year)]);
    return { summary, recent: [...entries].reverse().slice(0, 5), count: entries.length };
  }, year);

  return (
    <div className="flex flex-col gap-5">
      <header>
        <p className="text-sub">{greeting(new Date().getHours())}{profile.display_name && `、${profile.display_name}さん`}</p>
        <h1 className="text-2xl font-bold">{year}年の帳簿</h1>
      </header>

      {state.status === "loading" && (
        <div className="py-10 text-center text-sub"><Spinner label="読みこんでいます…" /></div>
      )}
      {state.status === "error" && (
        <div className="flex flex-col gap-3">
          <Notice tone="danger" title="読みこめませんでした">{state.message}</Notice>
          <Button variant="secondary" onClick={reload}>もう一度ためす</Button>
        </div>
      )}
      {state.status === "ready" && (
        <>
          <Card>
            <p className="text-sm font-bold text-sub">
              もうけの目安（売上 − 経費）
              <Help title="もうけの目安">
                確定申告では「所得」と呼びます。この金額から、国民年金などの控除を引いたものに税金がかかります。下書き（確認待ち）の記録は入っていません。
              </Help>
            </p>
            <p className="mt-1 text-4xl"><Money value={state.data.summary.income} /></p>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className="rounded-2xl bg-in-soft p-3">
                <p className="text-sm text-sub">入ってきたお金（売上）</p>
                <p className="text-xl"><Money value={state.data.summary.revenue} tone="in" /></p>
              </div>
              <div className="rounded-2xl bg-out-soft p-3">
                <p className="text-sm text-sub">使ったお金（経費）</p>
                <p className="text-xl"><Money value={state.data.summary.expense} tone="out" /></p>
              </div>
            </div>
          </Card>

          <ButtonLink href="/record/" full>＋ 記録する</ButtonLink>

          <Card>
            <div className="mb-1 flex items-center justify-between">
              <h2 className="font-bold">最近の記録</h2>
              {state.data.count > 0 && (
                <Link href="/entries/" className="text-sm font-bold text-accent">すべて見る（{state.data.count}件）</Link>
              )}
            </div>
            {state.data.recent.length > 0 ? (
              <EntryList entries={state.data.recent} />
            ) : (
              <EmptyState icon="🌱" title="まだ記録がありません">
                最初の1件を入れてみましょう。レシート1枚からでOK
              </EmptyState>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

export default function HomePage() {
  return (
    <RequireSession>
      <Home />
    </RequireSession>
  );
}
