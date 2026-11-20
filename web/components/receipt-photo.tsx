// 記録についているレシートの写真（5分だけ見られるURLを、そのつど API からもらう）
"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { Card, Spinner } from "./ui";
import { useLoad } from "./use-load";

export function ReceiptPhoto({ entryId }: { entryId: string }) {
  const [state] = useLoad(() => api.receiptUrl(entryId), entryId);
  const [large, setLarge] = useState(false);
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="font-bold">送ったレシート</h2>
      {state.status === "loading" && <Spinner label="写真を読みこんでいます…" />}
      {state.status === "error" && <p className="text-sub">写真を読みこめませんでした</p>}
      {state.status === "ready" && (
        <button type="button" onClick={() => setLarge((v) => !v)} className="self-start" aria-label={large ? "写真を小さくする" : "写真を大きくする"}>
          {/* eslint-disable-next-line @next/next/no-img-element -- S3 の署名つきURLなので、Next の画像最適化は使わない */}
          <img src={state.data} alt="送ったレシートの写真" className={`rounded-2xl border border-line object-contain ${large ? "max-h-[80vh] w-full" : "max-h-64"}`} />
        </button>
      )}
      <p className="text-sm text-sub">写真を見ながら、金額や科目が合っているか確かめてね</p>
    </Card>
  );
}
