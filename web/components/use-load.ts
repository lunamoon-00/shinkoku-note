// APIからデータを読みこむときの決まった形（読みこみ中・失敗・もう一度）。
// key が変わったら読みこみなおす（例：年を切りかえたとき）。
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type Loaded<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: T };

export function useLoad<T>(load: () => Promise<T>, key: string | number = ""): [Loaded<T>, () => void] {
  const [state, setState] = useState<Loaded<T>>({ status: "loading" });
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  const reload = useCallback(() => {
    setState({ status: "loading" });
    loadRef.current().then(
      (data) => setState({ status: "ready", data }),
      (e: unknown) => setState({ status: "error", message: e instanceof Error ? e.message : "読みこめませんでした" }),
    );
  }, []);

  useEffect(() => {
    // 画面を開いたとき・key が変わったときに読みこむ
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reload();
  }, [reload, key]);

  return [state, reload];
}
