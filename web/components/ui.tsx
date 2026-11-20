// 画面の部品（ボタン・カード・入力欄など）。全部の画面でこれを使って見た目をそろえる。
"use client";

import Link from "next/link";
import { useId, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { yen } from "@/lib/format";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

// ───────── ボタン ─────────
type Variant = "primary" | "secondary" | "ghost" | "danger";
const variants: Record<Variant, string> = {
  primary: "bg-accent text-on-accent hover:bg-accent-strong shadow-card",
  secondary: "bg-surface text-text border border-line hover:bg-surface-2",
  ghost: "text-accent hover:bg-accent-soft",
  danger: "bg-danger-soft text-danger hover:brightness-95",
};

export function Button({
  variant = "primary",
  loading = false,
  full = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean; full?: boolean }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        "inline-flex min-h-12 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-2xl px-5 font-bold transition",
        "disabled:cursor-not-allowed disabled:opacity-60",
        variants[variant],
        full && "w-full",
        className,
      )}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

export function ButtonLink({ href, variant = "primary", full = false, children }: { href: string; variant?: Variant; full?: boolean; children: ReactNode }) {
  return (
    <Link
      href={href}
      className={cx(
        "inline-flex min-h-12 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-2xl px-5 font-bold transition",
        variants[variant],
        full && "w-full",
      )}
    >
      {children}
    </Link>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2" role={label ? "status" : undefined}>
      <span className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
      {label && <span>{label}</span>}
    </span>
  );
}

// ───────── カード・見出し ─────────
export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cx("rounded-[var(--radius-card)] bg-surface p-4 shadow-card sm:p-5", className)}>{children}</section>;
}

export function PageTitle({ title, lead }: { title: string; lead?: ReactNode }) {
  return (
    <header className="mb-5">
      <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
      {lead && <p className="mt-1 text-sub">{lead}</p>}
    </header>
  );
}

// ───────── 金額 ─────────
export function Money({ value, tone, className }: { value: number; tone?: "in" | "out"; className?: string }) {
  return <span className={cx("num font-bold", tone === "in" && "text-in", tone === "out" && "text-out", className)}>{yen(value)}</span>;
}

// ───────── お知らせ ─────────
export function Notice({ tone = "info", title, children }: { tone?: "info" | "warn" | "danger" | "success"; title?: string; children?: ReactNode }) {
  const tones = {
    info: "bg-accent-soft text-text",
    warn: "bg-warn-soft text-text",
    danger: "bg-danger-soft text-text",
    success: "bg-in-soft text-text",
  };
  const icons = { info: "💡", warn: "⏳", danger: "⚠️", success: "✅" };
  return (
    <div className={cx("flex gap-3 rounded-2xl p-4", tones[tone])} role={tone === "danger" ? "alert" : "status"}>
      <span aria-hidden className="text-lg leading-7">{icons[tone]}</span>
      <div className="min-w-0">
        {title && <p className="font-bold">{title}</p>}
        {children && <div className="text-[15px] text-sub">{children}</div>}
      </div>
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon: string; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-[var(--radius-card)] border-2 border-dashed border-line px-6 py-10 text-center">
      <span className="text-4xl" aria-hidden>{icon}</span>
      <p className="font-bold">{title}</p>
      {children && <p className="text-sub">{children}</p>}
      {action}
    </div>
  );
}

// ───────── 「これなに？」 ─────────
export function Help({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="inline-block align-middle">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={id}
        className="ml-1 inline-flex h-7 items-center rounded-full bg-accent-soft px-2.5 text-xs font-bold text-accent"
      >
        これなに？
      </button>
      {open && (
        <span id={id} role="note" className="mt-2 block rounded-2xl bg-surface-2 p-3 text-[15px] font-normal text-text">
          <span className="block font-bold">{title}</span>
          <span className="block text-sub">{children}</span>
        </span>
      )}
    </span>
  );
}

// ───────── 入力欄 ─────────
export function Field({
  label,
  hint,
  error,
  help,
  children,
  htmlFor,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  help?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div>
        <label htmlFor={htmlFor} className="font-bold">{label}</label>
        {help}
      </div>
      {hint && <p className="text-sm text-sub">{hint}</p>}
      {children}
      {error && (
        <p className="text-sm font-bold text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export const inputClass =
  "min-h-12 w-full rounded-2xl border border-line bg-surface px-4 text-[17px] text-text placeholder:text-sub/60 " +
  "focus:border-accent focus:outline-none focus:ring-4 focus:ring-accent-soft aria-[invalid=true]:border-danger";

/** 大きな選択肢（ラジオボタンをカードの形にしたもの） */
export function Choice<T extends string>({
  name,
  value,
  options,
  onChange,
}: {
  name: string;
  value: T;
  options: { value: T; label: string; hint?: string; icon?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div role="radiogroup" className="flex flex-col gap-2">
      {options.map((o) => {
        const checked = o.value === value;
        return (
          <label
            key={o.value}
            className={cx(
              "flex min-h-12 cursor-pointer items-start gap-2.5 rounded-2xl border-2 px-3.5 py-3 transition",
              checked ? "border-accent bg-accent-soft" : "border-line bg-surface hover:border-accent/50",
            )}
          >
            <input type="radio" name={name} value={o.value} checked={checked} onChange={() => onChange(o.value)} className="mt-1.5 size-4 accent-[var(--accent)]" />
            {o.icon && <span className="text-xl leading-7" aria-hidden>{o.icon}</span>}
            <span className="min-w-0">
              <span className="block font-bold">{o.label}</span>
              {o.hint && <span className="block text-sm text-sub">{o.hint}</span>}
            </span>
          </label>
        );
      })}
    </div>
  );
}

export { cx };
