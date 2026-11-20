"use client";

import { useState, type FormEvent } from "react";
import { RequireSession, useSession } from "@/components/session";
import { Button, Card, Choice, Field, Help, inputClass, Notice, PageTitle } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import type { Profile } from "@/lib/types";

function Settings() {
  const { email, profile, setProfile, signOut } = useSession();
  const [draft, setDraft] = useState<Profile>(profile);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const updated = await api.updateMe({
        display_name: draft.display_name,
        business_name: draft.business_name,
        mode: draft.mode,
        filing_type: draft.filing_type,
      });
      setProfile(updated);
      setDraft(updated);
      setMessage({ tone: "success", text: "保存しました" });
    } catch (err) {
      setMessage({ tone: "danger", text: err instanceof ApiError ? [err.message, ...err.details.map((d) => d.message)].join("・") : "保存できませんでした" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-5">
      <PageTitle title="設定" lead={`${email} でログイン中`} />
      {message && <Notice tone={message.tone} title={message.text} />}
      <form onSubmit={save} className="flex flex-col gap-5">
        <Card className="flex flex-col gap-5">
          <Field label="呼び名" htmlFor="display_name">
            <input id="display_name" className={inputClass} maxLength={50} value={draft.display_name} onChange={(e) => setDraft({ ...draft, display_name: e.target.value })} />
          </Field>
          <Field label="屋号" htmlFor="business_name" hint="なければ空でOK" help={<Help title="屋号（やごう）">お店や事務所の名前のこと。開業届に書いた名前です。なくても確定申告はできます。</Help>}>
            <input id="business_name" className={inputClass} maxLength={50} value={draft.business_name} onChange={(e) => setDraft({ ...draft, business_name: e.target.value })} />
          </Field>
        </Card>
        <Card>
          <Field label="freee（フリー）とのつなぎ方">
            <Choice
              name="mode"
              value={draft.mode}
              onChange={(mode) => setDraft({ ...draft, mode })}
              options={[
                { value: "in_app", label: "このアプリだけで使う", hint: "確定申告に入れる数字まで、このアプリで出します" },
                { value: "freee", label: "freee に送る", hint: "記録を freee に自動で入れます（送る機能はもうすぐ使えます）" },
              ]}
            />
          </Field>
        </Card>
        <Card>
          <Field label="申告の種類">
            <Choice
              name="filing_type"
              value={draft.filing_type}
              onChange={(filing_type) => setDraft({ ...draft, filing_type })}
              options={[
                { value: "white", label: "白色申告" },
                { value: "blue", label: "青色申告", hint: "青色の書類はもうすぐ対応します" },
              ]}
            />
          </Field>
        </Card>
        <Button type="submit" loading={busy} full>保存する</Button>
      </form>
      <Card className="flex flex-col gap-3">
        <h2 className="font-bold">ログアウト</h2>
        <Button variant="secondary" onClick={() => void signOut()}>ログアウトする</Button>
      </Card>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <RequireSession>
      <Settings />
    </RequireSession>
  );
}
