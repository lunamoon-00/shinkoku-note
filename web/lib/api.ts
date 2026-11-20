// 帳簿のAPIを呼ぶ。ログインの通行証を付けて、エラーはやさしい日本語の ApiError にする。
// DBは使わないと自動で止まるので、「起動中（503）」なら少し待って自動でやりなおす。

import { auth } from "./auth";
import { config } from "./config";
import { mockFetch } from "./mock-api";
import type { Account, Entry, EntryInput, Profile, Summary } from "./types";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details: { field: string; message: string }[] = [],
  ) {
    super(message);
  }
}

/** DBが起きるのを待っているあいだ、画面に「少し待ってね」を出すための合図 */
type WaitingListener = (waiting: boolean) => void;
const waitingListeners = new Set<WaitingListener>();
export function onDbWaking(fn: WaitingListener): () => void {
  waitingListeners.add(fn);
  return () => waitingListeners.delete(fn);
}
const setWaiting = (w: boolean) => waitingListeners.forEach((fn) => fn(w));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 起動中のときに待つ秒数（合計で約50秒まで） */
const RETRY_DELAYS_MS = [3000, 5000, 8000, 10000, 12000, 12000];

async function rawFetch(method: string, path: string, body?: unknown): Promise<Response> {
  const token = await auth.accessToken();
  if (!token) throw new ApiError(401, "UNAUTHORIZED", "ログインしてください");
  const init: RequestInit = {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
  if (config.mock) return mockFetch(method, path, body);
  try {
    return await fetch(`${config.apiUrl}${path}`, init);
  } catch {
    throw new ApiError(0, "NETWORK", "通信できませんでした。インターネットにつながっているか確かめてください");
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res = await rawFetch(method, path, body);
  for (let i = 0; res.status === 503 && i < RETRY_DELAYS_MS.length; i++) {
    setWaiting(true);
    await sleep(RETRY_DELAYS_MS[i]);
    res = await rawFetch(method, path, body);
  }
  setWaiting(false);

  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = data?.error;
    if (res.status === 401) throw new ApiError(401, "UNAUTHORIZED", "ログインの期限が切れました。もう一度ログインしてください");
    if (res.status === 429) throw new ApiError(429, "TOO_MANY", "たくさん操作したので、少し待ってからためしてください");
    throw new ApiError(
      res.status,
      err?.code ?? "UNKNOWN",
      err?.message ?? "うまくいきませんでした。時間をおいてもう一度ためしてください",
      err?.details ?? [],
    );
  }
  return data as T;
}

export const api = {
  me: () => request<Profile>("GET", "/me"),
  updateMe: (patch: Partial<Profile>) => request<Profile>("PUT", "/me", patch),
  accounts: () => request<{ accounts: Account[] }>("GET", "/accounts").then((r) => r.accounts),
  entries: (year: number) => request<{ entries: Entry[] }>("GET", `/entries?year=${year}`).then((r) => r.entries),
  entry: (id: string) => request<Entry>("GET", `/entries/${encodeURIComponent(id)}`),
  createEntry: (input: EntryInput) => request<Entry>("POST", "/entries", input),
  updateEntry: (id: string, input: EntryInput) => request<Entry>("PUT", `/entries/${encodeURIComponent(id)}`, input),
  confirmEntry: (id: string) => request<Entry>("POST", `/entries/${encodeURIComponent(id)}/confirm`),
  deleteEntry: (id: string) => request<void>("DELETE", `/entries/${encodeURIComponent(id)}`),
  summary: (year: number) => request<Summary>("GET", `/summary?year=${year}`),
};
