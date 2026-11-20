// 設定画面の「LINEとつなぐ」。6けたの番号を出して、LINE で送ってもらう。
"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { config } from "@/lib/config";
import { Button, Card, Notice, Spinner } from "./ui";
import { useLoad } from "./use-load";

export function LineConnect() {
  const [status, reload] = useLoad(() => api.lineStatus());
  const [code, setCode] = useState<{ code: string; until: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // 番号を出しているあいだは、残り時間を数えつつ、つながったか5秒ごとに見に行く
  useEffect(() => {
    if (!code) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(() => reload(), 5000);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [code, reload]);

  const linked = status.status === "ready" && status.data.linked;
  const left = code ? Math.max(0, Math.round((code.until - now) / 1000)) : 0;
  const showCode = code && !linked && left > 0;

  async function issue() {
    setBusy(true);
    setError("");
    try {
      const res = await api.lineLinkCode();
      setCode({ code: res.code, until: Date.now() + res.expires_in_minutes * 60_000 });
      setNow(Date.now());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "番号を出せませんでした");
    } finally {
      setBusy(false);
    }
  }

  async function unlink() {
    setBusy(true);
    try {
      await api.unlinkLine();
      setCode(null);
      reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "外せませんでした");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="flex flex-col gap-4">
      <div>
        <h2 className="font-bold">LINEとつなぐ</h2>
        <p className="text-[15px] text-sub">つなぐと、LINE にレシートの写真を送るだけで記録できるようになります</p>
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      {status.status === "loading" && <Spinner label="確かめています…" />}
      {status.status === "error" && <Notice tone="danger">{status.message}</Notice>}

      {linked && (
        <>
          <Notice tone="success" title="LINEとつながっています">レシートや領収書の写真を、LINE で送ってね</Notice>
          <Button variant="secondary" onClick={() => void unlink()} loading={busy}>つなぐのをやめる</Button>
        </>
      )}

      {status.status === "ready" && !linked && !showCode && (
        <>
          <ol className="list-decimal space-y-1 pl-5 text-[15px] text-sub">
            <li>LINE で「申告ノート」を友だち追加する</li>
            <li>下のボタンで、6けたの番号を出す</li>
            <li>その番号を、LINE で「申告ノート」に送る</li>
          </ol>
          <Button onClick={() => void issue()} loading={busy}>番号を出す</Button>
        </>
      )}

      {showCode && (
        <div className="flex flex-col items-center gap-2 rounded-2xl bg-accent-soft p-5 text-center">
          <p className="text-sm text-sub">この番号を LINE で送ってね</p>
          <p className="num text-4xl font-bold tracking-[0.3em]" aria-label={`番号 ${code.code.split("").join(" ")}`}>{code.code}</p>
          <p className="text-sm text-sub">
            のこり {Math.floor(left / 60)}分{String(left % 60).padStart(2, "0")}秒
            {config.mock && "（お試しモードでは、出した時点でつながります）"}
          </p>
          <Spinner label="つながるのを待っています…" />
        </div>
      )}
    </Card>
  );
}
