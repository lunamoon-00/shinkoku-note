-- アプリ用のDBユーザー（shinkoku_app）と、使ってよい範囲。
-- マイグレーションのたびに毎回流す（何回流しても同じ結果になるように書く）。
-- shinkoku_app はテーブルの持ち主ではないので、RLS（自分の行しか見えないルール）が必ず効く。

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'shinkoku_app') then
    create role shinkoku_app login;
  end if;
  -- AWS では IAM の通行証でログインする（手元のテスト用DBには rds_iam が無いので飛ばす）
  if exists (select 1 from pg_roles where rolname = 'rds_iam') then
    grant rds_iam to shinkoku_app;
  end if;
end;
$$;

grant usage on schema public to shinkoku_app;
grant select on accounts to shinkoku_app;
grant select, insert, update on profiles to shinkoku_app;
grant select, insert, update, delete on journal_entries, journal_lines to shinkoku_app;
grant select, insert on audit_logs to shinkoku_app;
grant select on account_totals to shinkoku_app;
grant usage on all sequences in schema public to shinkoku_app;
