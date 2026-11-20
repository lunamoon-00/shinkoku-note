"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";
import { Button, Card, Field, inputClass, Notice } from "@/components/ui";
import { auth, AuthError } from "@/lib/auth";
import { config } from "@/lib/config";

type Mode = "signIn" | "newPassword" | "forgot" | "reset";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next");
  // 戻り先はこのアプリの中だけ（外のサイトに飛ばされないように）
  const goNext = () => router.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/");

  const [mode, setMode] = useState<Mode>("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setError("");
    setInfo("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof AuthError ? e.message : "うまくいきませんでした。もう一度ためしてください");
    } finally {
      setBusy(false);
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (mode === "signIn") {
      void run(async () => {
        const result = await auth.signIn(email, password);
        if (result === "newPasswordRequired") {
          setPassword("");
          setMode("newPassword");
        } else goNext();
      });
    } else if (mode === "newPassword") {
      void run(async () => {
        await auth.completeNewPassword(password);
        goNext();
      });
    } else if (mode === "forgot") {
      void run(async () => {
        await auth.requestPasswordReset(email);
        setMode("reset");
        setInfo("確認コードをメールで送りました。メールに書いてある6けたの数字を入れてください");
      });
    } else {
      void run(async () => {
        await auth.confirmPasswordReset(email, code, password);
        setPassword("");
        setMode("signIn");
        setInfo("パスワードを変えました。新しいパスワードでログインしてください");
      });
    }
  };

  const titles: Record<Mode, { title: string; lead: string; submit: string }> = {
    signIn: { title: "ログイン", lead: "メールアドレスとパスワードを入れてください", submit: "ログイン" },
    newPassword: { title: "新しいパスワードを決めましょう", lead: "初めてのログインなので、自分だけのパスワードに変えてください", submit: "このパスワードにする" },
    forgot: { title: "パスワードを忘れたとき", lead: "登録しているメールアドレスに、確認コードを送ります", submit: "確認コードを送る" },
    reset: { title: "新しいパスワード", lead: "メールの確認コードと、新しいパスワードを入れてください", submit: "パスワードを変える" },
  };
  const t = titles[mode];
  const needsNewPassword = mode === "newPassword" || mode === "reset";

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 pt-6">
      <div className="text-center">
        <p className="text-4xl" aria-hidden>📒</p>
        <h1 className="mt-2 text-2xl font-bold">{t.title}</h1>
        <p className="mt-1 text-sub">{t.lead}</p>
      </div>

      {config.mock && mode === "signIn" && (
        <Notice tone="warn" title="お試しモードです">
          どんなメールアドレス・パスワードでも入れます（「new」で始まるメールなら、初めてのログインを試せます）
        </Notice>
      )}
      {info && <Notice tone="success">{info}</Notice>}
      {error && <Notice tone="danger" title="うまくいきませんでした">{error}</Notice>}

      <Card>
        <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
          {(mode === "signIn" || mode === "forgot" || mode === "reset") && (
            <Field label="メールアドレス" htmlFor="email">
              <input id="email" type="email" autoComplete="username" inputMode="email" required value={email}
                onChange={(e) => setEmail(e.target.value)} className={inputClass} disabled={mode === "reset"} />
            </Field>
          )}
          {mode === "reset" && (
            <Field label="確認コード（6けた）" htmlFor="code">
              <input id="code" inputMode="numeric" autoComplete="one-time-code" required value={code}
                onChange={(e) => setCode(e.target.value)} className={inputClass} />
            </Field>
          )}
          {mode !== "forgot" && (
            <Field
              label={needsNewPassword ? "新しいパスワード" : "パスワード"}
              htmlFor="password"
              hint={needsNewPassword ? "12文字以上で、英大文字・英小文字・数字をまぜてください" : undefined}
            >
              <input id="password" type="password" required value={password}
                autoComplete={needsNewPassword ? "new-password" : "current-password"}
                onChange={(e) => setPassword(e.target.value)} className={inputClass} />
            </Field>
          )}
          <Button type="submit" loading={busy} full>{t.submit}</Button>
        </form>
      </Card>

      <div className="text-center">
        {mode === "signIn" ? (
          <button type="button" className="font-bold text-accent underline-offset-4 hover:underline" onClick={() => { setMode("forgot"); setError(""); setInfo(""); }}>
            パスワードを忘れたとき
          </button>
        ) : (
          <button type="button" className="font-bold text-accent underline-offset-4 hover:underline" onClick={() => { setMode("signIn"); setError(""); setInfo(""); }}>
            ログインにもどる
          </button>
        )}
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
