"use client";

// はじめの質問。はい/いいえで答えるだけで、設定ができあがる。
// （健康保険・年金・家族などの質問は、Phase 6 でここに足していく）

import { useRouter } from "next/navigation";
import { useState } from "react";
import { RequireSession, useSession } from "@/components/session";
import { Button, Card, Choice, Field, Help, inputClass, Notice } from "@/components/ui";
import { api, ApiError } from "@/lib/api";

type Answer3 = "yes" | "no" | "unknown";

function Questions() {
  const router = useRouter();
  const { profile, setProfile } = useSession();
  const [step, setStep] = useState(0);
  const [name, setName] = useState(profile.display_name);
  const [freee, setFreee] = useState<Answer3>(profile.mode === "freee" ? "yes" : "no");
  const [filing, setFiling] = useState<"white" | "blue" | "unknown">(profile.filing_type);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const steps = [
    {
      title: "まずは、なんて呼べばいい？",
      lead: "画面のあいさつに使います。ニックネームでOK",
      body: (
        <Field label="呼び名" htmlFor="name">
          <input id="name" className={inputClass} value={name} maxLength={50} autoFocus onChange={(e) => setName(e.target.value)} placeholder="例：みちる" />
        </Field>
      ),
    },
    {
      title: "freee（フリー）を使っていますか？",
      lead: "使っていれば、ここで記録したものを freee にも自動で入れられるようにします（あとで設定から変えられます）",
      body: (
        <Choice<Answer3>
          name="freee"
          value={freee}
          onChange={setFreee}
          options={[
            { value: "yes", label: "使っている", icon: "🔗", hint: "記録を freee に送ります（送る機能はもうすぐ使えます）" },
            { value: "no", label: "使っていない", icon: "📒", hint: "このアプリの中で、確定申告に入れる数字まで出します" },
            { value: "unknown", label: "わからない", icon: "🤔", hint: "「使っていない」で始めます。あとで変えられます" },
          ]}
        />
      ),
    },
    {
      title: "白色申告？ 青色申告？",
      lead: (
        <>
          税務署に「青色申告承認申請書」を出していなければ、白色申告です
          <Help title="白色申告と青色申告">
            どちらも確定申告のやり方の名前です。青色申告は、前もって税務署に届けを出して、きちんとした帳簿をつけると、税金が安くなるしくみがあります。届けを出していなければ白色申告です。
          </Help>
        </>
      ),
      body: (
        <Choice
          name="filing"
          value={filing}
          onChange={setFiling}
          options={[
            { value: "white", label: "白色申告", icon: "⚪", hint: "届けを出していない（いちばん多い）" },
            { value: "blue", label: "青色申告", icon: "🔵", hint: "青色申告の届けを出している（青色の書類はもうすぐ対応）" },
            { value: "unknown", label: "わからない", icon: "🤔", hint: "白色申告で始めます。あとで変えられます" },
          ]}
        />
      ),
    },
  ];

  const last = step === steps.length - 1;
  const current = steps[step];

  async function finish() {
    setBusy(true);
    setError("");
    try {
      const updated = await api.updateMe({
        display_name: name.trim(),
        mode: freee === "yes" ? "freee" : "in_app",
        filing_type: filing === "blue" ? "blue" : "white",
        onboarded: true,
      });
      setProfile(updated);
      router.replace("/");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "保存できませんでした");
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 pt-4">
      <div>
        <p className="text-sm font-bold text-accent">
          はじめの質問 {step + 1} / {steps.length}
        </p>
        <div className="mt-2 flex gap-1.5" aria-hidden>
          {steps.map((_, i) => (
            <span key={i} className={`h-1.5 flex-1 rounded-full ${i <= step ? "bg-accent" : "bg-line"}`} />
          ))}
        </div>
      </div>
      <div>
        <h1 className="text-2xl font-bold">{current.title}</h1>
        <p className="mt-2 text-sub">{current.lead}</p>
      </div>
      <Card>{current.body}</Card>
      {error && <Notice tone="danger" title="うまくいきませんでした">{error}</Notice>}
      <div className="flex gap-3">
        {step > 0 && (
          <Button variant="secondary" onClick={() => setStep(step - 1)} disabled={busy}>
            もどる
          </Button>
        )}
        <Button full onClick={() => (last ? void finish() : setStep(step + 1))} loading={busy}>
          {last ? "はじめる" : "つぎへ"}
        </Button>
      </div>
    </div>
  );
}

export default function WelcomePage() {
  return (
    <RequireSession allowNotOnboarded>
      <Questions />
    </RequireSession>
  );
}
