// 確定申告の準備画面の追加部品：写真から読み取った書類・減価償却
"use client";

import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { dateLabel, parseYen, todayIso, yen } from "@/lib/format";
import type { FixedAsset, TaxDocument } from "@/lib/types";
import { Button, Choice, Field, Help, Money, Notice, cx, inputClass } from "./ui";

/** LINE で送った控除証明書など。計算には「手で入れた金額」に足して使う */
export function DocumentsList({ documents, onChanged }: { documents: TaxDocument[]; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  if (documents.length === 0) {
    return (
      <p className="text-[15px] text-sub">
        国民年金・生命保険の控除証明書、ふるさと納税の受領証明書、源泉徴収票などは、LINE で写真を送ると自動で読み取ってここに入ります
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {documents.map((d) => (
        <li key={d.id} className="flex items-center gap-3 rounded-2xl bg-surface-2 p-3">
          <span aria-hidden className="text-xl">📄</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-bold">{d.label}</span>
            <span className="block truncate text-sm text-sub">{d.issuer || "発行元不明"}・{dateLabel(d.created_at.slice(0, 10))}に読み取り</span>
          </span>
          <Money value={d.total} />
          <Button variant="ghost" loading={busy === d.id} aria-label={`${d.label}を消す`}
            onClick={async () => { setBusy(d.id); try { await api.deleteTaxDocument(d.id); onChanged(); } finally { setBusy(null); } }}>
            消す
          </Button>
        </li>
      ))}
    </ul>
  );
}

const blankAsset = () => ({ name: "", acquired_on: todayIso(), cost: 0, useful_life: 4, method: "straight" as const, business_ratio: 100 });

/** 10万円以上のパソコンなど。何年かに分けて経費にする */
export function AssetsEditor({ assets, year, onChanged }: { assets: FixedAsset[]; year: number; onChanged: () => void }) {
  const [form, setForm] = useState<Omit<FixedAsset, "id" | "disposed_on">>(blankAsset());
  const [costText, setCostText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; fields: Record<string, string> } | null>(null);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  async function add() {
    setBusy(true);
    setError(null);
    try {
      await api.createAsset(form);
      setForm(blankAsset());
      setCostText("");
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? { message: e.message, fields: Object.fromEntries(e.details.map((d) => [d.field, d.message])) } : { message: "登録できませんでした", fields: {} });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {assets.length > 0 && (
        <ul className="flex flex-col gap-2">
          {assets.map((a) => (
            <li key={a.id} className="flex items-center gap-3 rounded-2xl bg-surface-2 p-3">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-bold">{a.name}</span>
                <span className="block text-sm text-sub">
                  {yen(a.cost)}・{a.method === "lump3" ? "3年で1/3ずつ" : `耐用年数${a.useful_life}年`}
                  {a.business_ratio < 100 && `・仕事の割合${a.business_ratio}%`}
                </span>
              </span>
              <span className="text-right">
                <span className="block text-xs text-sub">{year}年の経費</span>
                <Money value={a.expense ?? 0} tone="out" />
              </span>
              <Button variant="ghost" aria-label={`${a.name}を消す`} onClick={async () => { await api.deleteAsset(a.id); onChanged(); }}>消す</Button>
            </li>
          ))}
        </ul>
      )}
      <Notice tone="info" title="減価償却で登録したものは、ふつうの記録（消耗品費など）に入れないでね">
        二重に経費になってしまいます。10万円未満のものは、減価償却ではなく、ふつうの記録でOK
      </Notice>
      <div className="flex flex-col gap-3 rounded-2xl border border-line p-3">
        <Field label="名前" htmlFor="asset-name" error={error?.fields.name}>
          <input id="asset-name" className={inputClass} maxLength={50} placeholder="例：ノートパソコン" value={form.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="買った値段" htmlFor="asset-cost" error={error?.fields.cost}>
            <input id="asset-cost" inputMode="numeric" className={cx(inputClass, "num text-right")} value={costText} placeholder="0"
              onChange={(e) => { setCostText(e.target.value); set({ cost: parseYen(e.target.value) }); }} />
          </Field>
          <Field label="使い始めた日" htmlFor="asset-date" error={error?.fields.acquired_on}>
            <input id="asset-date" type="date" className={inputClass} value={form.acquired_on} onChange={(e) => set({ acquired_on: e.target.value })} />
          </Field>
        </div>
        <Field label="経費にするやり方" error={error?.fields.method}>
          <Choice name="asset-method" value={form.method} onChange={(method) => set({ method })} options={[
            { value: "straight", label: "耐用年数で分ける（定額法）", hint: "ふつうはこちら" },
            { value: "lump3", label: "3年で1/3ずつ（一括償却）", hint: "10万円以上20万円未満のものだけ選べます" },
          ]} />
        </Field>
        {form.method === "straight" && (
          <Field label="耐用年数" htmlFor="asset-life" error={error?.fields.useful_life}
            help={<Help title="耐用年数（たいようねんすう）">ものごとに法律で決まっている「何年使えるか」の年数です。パソコンは4年、ソフトウェアは5年、普通の自動車は6年など。わからないときは国税庁の「耐用年数表」で確かめてね。</Help>}>
            <select id="asset-life" className={cx(inputClass, "appearance-auto")} value={form.useful_life} onChange={(e) => set({ useful_life: Number(e.target.value) })}>
              {[2, 3, 4, 5, 6, 7, 8, 10, 15, 20].map((n) => <option key={n} value={n}>{n}年{n === 4 ? "（パソコン）" : n === 5 ? "（ソフトウェア）" : n === 6 ? "（普通の自動車）" : ""}</option>)}
            </select>
          </Field>
        )}
        <Field label={`仕事で使う割合：${form.business_ratio}%`} htmlFor="asset-ratio">
          <input id="asset-ratio" type="range" min={1} max={100} value={form.business_ratio} onChange={(e) => set({ business_ratio: Number(e.target.value) })} className="w-full accent-[var(--accent)]" />
        </Field>
        {error && <Notice tone="danger" title={error.message} />}
        <Button variant="secondary" onClick={() => void add()} loading={busy}>＋ 登録する</Button>
      </div>
    </div>
  );
}
