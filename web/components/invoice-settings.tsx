// 設定画面の「インボイス登録」。チェックを入れた人だけ、消費税の計算まで出す
"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { InvoiceSettings } from "@/lib/types";
import { Button, Card, Choice, Field, Help, Notice, Spinner, cx, inputClass } from "./ui";
import { useLoad } from "./use-load";

const CATEGORIES = [
  [1, "第1種（卸売業）90%"], [2, "第2種（小売業など）80%"], [3, "第3種（製造業・建設業など）70%"],
  [4, "第4種（飲食店業・そのほか）60%"], [5, "第5種（サービス業など）50%"], [6, "第6種（不動産業）40%"],
] as const;

export function InvoiceSettingsCard() {
  const [state] = useLoad(() => api.invoice());
  const [draft, setDraft] = useState<InvoiceSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (state.status === "ready") setDraft(state.data);
  }, [state]);

  if (state.status === "loading" || !draft) return <Card><Spinner label="読みこんでいます…" /></Card>;
  const set = (p: Partial<InvoiceSettings>) => setDraft({ ...draft, ...p });

  async function save() {
    if (!draft) return;
    setBusy(true);
    setMessage(null);
    try {
      setDraft(await api.saveInvoice(draft));
      setMessage({ tone: "success", text: "保存しました" });
    } catch (e) {
      setMessage({ tone: "danger", text: e instanceof ApiError ? [e.message, ...e.details.map((d) => d.message)].join("・") : "保存できませんでした" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="flex flex-col gap-4">
      <h2 className="font-bold">
        インボイス（消費税）
        <Help title="インボイス登録">取引先に「適格請求書（インボイス）」を出すために、税務署に登録することです。登録すると消費税の申告が必要になります（期限は翌年3月31日）。登録していなければ、ここはチェックなしでOK。</Help>
      </h2>
      <label className="flex cursor-pointer items-center gap-2 font-bold">
        <input type="checkbox" className="size-5 accent-[var(--accent)]" checked={draft.registered} onChange={(e) => set({ registered: e.target.checked })} />
        インボイス登録している
      </label>
      {draft.registered && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label="登録番号" htmlFor="inv-num" hint="T＋13けた">
              <input id="inv-num" className={inputClass} placeholder="T1234567890123" value={draft.registration_number ?? ""} onChange={(e) => set({ registration_number: e.target.value })} />
            </Field>
            <Field label="登録日" htmlFor="inv-date" hint="登録通知書に書いてある日">
              <input id="inv-date" type="date" className={inputClass} value={draft.registered_on ?? ""} onChange={(e) => set({ registered_on: e.target.value || null })} />
            </Field>
          </div>
          <Field label="消費税の計算のしかた">
            <Choice name="inv-method" value={draft.method} onChange={(method) => set({ method })} options={[
              { value: "two_tenths", label: "2割特例", hint: "免税事業者からインボイス登録した人向け。売上の消費税の2割を納める（2026年分まで。届出はいらない）" },
              { value: "simplified", label: "簡易課税", hint: "前もって「簡易課税制度選択届出書」を出した人。業種ごとの割合で計算" },
              { value: "standard", label: "本則課税", hint: "仕入れの消費税を1件ずつ引く計算（このアプリではまだ計算できません）" },
            ]} />
          </Field>
          {draft.method === "simplified" && (
            <Field label="事業区分" htmlFor="inv-cat" hint="デザイン・ライター・エンジニアなどは、ふつう第5種（サービス業）">
              <select id="inv-cat" className={cx(inputClass, "appearance-auto")} value={draft.business_category ?? ""} onChange={(e) => set({ business_category: Number(e.target.value) || null })}>
                <option value="">選んでください</option>
                {CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Field>
          )}
        </>
      )}
      {message && <Notice tone={message.tone} title={message.text} />}
      <Button variant="secondary" onClick={() => void save()} loading={busy}>インボイスの設定を保存する</Button>
    </Card>
  );
}
