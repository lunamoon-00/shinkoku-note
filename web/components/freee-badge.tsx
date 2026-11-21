// 記録を直す画面の「freee に送ったか」の表示（freee とつないでいる人だけ）
"use client";

import { api } from "@/lib/api";
import { Notice } from "./ui";
import { useLoad } from "./use-load";

const LABELS = {
  sent: { tone: "success", title: "freee に送りました" },
  pending: { tone: "info", title: "freee に送る予定です（少し待ってね）" },
  failed: { tone: "warn", title: "freee に送れませんでした（あとで自動でやりなおします）" },
  skipped: { tone: "warn", title: "freee には送れない記録です" },
} as const;

export function FreeeBadge({ entryId }: { entryId: string }) {
  const [state] = useLoad(() => api.freeeEntry(entryId), entryId);
  if (state.status !== "ready" || !state.data) return null;
  const label = LABELS[state.data.status];
  return (
    <Notice tone={label.tone} title={label.title}>
      {state.data.error || (state.data.kind === "deal" ? "freee の「取引」に入っています" : state.data.kind === "manual_journal" ? "freee の「振替伝票」に入っています" : undefined)}
    </Notice>
  );
}
