// 設定画面の「freeeとつなぐ」。freee の許可画面に行って、戻ってきたら結果を出す。
"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { dateLabel } from "@/lib/format";
import type { FreeeSource } from "@/lib/types";
import { Button, Card, Help, Notice, Spinner } from "./ui";
import { useLoad } from "./use-load";

const SOURCES: { value: FreeeSource; label: string; hint: string }[] = [
  { value: "receipt", label: "LINEで送ったレシート", hint: "写真も freee のファイルボックスに入れます" },
  { value: "recurring", label: "毎月の固定費", hint: "家事按分したあとの金額で送ります" },
  { value: "manual", label: "画面で手入力したもの", hint: "「記録する」から入れた経費・報酬" },
  { value: "csv", label: "CSVで取りこんだもの", hint: "freee で口座連携をしているなら、二重になるので送らないでね" },
];

const RETURN_MESSAGES: Record<string, { tone: "success" | "warn" | "danger"; text: string }> = {
  connected: { tone: "success", text: "freee とつながりました！これから記録したものを freee に送ります" },
  cancelled: { tone: "warn", text: "freee とつなぐのをやめました" },
  expired: { tone: "warn", text: "時間が切れました。もう一度「freeeとつなぐ」を押してね" },
  error: { tone: "danger", text: "うまくつなげませんでした。少し時間をおいて、もう一度ためしてね" },
};

export function FreeeConnect() {
  const returned = useSearchParams().get("freee");
  const [state, reload] = useLoad(() => api.freeeStatus());
  const [busy, setBusy] = useState<"connect" | "sources" | "disconnect" | null>(null);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  // 押した瞬間に✅を変える（保存は裏で）
  const [optimistic, setOptimistic] = useState<FreeeSource[] | null>(null);

  async function connect() {
    setBusy("connect");
    setError("");
    try {
      window.location.href = await api.freeeConnect(); // freee の許可画面へ
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "つなげませんでした");
      setBusy(null);
    }
  }

  async function toggle(source: FreeeSource, on: boolean) {
    if (state.status !== "ready" || !state.data.connected) return;
    const current = optimistic ?? state.data.send_sources;
    const next = on ? [...current, source] : current.filter((s) => s !== source);
    setOptimistic(next);
    setBusy("sources");
    try {
      await api.freeeSources(next);
    } catch (e) {
      setOptimistic(null); // 保存できなかったら元にもどす
      setError(e instanceof ApiError ? e.message : "保存できませんでした");
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    setBusy("disconnect");
    try {
      await api.freeeDisconnect();
      setConfirming(false);
      setOptimistic(null);
      reload();
    } finally {
      setBusy(null);
    }
  }

  const message = returned ? RETURN_MESSAGES[returned] : undefined;

  return (
    <Card className="flex flex-col gap-4">
      <div>
        <h2 className="font-bold">
          freeeとつなぐ
          <Help title="freee（フリー）連携">
            つなぐと、ここで記録したもの（LINE のレシート・毎月の固定費など）を、freee 会計に自動で登録します。つないだ日より前の記録は送りません（freee にもう入っている分と二重にならないように）。
          </Help>
        </h2>
        <p className="text-[15px] text-sub">freee 会計を使っている人向け。使っていなければ、つながなくてOK</p>
      </div>
      {message && <Notice tone={message.tone} title={message.text} />}
      {error && <Notice tone="danger">{error}</Notice>}
      {state.status === "loading" && <Spinner label="確かめています…" />}
      {state.status === "error" && <Notice tone="danger">{state.message}</Notice>}

      {state.status === "ready" && !state.data.connected && (
        <>
          <p className="text-[15px] text-sub">
            ボタンを押すと freee の画面に移ります。送りたい事業所を選んで「許可する」を押すと、ここにもどってきます
          </p>
          <Button onClick={() => void connect()} loading={busy === "connect"}>freeeとつなぐ</Button>
        </>
      )}

      {state.status === "ready" && state.data.connected && (
        <>
          <Notice tone="success" title={`${state.data.company_name || "freee"} とつながっています`}>
            {dateLabel(state.data.connected_at.slice(0, 10))}につないだあとの記録を送っています
          </Notice>
          <div className="grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
            {[
              { label: "送った", value: state.data.counts.sent },
              { label: "送る予定", value: state.data.counts.pending },
              { label: "失敗", value: state.data.counts.failed },
              { label: "送れない", value: state.data.counts.skipped },
            ].map((c) => (
              <div key={c.label} className="rounded-2xl bg-surface-2 p-2">
                <p className="num text-xl font-bold">{c.value}</p>
                <p className="text-xs text-sub">{c.label}</p>
              </div>
            ))}
          </div>
          {state.data.problems.length > 0 && (
            <Notice tone="warn" title="送れなかった記録があります">
              <ul className="mt-1 list-disc pl-5">
                {state.data.problems.map((p) => (
                  <li key={p.entry_id}>
                    {p.entry_date && dateLabel(p.entry_date)} {p.partner}：{p.error}
                  </li>
                ))}
              </ul>
            </Notice>
          )}
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 font-bold">freee に送るもの</legend>
            {SOURCES.map((s) => (
              <label key={s.value} className="flex cursor-pointer items-start gap-3 rounded-2xl border border-line p-3">
                <input
                  type="checkbox"
                  className="mt-1 size-5 accent-[var(--accent)]"
                  checked={state.data.connected && (optimistic ?? state.data.send_sources).includes(s.value)}
                  disabled={busy === "sources"}
                  onChange={(e) => void toggle(s.value, e.target.checked)}
                />
                <span>
                  <span className="block font-bold">{s.label}</span>
                  <span className="block text-sm text-sub">{s.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {!confirming ? (
            <Button variant="secondary" onClick={() => setConfirming(true)}>つなぐのをやめる</Button>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-sub">やめると、これからは freee に送りません（もう送ったものは freee に残ります）</p>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => setConfirming(false)}>もどる</Button>
                <Button variant="danger" onClick={() => void disconnect()} loading={busy === "disconnect"}>やめる</Button>
              </div>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
