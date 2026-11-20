// 仕訳の一覧（ホームの「最近の記録」と、一覧の画面で使う）
"use client";

import Link from "next/link";
import { describeEntry } from "@/lib/entry-builder";
import { dateLabel } from "@/lib/format";
import type { Entry } from "@/lib/types";
import { Money, cx } from "./ui";

export function EntryList({ entries }: { entries: Entry[] }) {
  return (
    <ul className="flex flex-col divide-y divide-line">
      {entries.map((e) => {
        const d = describeEntry(e);
        return (
          <li key={e.id}>
            <Link href={`/entries/edit/?id=${e.id}`} className="flex items-center gap-3 py-3.5 transition hover:opacity-80">
              <span
                aria-hidden
                className={cx(
                  "grid size-10 shrink-0 place-items-center rounded-2xl text-lg",
                  d.tone === "in" ? "bg-in-soft" : d.tone === "out" ? "bg-out-soft" : "bg-surface-2",
                )}
              >
                {d.tone === "in" ? "💴" : d.tone === "out" ? "🧾" : "🛠️"}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-bold">
                  {d.label}
                  {e.status === "draft" && <span className="ml-2 rounded-full bg-warn-soft px-2 py-0.5 text-xs text-warn">確認待ち</span>}
                </span>
                <span className="block truncate text-sm text-sub">
                  {dateLabel(e.entry_date)}
                  {(e.partner || e.description) && `・${[e.partner, e.description].filter(Boolean).join("・")}`}
                </span>
              </span>
              <Money value={e.total} tone={d.tone === "in" ? "in" : d.tone === "out" ? "out" : undefined} />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function YearPicker({ year, onChange }: { year: number; onChange: (y: number) => void }) {
  const thisYear = new Date().getFullYear();
  return (
    <div className="inline-flex items-center gap-1 rounded-2xl bg-surface p-1 shadow-card" role="group" aria-label="年をえらぶ">
      <button type="button" className="grid size-10 place-items-center rounded-xl text-sub hover:bg-surface-2" aria-label="前の年" onClick={() => onChange(year - 1)}>
        ‹
      </button>
      <span className="num min-w-20 text-center font-bold" aria-live="polite">{year}年</span>
      <button type="button" className="grid size-10 place-items-center rounded-xl text-sub hover:bg-surface-2 disabled:opacity-30" aria-label="次の年"
        disabled={year >= thisYear} onClick={() => onChange(year + 1)}>
        ›
      </button>
    </div>
  );
}
