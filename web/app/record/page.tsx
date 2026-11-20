"use client";

import { useRouter } from "next/navigation";
import { blankForm, EntryEditor } from "@/components/entry-editor";
import { RequireSession } from "@/components/session";
import { Button, Notice, PageTitle, Spinner } from "@/components/ui";
import { useLoad } from "@/components/use-load";
import { api } from "@/lib/api";

function Record() {
  const router = useRouter();
  const [accounts, reload] = useLoad(() => api.accounts());

  return (
    <div className="mx-auto max-w-xl">
      <PageTitle title="記録する" lead="どんなお金かを選んで、金額を入れるだけ。借方・貸方は自動でつけます" />
      {accounts.status === "loading" && <div className="py-10 text-center text-sub"><Spinner label="読みこんでいます…" /></div>}
      {accounts.status === "error" && (
        <div className="flex flex-col gap-3">
          <Notice tone="danger" title="読みこめませんでした">{accounts.message}</Notice>
          <Button variant="secondary" onClick={reload}>もう一度ためす</Button>
        </div>
      )}
      {accounts.status === "ready" && (
        <EntryEditor
          accounts={accounts.data}
          initial={blankForm("expense")}
          submitLabel="記録する"
          onSubmit={async (input) => {
            await api.createEntry(input);
            router.push("/entries/?saved=1");
          }}
        />
      )}
    </div>
  );
}

export default function RecordPage() {
  return (
    <RequireSession>
      <Record />
    </RequireSession>
  );
}
