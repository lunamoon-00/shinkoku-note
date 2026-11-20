// 画面の外わく：上のタイトル、スマホでは下のメニュー、パソコンでは上のメニュー。
// DBが起きるのを待っているあいだは「少し待ってね」の帯を出す。
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { onDbWaking } from "@/lib/api";
import { config } from "@/lib/config";
import { cx } from "./ui";

const NAV = [
  { href: "/", label: "ホーム", icon: "🏠" },
  { href: "/entries/", label: "一覧", icon: "📒" },
  { href: "/record/", label: "記録する", icon: "＋", primary: true },
  { href: "/summary/", label: "集計", icon: "📊" },
  { href: "/settings/", label: "設定", icon: "⚙️" },
];

const BARE_PAGES = ["/login", "/welcome"]; // メニューを出さない画面

function isActive(pathname: string, href: string) {
  const p = pathname.replace(/\/$/, "") || "/";
  const h = href.replace(/\/$/, "") || "/";
  return h === "/" ? p === "/" : p === h || p.startsWith(`${h}/`);
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const bare = BARE_PAGES.some((p) => pathname.startsWith(p));
  const [waking, setWaking] = useState(false);
  useEffect(() => onDbWaking(setWaking), []);

  return (
    <div className="mx-auto flex min-h-dvh max-w-3xl flex-col">
      <header className="sticky top-0 z-10 flex items-center justify-between gap-4 bg-bg/90 px-4 py-3 backdrop-blur">
        <Link href="/" className="flex items-center gap-2 font-bold">
          <span aria-hidden className="grid size-8 place-items-center rounded-xl bg-accent text-on-accent">申</span>
          <span>申告ノート</span>
          {config.mock && <span className="rounded-full bg-warn-soft px-2 text-xs text-warn">お試しモード</span>}
        </Link>
        {!bare && (
          <nav aria-label="メニュー" className="hidden gap-1 sm:flex">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                aria-current={isActive(pathname, n.href) ? "page" : undefined}
                className={cx(
                  "rounded-xl px-3 py-2 text-[15px] font-bold transition",
                  n.primary ? "bg-accent text-on-accent hover:bg-accent-strong" : "text-sub hover:bg-surface-2",
                  !n.primary && isActive(pathname, n.href) && "bg-accent-soft text-accent",
                )}
              >
                {n.primary ? "＋ 記録する" : n.label}
              </Link>
            ))}
          </nav>
        )}
      </header>

      {waking && (
        <div role="status" className="mx-4 mb-2 rounded-2xl bg-warn-soft px-4 py-3 text-[15px]">
          ⏳ データベースを起こしています。20〜30秒ほどで動きはじめます（しばらく使っていないと、お休みして料金を節約しています）
        </div>
      )}

      <main className={cx("flex-1 px-4 pt-2", bare ? "pb-10" : "pb-28 sm:pb-10")}>{children}</main>

      {!bare && (
        <nav
          aria-label="メニュー"
          className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden"
        >
          <ul className="mx-auto grid max-w-3xl grid-cols-5">
            {NAV.map((n) => {
              const active = isActive(pathname, n.href);
              return (
                <li key={n.href}>
                  <Link
                    href={n.href}
                    aria-current={active ? "page" : undefined}
                    className={cx("flex min-h-16 flex-col items-center justify-center gap-0.5 text-xs font-bold", active ? "text-accent" : "text-sub")}
                  >
                    <span
                      aria-hidden
                      className={cx(
                        "grid place-items-center",
                        n.primary ? "size-11 -translate-y-2 rounded-2xl bg-accent text-2xl text-on-accent shadow-card" : "text-xl",
                      )}
                    >
                      {n.icon}
                    </span>
                    <span className={cx(n.primary && "-mt-2")}>{n.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      )}
    </div>
  );
}
