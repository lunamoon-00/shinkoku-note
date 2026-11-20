// ログイン中の人と、その人の設定（profile）を画面全体で共有する。
// ログインしていなければログイン画面へ、はじめの質問がまだなら質問の画面へ案内する。
"use client";

import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError } from "@/lib/api";
import { auth } from "@/lib/auth";
import type { Profile } from "@/lib/types";
import { Button, Notice, Spinner } from "./ui";

interface Session {
  email: string;
  profile: Profile;
  setProfile: (p: Profile) => void;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession は RequireSession の中で使ってください");
  return s;
}

type State =
  | { status: "loading" }
  | { status: "ready"; email: string; profile: Profile }
  | { status: "error"; message: string };

/** ログインが必要な画面をこれで包む */
export function RequireSession({ children, allowNotOnboarded = false }: { children: ReactNode; allowNotOnboarded?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const [state, setState] = useState<State>({ status: "loading" });

  const load = useCallback(async () => {
    setState({ status: "loading" });
    const email = await auth.currentUser();
    if (!email) {
      router.replace(`/login/?next=${encodeURIComponent(pathname)}`);
      return;
    }
    try {
      const profile = await api.me();
      if (!profile.onboarded && !allowNotOnboarded) {
        router.replace("/welcome/");
        return;
      }
      setState({ status: "ready", email, profile });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        await auth.signOut();
        router.replace("/login/");
        return;
      }
      setState({ status: "error", message: e instanceof Error ? e.message : "読みこめませんでした" });
    }
  }, [router, pathname, allowNotOnboarded]);

  useEffect(() => {
    // 画面を開いたときに、ログインと設定を読みこむ
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  if (state.status === "loading") {
    return (
      <div className="flex min-h-[50vh] items-center justify-center text-sub">
        <Spinner label="読みこんでいます…" />
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="flex flex-col gap-4">
        <Notice tone="danger" title="読みこめませんでした">{state.message}</Notice>
        <Button variant="secondary" onClick={() => void load()}>もう一度ためす</Button>
      </div>
    );
  }
  const session: Session = {
    email: state.email,
    profile: state.profile,
    setProfile: (profile) => setState({ ...state, profile }),
    signOut: async () => {
      await auth.signOut();
      router.replace("/login/");
    },
  };
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}
