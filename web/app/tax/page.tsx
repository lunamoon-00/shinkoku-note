"use client";

// 確定申告の準備。質問に答えて控除や家族を入れると、払う税金（戻ってくるお金）がその場で計算される。
// 計算は API（api/shinkoku/tax.py・国税庁のルール）でしている。画面は入れて見せるだけ。

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { YearPicker } from "@/components/entry-list";
import { RequireSession } from "@/components/session";
import { AssetsEditor, DocumentsList } from "@/components/tax-extras";
import { Button, Card, Choice, Field, Help, Money, Notice, PageTitle, Spinner, cx, inputClass } from "@/components/ui";
import { useLoad } from "@/components/use-load";
import { api, ApiError } from "@/lib/api";
import { parseYen, yen } from "@/lib/format";
import type { FamilyMember, TaxInputs, TaxOverview } from "@/lib/types";

/** 申告するのはふつう「去年の分」。1〜3月なら去年、それ以外は今年 */
const defaultYear = () => {
  const d = new Date();
  return d.getMonth() < 3 ? d.getFullYear() - 1 : d.getFullYear();
};

function Yen({ label, value, onChange, hint, help }: { label: string; value?: number; onChange: (n: number) => void; hint?: ReactNode; help?: ReactNode }) {
  const [editing, setEditing] = useState<string | null>(null);
  const id = `yen-${label}`;
  const shown = value ? value.toLocaleString("ja-JP") : "";
  return (
    <Field label={label} htmlFor={id} hint={hint} help={help}>
      <div className="relative">
        <input id={id} inputMode="numeric" className={cx(inputClass, "num pr-10 text-right font-bold")} placeholder="0"
          value={editing ?? shown} onFocus={() => setEditing(shown)} onBlur={() => setEditing(null)}
          onChange={(e) => { setEditing(e.target.value); onChange(parseYen(e.target.value)); }} />
        <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-sub">円</span>
      </div>
    </Field>
  );
}

/** 1つの質問のまとまり。「なし」「確認した」で印をつけられる */
function Section({ id, title, question, checked, onCheck, children, open, onToggle }: {
  id: string; title: string; question: string; checked: boolean; onCheck: (v: boolean) => void;
  children: ReactNode; open: boolean; onToggle: () => void;
}) {
  return (
    <Card className="flex flex-col gap-4 print:hidden">
      <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={`sec-${id}`} className="flex items-center gap-3 text-left">
        <span aria-hidden className={cx("grid size-7 shrink-0 place-items-center rounded-full text-sm font-bold", checked ? "bg-in text-on-accent" : "bg-surface-2 text-sub")}>
          {checked ? "✓" : "・"}
        </span>
        <span className="flex-1">
          <span className="block font-bold">{title}</span>
          <span className="block text-sm text-sub">{question}</span>
        </span>
        <span aria-hidden className="text-sub">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div id={`sec-${id}`} className="flex flex-col gap-4">
          {children}
          <label className="flex cursor-pointer items-center gap-2 rounded-2xl bg-surface-2 p-3 font-bold">
            <input type="checkbox" className="size-5 accent-[var(--accent)]" checked={checked} onChange={(e) => onCheck(e.target.checked)} />
            確認した（なければ、空のままチェックでOK）
          </label>
        </div>
      )}
    </Card>
  );
}

const RELATION_LABEL = { spouse: "配偶者", child: "子", parent: "親", other: "そのほかの家族" } as const;

function FamilyEditor({ family, onChange }: { family: FamilyMember[]; onChange: (f: FamilyMember[]) => void }) {
  const update = (i: number, patch: Partial<FamilyMember>) => onChange(family.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  return (
    <div className="flex flex-col gap-3">
      {family.map((f, i) => (
        <div key={i} className="flex flex-col gap-3 rounded-2xl border border-line p-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="続柄" htmlFor={`rel-${i}`}>
              <select id={`rel-${i}`} className={cx(inputClass, "appearance-auto")} value={f.relation} onChange={(e) => update(i, { relation: e.target.value as FamilyMember["relation"] })}>
                {Object.entries(RELATION_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Field>
            <Field label="呼び名" htmlFor={`name-${i}`} hint="見分けるため（本名でなくてOK）">
              <input id={`name-${i}`} className={inputClass} maxLength={20} value={f.name} onChange={(e) => update(i, { name: e.target.value })} />
            </Field>
          </div>
          <Field label="生年月日" htmlFor={`birth-${i}`} hint="年齢で控除の金額が変わります（12月31日時点）">
            <input id={`birth-${i}`} type="date" className={inputClass} value={f.birth_date ?? ""} onChange={(e) => update(i, { birth_date: e.target.value || null })} />
          </Field>
          <Yen label="その人の今年の所得（もうけ）" value={f.income} onChange={(n) => update(i, { income: n })}
            hint="収入がなければ0円。パート収入なら、収入から給与所得控除を引いた額"
            help={<Help title="家族の所得">配偶者や家族の所得が一定より少ないと、あなたの税金が安くなる控除（配偶者控除・扶養控除）が使えます。2026年分は62万円以下がめやすです。</Help>} />
          <label className="flex items-center gap-2"><input type="checkbox" className="size-5 accent-[var(--accent)]" checked={f.living_together} onChange={(e) => update(i, { living_together: e.target.checked })} />いっしょに住んでいる</label>
          <Field label="障害者手帳など" htmlFor={`dis-${i}`}>
            <select id={`dis-${i}`} className={cx(inputClass, "appearance-auto")} value={f.disability ?? ""} onChange={(e) => update(i, { disability: (e.target.value || null) as FamilyMember["disability"] })}>
              <option value="">なし</option><option value="normal">障害者</option><option value="special">特別障害者（1級・2級など）</option>
            </select>
          </Field>
          <label className="flex items-center gap-2"><input type="checkbox" className="size-5 accent-[var(--accent)]" checked={f.is_senjusha} onChange={(e) => update(i, { is_senjusha: e.target.checked })} />
            仕事を手伝ってもらっている（事業専従者）
            <Help title="事業専従者（じぎょうせんじゅうしゃ）">家族が1年のうち6か月をこえて、あなたの仕事を専門に手伝っている場合です。経費のように差し引ける（配偶者は最大86万円）かわりに、配偶者控除・扶養控除は使えなくなります。</Help>
          </label>
          <Button variant="ghost" onClick={() => onChange(family.filter((_, j) => j !== i))}>この人を消す</Button>
        </div>
      ))}
      <Button variant="secondary" onClick={() => onChange([...family, { name: "", relation: family.some((f) => f.relation === "spouse") ? "child" : "spouse", birth_date: null, income: 0, living_together: true, disability: null, is_senjusha: false }])}>
        ＋ 家族を足す
      </Button>
    </div>
  );
}

const DEDUCTION_LABELS: Record<string, string> = {
  social_insurance: "社会保険料控除", small_business: "小規模企業共済等掛金控除", life_insurance: "生命保険料控除",
  earthquake_insurance: "地震保険料控除", medical: "医療費控除", donation: "寄附金控除", disability: "障害者控除",
  widow_or_single_parent: "寡婦・ひとり親控除", working_student: "勤労学生控除", spouse: "配偶者控除",
  spouse_special: "配偶者特別控除", dependents: "扶養控除", specific_relative: "特定親族特別控除", basic: "基礎控除",
};

function Result({ data }: { data: TaxOverview }) {
  const r = data.result;
  return (
    <div className="flex flex-col gap-4">
      <Card className={cx("flex flex-col gap-1", r.refund > 0 ? "bg-in-soft" : "bg-accent-soft")}>
        <p className="text-sm font-bold text-sub">{r.refund > 0 ? "戻ってくるお金（還付）のめやす" : "払う税金（所得税）のめやす"}</p>
        <p className="text-4xl"><Money value={r.refund > 0 ? r.refund : r.payable} tone={r.refund > 0 ? "in" : undefined} /></p>
        <p className="text-sm text-sub">入れた内容で、国税庁のルール（{r.year}年分）にそって計算しています。住民税・事業税は入っていません</p>
      </Card>
      {r.notes.map((n) => <Notice key={n} tone="warn">{n}</Notice>)}
      <Card>
        <h2 className="mb-2 font-bold">計算のながれ</h2>
        <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 text-[15px]">
          {[
            ["売上（収入）", r.revenue], [data.books.depreciation ? `経費（減価償却 ${yen(data.books.depreciation)} をふくむ）` : "経費", -r.expense],
            ...(r.senjusha_deduction ? [["事業専従者控除", -r.senjusha_deduction]] : []),
            ["事業所得", r.business_income],
            ...(r.salary_income ? [["給与所得", r.salary_income]] : []),
            ...(r.other_income ? [["そのほかの所得", r.other_income]] : []),
            ["合計所得金額", r.total_income], ["所得控除の合計", -r.total_deductions],
            ["課税される所得金額（1,000円未満切り捨て）", r.taxable_income], [`所得税（税率${r.tax_rate_percent}%）`, r.income_tax],
            ...(r.tax_credits ? [["住宅ローン控除など", -r.tax_credits]] : []),
            ["復興特別所得税（2.1%）", r.reconstruction_tax], ["税金の合計", r.total_tax],
            ["源泉徴収された税金", -r.withholding], ...(r.prepaid_tax ? [["予定納税", -r.prepaid_tax]] : []),
          ].map(([label, value]) => (
            <div key={label as string} className="contents">
              <dt className="text-sub">{label}</dt>
              <dd className="num text-right font-bold">{(value as number) < 0 ? `−${yen(-(value as number))}` : yen(value as number)}</dd>
            </div>
          ))}
        </dl>
        <details className="mt-3">
          <summary className="cursor-pointer font-bold text-accent">所得控除の内訳</summary>
          <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-[15px]">
            {Object.entries(r.deductions).filter(([, v]) => v > 0).map(([k, v]) => (
              <div key={k} className="contents"><dt className="text-sub">{DEDUCTION_LABELS[k] ?? k}</dt><dd className="num text-right">{yen(v)}</dd></div>
            ))}
          </dl>
        </details>
      </Card>
    </div>
  );
}

function Guide({ data }: { data: TaxOverview }) {
  const r = data.result;
  const steps: { title: string; rows: [string, number][] }[] = [
    { title: "① 収支内訳書（一般用）：売上と経費", rows: data.white_lines.map((l) => [l.line, l.amount]) },
    { title: "② 確定申告書：収入と所得", rows: [["事業（営業等）の収入", r.revenue], ["事業（営業等）の所得", r.business_income],
      ...(r.salary_income ? [["給与の所得", r.salary_income] as [string, number]] : [])] },
    { title: "③ 確定申告書：所得から差し引かれる金額", rows: Object.entries(r.deductions).filter(([, v]) => v > 0).map(([k, v]) => [DEDUCTION_LABELS[k] ?? k, v]) },
    { title: "④ 確定申告書：税金の計算", rows: [["課税される所得金額", r.taxable_income], ["源泉徴収税額", r.withholding],
      ...(r.prepaid_tax ? [["予定納税額", r.prepaid_tax] as [string, number]] : []),
      r.refund ? ["還付される税金", r.refund] : ["納める税金", r.payable]] },
  ];
  return (
    <Card className="flex flex-col gap-4">
      <div>
        <h2 className="font-bold">申告の日に入れる数字</h2>
        <p className="text-sm text-sub">国税庁の「確定申告書等作成コーナー」で、この順番に入れていきます。画面の名前は年によって少しちがうことがあります</p>
      </div>
      {steps.map((s) => (
        <section key={s.title}>
          <h3 className="mb-1 text-[15px] font-bold">{s.title}</h3>
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 rounded-2xl bg-surface-2 p-3 text-[15px]">
            {s.rows.length === 0 && <dd className="text-sub">なし</dd>}
            {s.rows.map(([label, value]) => (
              <div key={label} className="contents"><dt>{label}</dt><dd className="num text-right font-bold">{yen(value)}</dd></div>
            ))}
          </dl>
        </section>
      ))}
      <p className="text-sm text-sub">
        計算の根拠：<a className="text-accent underline" href={data.sources.basic_deduction} target="_blank" rel="noreferrer">国税庁タックスアンサー</a>
        （むずかしいところや、ここにない控除は、税務署や税理士に確認してね）
      </p>
    </Card>
  );
}

function Consumption({ c }: { c: NonNullable<TaxOverview["consumption"]> }) {
  const method = c.method === "two_tenths" ? "2割特例" : c.method === "simplified" ? `簡易課税・${c.category_label}` : "本則課税";
  return (
    <Card className="flex flex-col gap-3">
      <div>
        <h2 className="font-bold">消費税（インボイス）</h2>
        <p className="text-sm text-sub">{method}で計算。登録日（{c.registered_on}）より後の売上が対象です。申告と納付は翌年の3月31日まで</p>
      </div>
      <p className="text-3xl"><Money value={c.payable_total} /></p>
      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 rounded-2xl bg-surface-2 p-3 text-[15px]">
        {([
          ["課税売上（税込）", c.taxable_sales], ["課税標準額（1,000円未満切り捨て）", c.tax_base], ["消費税額（7.8%）", c.national_tax],
          [c.method === "two_tenths" ? "控除する税額（2割特例：8割）" : "控除する税額（みなし仕入率）", c.deduction],
          ["納める消費税（100円未満切り捨て）", c.payable_national], ["納める地方消費税（22/78）", c.payable_local],
        ] as [string, number][]).map(([l, v]) => (
          <div key={l} className="contents"><dt>{l}</dt><dd className="num text-right font-bold">{yen(v)}</dd></div>
        ))}
      </dl>
      {c.notes.map((n) => <Notice key={n} tone="warn">{n}</Notice>)}
    </Card>
  );
}

function Tax() {
  const [year, setYear] = useState(defaultYear);
  const [state, reload] = useLoad(() => api.tax(year), year);
  const [inputs, setInputs] = useState<TaxInputs>({});
  const [live, setLive] = useState<TaxOverview | null>(null);
  const [open, setOpen] = useState<string>("books");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  // 読みこんだら、入力欄に今の値を入れる
  useEffect(() => {
    if (state.status === "ready") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setInputs(state.data.inputs);
      setLive(state.data);
    }
  }, [state]);

  const set = (patch: Partial<TaxInputs>) => setInputs((v) => ({ ...v, ...patch }));
  const checked = inputs.checked ?? {};
  const check = (key: string, v: boolean) => set({ checked: { ...checked, [key]: v } });

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const out = await api.saveTaxInputs(year, inputs);
      setLive(out);
      setInputs(out.inputs);
      setMessage({ tone: "success", text: "保存して、計算しなおしました" });
    } catch (e) {
      setMessage({ tone: "danger", text: e instanceof ApiError ? [e.message, ...e.details.map((d) => d.message)].join("・") : "保存できませんでした" });
    } finally {
      setBusy(false);
    }
  }

  const li = inputs.life_insurance ?? {};
  const eq = inputs.earthquake_insurance ?? {};
  const med = inputs.medical ?? { mode: "medical" as const };
  const me = inputs.self ?? { disability: null, widow: false, single_parent: false, working_student: false };
  const sec = (id: string) => ({ id, checked: !!checked[id], onCheck: (v: boolean) => check(id, v), open: open === id, onToggle: () => setOpen(open === id ? "" : id) });
  const done = live?.checklist.filter((c) => c.done).length ?? 0;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3 print:hidden">
        <PageTitle title="確定申告の準備" lead="質問に答えていくと、税金がその場で計算されます" />
        <YearPicker year={year} onChange={setYear} />
      </div>

      {state.status === "loading" && <div className="py-10 text-center text-sub"><Spinner label="読みこんでいます…" /></div>}
      {state.status === "error" && (
        <div className="flex flex-col gap-3">
          <Notice tone="danger" title="読みこめませんでした">{state.message}</Notice>
          <Button variant="secondary" onClick={reload}>もう一度ためす</Button>
        </div>
      )}

      {state.status === "ready" && live && (
        <>
          <Card className="print:hidden">
            <div className="mb-2 flex items-baseline justify-between">
              <h2 className="font-bold">申告チェックリスト</h2>
              <span className="num text-sm text-sub">{done} / {live.checklist.length}</span>
            </div>
            <div className="mb-3 h-2 overflow-hidden rounded-full bg-surface-2"><div className="h-full rounded-full bg-in" style={{ width: `${(done / live.checklist.length) * 100}%` }} /></div>
            <ul className="flex flex-col gap-1.5 text-[15px]">
              {live.checklist.map((c) => (
                <li key={c.key} className="flex gap-2">
                  <span aria-hidden>{c.done ? "✅" : "⬜"}</span>
                  <span><span className={c.done ? "text-sub" : "font-bold"}>{c.label}</span>{c.warn && <span className="block text-sm text-warn">{c.warn}</span>}</span>
                </li>
              ))}
            </ul>
          </Card>

          <Card className="flex flex-col gap-3 print:hidden">
            <h2 className="font-bold">写真から読み取った書類</h2>
            <DocumentsList documents={live.documents} onChanged={reload} />
          </Card>

          <Section {...sec("books")} title="売上と経費" question="今年の売上と経費は、ぜんぶ記録した？">
            <p>売上 <Money value={live.books.revenue} tone="in" />・経費 <Money value={live.books.expense} tone="out" />・源泉徴収された税金 <Money value={live.books.withholding} /></p>
            <Link href="/entries/" className="font-bold text-accent">記録の一覧を見る ›</Link>
            <h3 className="mt-2 font-bold">
              10万円以上のもの（減価償却）
              <Help title="減価償却（げんかしょうきゃく）">10万円以上のパソコンなど、長く使うものは、買った年に全部を経費にせず、何年かに分けて経費にする決まりです。ここに登録すると、その年の分を自動で計算します。</Help>
            </h3>
            <AssetsEditor assets={live.assets} year={year} onChanged={reload} />
          </Section>

          <Section {...sec("salary")} title="お給料" question="今年、会社からお給料をもらった？（途中でやめた会社もふくむ）">
            {(inputs.salaries ?? []).map((s, i) => {
              const upd = (patch: object) => set({ salaries: (inputs.salaries ?? []).map((x, j) => (j === i ? { ...x, ...patch } : x)) });
              return (
                <div key={i} className="flex flex-col gap-3 rounded-2xl border border-line p-3">
                  <Field label="会社の名前（呼び名でOK）" htmlFor={`payer-${i}`}><input id={`payer-${i}`} className={inputClass} value={s.payer} onChange={(e) => upd({ payer: e.target.value })} /></Field>
                  <Yen label="支払金額" value={s.gross} onChange={(n) => upd({ gross: n })} hint="源泉徴収票の「支払金額」" />
                  <Yen label="給与所得控除後の金額（書いてあれば）" value={s.income_after_deduction} onChange={(n) => upd({ income_after_deduction: n })} hint="空なら自動で計算します" />
                  <Yen label="源泉徴収税額" value={s.withheld} onChange={(n) => upd({ withheld: n })} />
                  <Yen label="社会保険料等の金額" value={s.social_insurance} onChange={(n) => upd({ social_insurance: n })} />
                  <Button variant="ghost" onClick={() => set({ salaries: (inputs.salaries ?? []).filter((_, j) => j !== i) })}>この源泉徴収票を消す</Button>
                </div>
              );
            })}
            <Button variant="secondary" onClick={() => set({ salaries: [...(inputs.salaries ?? []), { payer: "", gross: 0, income_after_deduction: 0, withheld: 0, social_insurance: 0 }] })}>
              ＋ 源泉徴収票を足す
            </Button>
          </Section>

          <Section {...sec("social_insurance")} title="健康保険・年金など" question="国民健康保険や国民年金を払った？">
            <Yen label="払った社会保険料の合計" value={inputs.social_insurance} onChange={(n) => set({ social_insurance: n })}
              hint="国民健康保険・国民年金・国民年金基金・介護保険など。家族の分を払ったときもふくめてOK"
              help={<Help title="社会保険料控除">払った全額が差し引けます。国民年金は11月ごろに届く「控除証明書」、国民健康保険は市区町村の「納付済額のお知らせ」で金額がわかります。</Help>} />
          </Section>

          <Section {...sec("small_business")} title="小規模企業共済・iDeCo" question="小規模企業共済やiDeCo（個人型確定拠出年金）に入っている？">
            <Yen label="払った掛金の合計" value={inputs.small_business_mutual_aid} onChange={(n) => set({ small_business_mutual_aid: n })} hint="払った全額が差し引けます" />
          </Section>

          <Section {...sec("life_insurance")} title="生命保険料" question="生命保険・医療保険・個人年金保険に入っている？">
            <p className="text-sm text-sub">保険会社から届く「控除証明書」に書いてある金額を入れてね。「新制度」「旧制度」の区分も書いてあります</p>
            <Yen label="一般の生命保険（新制度）" value={li.new_general} onChange={(n) => set({ life_insurance: { ...li, new_general: n } })} />
            <Yen label="一般の生命保険（旧制度）" value={li.old_general} onChange={(n) => set({ life_insurance: { ...li, old_general: n } })} />
            <Yen label="介護医療保険" value={li.new_medical} onChange={(n) => set({ life_insurance: { ...li, new_medical: n } })} />
            <Yen label="個人年金保険（新制度）" value={li.new_pension} onChange={(n) => set({ life_insurance: { ...li, new_pension: n } })} />
            <Yen label="個人年金保険（旧制度）" value={li.old_pension} onChange={(n) => set({ life_insurance: { ...li, old_pension: n } })} />
          </Section>

          <Section {...sec("earthquake")} title="地震保険料" question="火災保険に地震保険をつけている？">
            <Yen label="地震保険料" value={eq.earthquake} onChange={(n) => set({ earthquake_insurance: { ...eq, earthquake: n } })} />
            <Yen label="旧長期損害保険料（あれば）" value={eq.old_long_term} onChange={(n) => set({ earthquake_insurance: { ...eq, old_long_term: n } })} hint="平成18年までに結んだ10年以上の保険" />
          </Section>

          <Section {...sec("medical")} title="医療費" question="病院や薬に、家族あわせて10万円以上はらった？">
            <Choice name="med-mode" value={med.mode} onChange={(mode) => set({ medical: { ...med, mode } })} options={[
              { value: "medical", label: "医療費控除", hint: "家族の分もあわせて、10万円（所得が200万円未満なら所得の5%）をこえた分" },
              { value: "self_medication", label: "セルフメディケーション税制", hint: "対象の市販薬が12,000円をこえた分（上限88,000円）。健康診断などを受けた人" },
            ]} />
            <Yen label="払った金額" value={med.paid} onChange={(n) => set({ medical: { ...med, paid: n } })} />
            <Yen label="保険などで戻ってきた金額" value={med.reimbursed} onChange={(n) => set({ medical: { ...med, reimbursed: n } })} hint="高額療養費・生命保険の入院給付金など" />
          </Section>

          <Section {...sec("donations")} title="ふるさと納税・寄附" question="ふるさと納税や寄附をした？">
            <Yen label="寄附した金額の合計" value={inputs.donations} onChange={(n) => set({ donations: n })} hint="ワンストップ特例を申し込んでいても、確定申告をするならここに入れてね（特例は使えなくなるため）" />
          </Section>

          <Section {...sec("family")} title="家族" question="いっしょに暮らす配偶者・子・親はいる？">
            <FamilyEditor family={inputs.family ?? []} onChange={(family) => set({ family })} />
          </Section>

          <Section {...sec("self")} title="本人のこと" question="あてはまるものはある？（なければそのまま）">
            <Field label="障害者手帳など" htmlFor="self-dis">
              <select id="self-dis" className={cx(inputClass, "appearance-auto")} value={me.disability ?? ""} onChange={(e) => set({ self: { ...me, disability: (e.target.value || null) as typeof me.disability } })}>
                <option value="">なし</option><option value="normal">障害者</option><option value="special">特別障害者</option>
              </select>
            </Field>
            <label className="flex items-center gap-2"><input type="checkbox" className="size-5 accent-[var(--accent)]" checked={me.single_parent} onChange={(e) => set({ self: { ...me, single_parent: e.target.checked, widow: e.target.checked ? false : me.widow } })} />ひとり親（結婚していなくて、生計をいっしょにする子がいる）</label>
            <label className="flex items-center gap-2"><input type="checkbox" className="size-5 accent-[var(--accent)]" checked={me.widow} onChange={(e) => set({ self: { ...me, widow: e.target.checked, single_parent: e.target.checked ? false : me.single_parent } })} />寡婦（夫と死別・離婚した女性など）</label>
            <label className="flex items-center gap-2"><input type="checkbox" className="size-5 accent-[var(--accent)]" checked={me.working_student} onChange={(e) => set({ self: { ...me, working_student: e.target.checked } })} />勤労学生</label>
          </Section>

          <Section {...sec("other_income")} title="ほかの所得" question="仕事以外の所得はある？（年金・ほかの副収入など）">
            <Yen label="そのほかの所得の合計" value={(inputs.other_incomes ?? [])[0]?.income} onChange={(n) => set({ other_incomes: n ? [{ label: "そのほか", income: n }] : [] })}
              hint="収入から経費を引いた「所得」の金額" />
          </Section>

          <Section {...sec("credits")} title="住宅ローン・予定納税" question="住宅ローン控除や、前もって払った税金（予定納税）はある？">
            <Yen label="住宅ローン控除の額" value={inputs.tax_credits?.housing_loan} onChange={(n) => set({ tax_credits: { housing_loan: n } })} hint="「住宅借入金等特別控除額の計算明細書」で出した金額" />
            <Yen label="予定納税で払った額" value={inputs.prepaid_tax} onChange={(n) => set({ prepaid_tax: n })} hint="税務署から「予定納税額の通知書」が届いた人だけ" />
            <Yen label="ほかに源泉徴収された税金" value={inputs.withholding_extra} onChange={(n) => set({ withholding_extra: n })} hint="帳簿に記録していない支払調書の分など" />
          </Section>

          {message && <Notice tone={message.tone} title={message.text} />}
          <div className="sticky bottom-20 z-10 print:hidden sm:bottom-4">
            <Button onClick={() => void save()} loading={busy} full>保存して計算する</Button>
          </div>

          <div className="flex flex-col gap-5 print:gap-3">
            <h2 className="hidden text-xl font-bold print:block">{year}年分 確定申告で入れる数字（申告ノート）</h2>
            <Result data={live} />
            <Guide data={live} />
            {live.consumption && <Consumption c={live.consumption} />}
          </div>
          <Button variant="secondary" className="print:hidden" onClick={() => window.print()}>🖨️ 印刷・PDFで保存</Button>
        </>
      )}
    </div>
  );
}

export default function TaxPage() {
  return (
    <RequireSession>
      <Tax />
    </RequireSession>
  );
}
