"use client";

// 記録を直す・確定する・消す。URL は /entries/edit/?id=… の形
// （サーバーを持たない静的な書き出しなので、URLの途中に番号を入れるページは作れないため）

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { EntryEditor } from "@/components/entry-editor";
import { FreeeBadge } from "@/components/freee-badge";
import { ReceiptPhoto } from "@/components/receipt-photo";
import { RequireSession } from "@/components/session";
import { Button, ButtonLink, Card, Notice, PageTitle, Spinner } from "@/components/ui";
import { useLoad } from "@/components/use-load";
import { api, ApiError } from "@/lib/api";
import { fromEntry } from "@/lib/entry-builder";
import { dateLabel } from "@/lib/format";

function Edit() {
  const router = useRouter();
  const id = useSearchParams().get("id") ?? "";
  const [state, reload] = useLoad(async () => {
    const [entry, accounts] = await Promise.all([api.entry(id), api.accounts()]);
    return { entry, accounts };
  }, id);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState<"delete" | "confirm" | null>(null);
  const [error, setError] = useState("");

  if (state.status === "loading") return <div className="py-10 text-center text-sub"><Spinner label="読みこんでいます…" /></div>;
  if (state.status === "error") {
    return (
      <div className="flex flex-col gap-3">
        <Notice tone="danger" title="見つかりませんでした">{state.message}</Notice>
        <div className="flex gap-3">
          <Button variant="secondary" onClick={reload}>もう一度ためす</Button>
          <ButtonLink href="/entries/" variant="ghost">一覧にもどる</ButtonLink>
        </div>
      </div>
    );
  }

  const { entry, accounts } = state.data;
  const expenseCodes = new Set(accounts.filter((a) => a.kind === "expense").map((a) => a.code));
  const initial = fromEntry(entry, expenseCodes);

  async function remove() {
    setBusy("delete");
    setError("");
    try {
      await api.deleteEntry(entry.id);
      router.push("/entries/?deleted=1");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "消せませんでした");
      setBusy(null);
    }
  }

  async function confirm() {
    setBusy("confirm");
    setError("");
    try {
      await api.confirmEntry(entry.id);
      reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "確定できませんでした");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-5">
      <PageTitle title="記録を直す" lead={`${dateLabel(entry.entry_date)}の記録`} />
      {entry.status === "draft" && (
        <Notice tone="warn" title="確認待ちの記録です">
          中身が合っていれば「確定する」を押してください。確定するまで、集計には入りません。
          {entry.source === "receipt" && "科目を直して保存すると、次からそのお店は自動でその科目にします"}
          <div className="mt-3">
            <Button onClick={() => void confirm()} loading={busy === "confirm"}>確定する</Button>
          </div>
        </Notice>
      )}
      {error && <Notice tone="danger" title="うまくいきませんでした">{error}</Notice>}
      {entry.has_receipt && <ReceiptPhoto entryId={entry.id} />}
      <FreeeBadge entryId={entry.id} key={`freee-${entry.updated_at}`} />

      <EntryEditor
        key={entry.updated_at}
        accounts={accounts}
        initial={initial}
        allowKindChange={initial.kind !== "advanced"}
        submitLabel="直した内容で保存する"
        onSubmit={async (input) => {
          // 確認待ちのものを直して保存したら、確定もする（本人が中身を見たので）
          await api.updateEntry(entry.id, { ...input, status: "confirmed" });
          router.push("/entries/?saved=1");
        }}
      />

      <Card className="flex flex-col gap-3">
        <h2 className="font-bold">この記録を消す</h2>
        {!confirmingDelete ? (
          <Button variant="danger" onClick={() => setConfirmingDelete(true)}>消す</Button>
        ) : (
          <>
            <p className="text-sub">本当に消しますか？ 消すと元にもどせません</p>
            <div className="flex gap-3">
              <Button variant="secondary" onClick={() => setConfirmingDelete(false)} disabled={busy === "delete"}>やめる</Button>
              <Button variant="danger" onClick={() => void remove()} loading={busy === "delete"}>消す</Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

export default function EditPage() {
  return (
    <RequireSession>
      <Suspense>
        <Edit />
      </Suspense>
    </RequireSession>
  );
}
