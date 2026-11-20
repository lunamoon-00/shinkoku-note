"use client";

// 銀行・カードの CSV をまとめて取りこむ。
// 生活の買い物もまざっているので、仕事の分だけ✅をつけてから取りこむ。

import Link from "next/link";
import { useMemo, useState, type ChangeEvent } from "react";
import { RequireSession } from "@/components/session";
import { Button, ButtonLink, Card, Choice, EmptyState, Field, Help, Money, Notice, PageTitle, cx, inputClass } from "@/components/ui";
import { useLoad } from "@/components/use-load";
import { api, ApiError } from "@/lib/api";
import { dateLabel, yen } from "@/lib/format";
import type { CsvPreview, CsvRow } from "@/lib/types";

const MAX_BYTES = 1_000_000;
type Source = "personal" | "business";

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("ファイルが読めませんでした"));
    reader.readAsDataURL(file);
  });
}

function Import() {
  const [accounts] = useLoad(() => api.accounts());
  const [source, setSource] = useState<Source>("personal");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [rows, setRows] = useState<CsvRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ created: number } | null>(null);

  const expenseAccounts = useMemo(() => (accounts.status === "ready" ? accounts.data.filter((a) => a.kind === "expense") : []), [accounts]);
  const revenueAccounts = useMemo(() => (accounts.status === "ready" ? accounts.data.filter((a) => a.kind === "revenue") : []), [accounts]);
  const chosen = rows.filter((r) => r.include && !r.duplicate);
  const outTotal = chosen.filter((r) => r.direction === "out").reduce((s, r) => s + r.amount, 0);
  const inTotal = chosen.filter((r) => r.direction === "in").reduce((s, r) => s + r.amount, 0);

  function pick(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setError("");
    if (f && f.size > MAX_BYTES) {
      setError("ファイルが大きすぎます（1MBまで）。期間を分けて書き出してみてね");
      setFile(null);
      return;
    }
    setFile(f);
  }

  async function read() {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.previewCsv(file.name, await readAsBase64(file), source);
      setPreview(result);
      setRows(result.rows);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "読みこめませんでした");
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.commitCsv(preview.import_id, rows.map((r) => ({ row_id: r.row_id, include: r.include, account_code: r.account_code })));
      setDone(result);
    } catch (e) {
      setError(e instanceof ApiError ? [e.message, ...e.details.map((d) => d.message)].join("・") : "取りこめませんでした");
    } finally {
      setBusy(false);
    }
  }

  const update = (id: number, patch: Partial<CsvRow>) => setRows((rs) => rs.map((r) => (r.row_id === id ? { ...r, ...patch } : r)));
  const setAll = (include: boolean) => setRows((rs) => rs.map((r) => (r.duplicate ? r : { ...r, include })));

  if (done) {
    return (
      <div className="mx-auto flex max-w-xl flex-col gap-5">
        <PageTitle title="取りこみました" />
        <Notice tone="success" title={`${done.created}件を記録しました`}>
          選んだ科目は覚えたので、次に同じお店が出てきたら、最初から✅と科目がつきます
        </Notice>
        <div className="flex flex-wrap gap-3">
          <ButtonLink href="/entries/">一覧を見る</ButtonLink>
          <Button variant="secondary" onClick={() => { setDone(null); setPreview(null); setRows([]); setFile(null); }}>
            別のCSVを取りこむ
          </Button>
        </div>
      </div>
    );
  }

  if (!preview) {
    return (
      <div className="mx-auto flex max-w-xl flex-col gap-5">
        <PageTitle title="CSVから取りこむ" lead="銀行やカードのサイトから書き出した明細を、まとめて記録します" />
        <Card className="flex flex-col gap-5">
          <Field label="どこの明細？" help={<Help title="どうして聞くの？">仕事用に分けた口座なら「仕事用の口座から払った・入った」、それ以外は「生活のお金で払った（事業主借）」として記録するためです。</Help>}>
            <Choice<Source>
              name="source"
              value={source}
              onChange={setSource}
              options={[
                { value: "personal", label: "個人のカード・口座", icon: "💳", hint: "仕事用に分けていないもの（生活の買い物もまざっている）" },
                { value: "business", label: "仕事用の口座", icon: "🏦", hint: "仕事専用に分けている銀行口座" },
              ]}
            />
          </Field>
          <Field label="CSVファイル" htmlFor="file" hint="1MBまで。Shift_JIS でも UTF-8 でもOK">
            <input id="file" type="file" accept=".csv,text/csv" onChange={pick}
              className={cx(inputClass, "py-2.5 file:mr-3 file:rounded-xl file:border-0 file:bg-accent-soft file:px-3 file:py-1.5 file:font-bold file:text-accent")} />
          </Field>
        </Card>
        {error && <Notice tone="danger" title="読みこめませんでした">{error}</Notice>}
        <Button onClick={() => void read()} loading={busy} disabled={!file} full>読みこむ</Button>
        <p className="text-center text-sm text-sub">
          まだ何も記録されません。次の画面で、仕事の分だけ選んでから取りこみます
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5">
      <PageTitle title="仕事の分に✅をつけてね" lead="生活の買い物は✅をはずしてください。科目もここで直せます" />
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => setAll(true)}>全部✅</Button>
        <Button variant="secondary" onClick={() => setAll(false)}>全部はずす</Button>
      </div>

      {rows.length === 0 ? (
        <EmptyState icon="📭" title="取りこめる行がありませんでした" />
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((r) => {
            const options = r.direction === "out" ? expenseAccounts : revenueAccounts;
            return (
              <li key={r.row_id}>
                <Card className={cx("flex flex-col gap-3 transition", !r.include && "opacity-60", r.duplicate && "opacity-40")}>
                  <label className="flex cursor-pointer items-start gap-3">
                    <input
                      type="checkbox"
                      className="mt-1.5 size-5 accent-[var(--accent)]"
                      checked={r.include}
                      disabled={r.duplicate}
                      onChange={(e) => update(r.row_id, { include: e.target.checked })}
                      aria-label={`${r.description} ${yen(r.amount)} を取りこむ`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-bold">{r.description || "（内容なし）"}</span>
                      <span className="block text-sm text-sub">{dateLabel(r.date)}・{r.reason}</span>
                    </span>
                    <Money value={r.amount} tone={r.direction === "in" ? "in" : "out"} />
                  </label>
                  {r.include && !r.duplicate && (
                    <select
                      className={cx(inputClass, "appearance-auto")}
                      value={r.account_code}
                      onChange={(e) => update(r.row_id, { account_code: e.target.value })}
                      aria-label={`${r.description} の科目`}
                    >
                      {options.map((a) => (
                        <option key={a.code} value={a.code}>{a.friendly_name}（{a.name}）</option>
                      ))}
                    </select>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {error && <Notice tone="danger" title="取りこめませんでした">{error}</Notice>}

      <div className="sticky bottom-20 z-10 flex flex-col gap-2 rounded-[var(--radius-card)] bg-surface p-4 shadow-card sm:bottom-4">
        <p className="text-sm text-sub">
          {chosen.length}件を取りこみます（使ったお金 <span className="num font-bold text-out">{yen(outTotal)}</span>
          {inTotal > 0 && <>・入ってきたお金 <span className="num font-bold text-in">{yen(inTotal)}</span></>}）
        </p>
        <Button onClick={() => void commit()} loading={busy} disabled={chosen.length === 0} full>
          ✅の{chosen.length}件を取りこむ
        </Button>
        <Link href="/import/" onClick={() => { setPreview(null); setRows([]); }} className="text-center text-sm font-bold text-accent">
          やめて、ファイルを選びなおす
        </Link>
      </div>
    </div>
  );
}

export default function ImportPage() {
  return (
    <RequireSession>
      <Import />
    </RequireSession>
  );
}
