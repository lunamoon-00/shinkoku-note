-- 0005: 銀行・カードの CSV 取りこみ（4b）
-- 1行ずつ「指紋（日付＋内容＋金額＋どこの明細か から作るハッシュ）」を持たせて、
-- 同じ行を二度取りこまないようにする。

alter table journal_entries add column import_row_hash text;
create unique index journal_entries_user_row_hash
  on journal_entries (user_id, import_row_hash) where import_row_hash is not null;

-- 取りこみの途中（確認画面）の行は import_files.ai_result に入れておく。
-- 確定したら status を 'done' にする
alter table import_files drop constraint import_files_status_check;
alter table import_files add constraint import_files_status_check
  check (status in ('queued', 'auto_confirmed', 'needs_review', 'duplicate', 'not_receipt', 'failed', 'done'));
