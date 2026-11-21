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

-- 0004: LINE・取りこみ・覚えた科目
grant select, insert, update, delete on line_links, line_link_codes, partner_rules to shinkoku_app;
grant select, insert, update on import_files to shinkoku_app;
grant execute on function line_link_by_code(text, text) to shinkoku_app;
grant execute on function line_user_lookup(text) to shinkoku_app;

-- 0006: くり返し設定・お知らせ
grant select, insert, update, delete on recurring_rules to shinkoku_app;
grant select, insert on recurring_runs to shinkoku_app;
grant execute on function users_with_recurring_rules() to shinkoku_app;
grant execute on function users_to_remind() to shinkoku_app;

-- 0007: freee 連携
grant select, insert, update, delete on freee_connections, freee_oauth_states, freee_syncs to shinkoku_app;
grant execute on function freee_consume_state(text) to shinkoku_app;
grant execute on function users_with_pending_freee() to shinkoku_app;

-- 0008: 確定申告の計算
grant select on tax_rules to shinkoku_app;
grant select, insert, update on tax_inputs to shinkoku_app;

-- 0010: 減価償却
grant select, insert, update, delete on fixed_assets to shinkoku_app;

-- 0011: 写真から読み取った控除証明書
grant select, insert, delete on tax_documents to shinkoku_app;

-- 0012: インボイス
grant select, insert, update on invoice_settings to shinkoku_app;
