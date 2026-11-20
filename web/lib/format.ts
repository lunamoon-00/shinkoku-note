// 金額・日付の見せ方

const yenFormatter = new Intl.NumberFormat("ja-JP");

/** 3,300 → "3,300円" */
export function yen(n: number): string {
  return `${yenFormatter.format(n)}円`;
}

/** "2026-01-10" → "1月10日（土）" */
export function dateLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const day = "日月火水木金土"[new Date(y, m - 1, d).getDay()];
  return `${m}月${d}日（${day}）`;
}

/** 今日の日付（"2026-11-21"）。日本時間で */
export function todayIso(now: Date = new Date()): string {
  const jst = new Date(now.getTime() + (9 * 60 + now.getTimezoneOffset()) * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${jst.getFullYear()}-${pad(jst.getMonth() + 1)}-${pad(jst.getDate())}`;
}

/** 金額の入力欄の文字（"3,300" や "３３００"）→ 数（入れていなければ 0） */
export function parseYen(text: string): number {
  const half = text.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const digits = half.replace(/[,，\s円]/g, "");
  if (!/^\d+$/.test(digits)) return 0;
  return Number(digits);
}
