-- 0007: freee 連携（Phase 5）
-- - freee との接続（どの事業所に送るか・いつつないだか・何を送るか）
-- - OAuth の「合言葉（state）」（freee から戻ってきたとき、だれの許可かを確かめる）
-- - 送信の記録（送る予定・送った・失敗）。記録を直したら送りなおし、消したら freee でも消す
-- トークン（鍵）は DB ではなく、AWS の金庫（パラメータストア）に暗号化して置く

create table freee_connections (
  user_id      text primary key,
  company_id   bigint not null,
  company_name text not null default '',
  connected_at timestamptz not null default now(),   -- これより前に作った記録は送らない（二重防止）
  send_sources text[] not null default array['receipt', 'recurring', 'manual'] -- 送るもの（CSV は最初は送らない）
);

create table freee_oauth_states (
  state      text primary key,
  user_id    text not null,
  expires_at timestamptz not null
);

create table freee_syncs (
  entry_id    uuid primary key,          -- 記録を消しても、freee で消すために残す（外部キーにしない）
  user_id     text not null,
  op          text not null check (op in ('upsert', 'delete')),
  status      text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'skipped')),
  freee_kind  text check (freee_kind in ('deal', 'manual_journal')),
  freee_id    bigint,
  receipt_id  bigint,                    -- freee のファイルボックスに入れたレシート
  attempts    int not null default 0,
  last_error  text not null default '',
  updated_at  timestamptz not null default now()
);
create index freee_syncs_pending on freee_syncs (user_id) where status = 'pending';

alter table freee_connections  enable row level security;
alter table freee_oauth_states enable row level security;
alter table freee_syncs        enable row level security;
create policy own_rows on freee_connections
  using (user_id = current_setting('app.user_id', true)) with check (user_id = current_setting('app.user_id', true));
create policy own_rows on freee_oauth_states
  using (user_id = current_setting('app.user_id', true)) with check (user_id = current_setting('app.user_id', true));
create policy own_rows on freee_syncs
  using (user_id = current_setting('app.user_id', true)) with check (user_id = current_setting('app.user_id', true));

-- ───────── 記録が変わったら「送る予定」にする（どこから記録しても、ここで必ず拾う） ─────────
create function freee_mark_entry() returns trigger
language plpgsql as $$
declare
  e   journal_entries%rowtype;
  con freee_connections%rowtype;
  eid uuid;
begin
  if tg_table_name = 'journal_lines' then
    eid := coalesce(new.entry_id, old.entry_id);
    select * into e from journal_entries where id = eid;
    if not found then return null; end if;  -- 仕訳ごと消えた（そちらで処理する）
  elsif tg_op = 'DELETE' then
    e := old;
  else
    e := new;
  end if;

  select * into con from freee_connections where user_id = e.user_id;
  if not found then return null; end if;

  if tg_table_name = 'journal_entries' and tg_op = 'DELETE' then
    -- まだ送っていなければ予定を消すだけ。送っていたら freee でも消す
    delete from freee_syncs where entry_id = e.id and freee_id is null;
    update freee_syncs set op = 'delete', status = 'pending', attempts = 0, last_error = '', updated_at = now()
     where entry_id = e.id;
    return null;
  end if;

  if e.status <> 'confirmed' or e.created_at < con.connected_at
     or not ((case e.source when 'receipt' then 'receipt' when 'recurring' then 'recurring'
                            when 'csv' then 'csv' else 'manual' end) = any(con.send_sources)) then
    return null;  -- 下書き・つなぐ前の記録・送らない種類は送らない
  end if;

  insert into freee_syncs (entry_id, user_id, op) values (e.id, e.user_id, 'upsert')
  on conflict (entry_id) do update set op = 'upsert', status = 'pending', attempts = 0, last_error = '', updated_at = now();
  return null;
end;
$$;

create trigger journal_entries_freee
  after insert or update or delete on journal_entries
  for each row execute function freee_mark_entry();
create trigger journal_lines_freee
  after insert or delete on journal_lines
  for each row execute function freee_mark_entry();

-- ───────── freee から戻ってきたとき用の「特別な窓口」 ─────────
-- 戻ってきた時点ではログインの情報がないので、合言葉（state）から利用者を引く。1回きり・10分まで
create function freee_consume_state(p_state text) returns text
language plpgsql security definer set search_path = public as $$
declare
  found_user text;
begin
  delete from freee_oauth_states where state = p_state and expires_at > now()
  returning user_id into found_user;
  return found_user;
end;
$$;

-- 送る予定が残っている利用者（毎朝の見回り用）
create function users_with_pending_freee() returns setof text
language sql security definer set search_path = public stable as $$
  select distinct s.user_id from freee_syncs s join freee_connections c on c.user_id = s.user_id
   where s.status = 'pending' or (s.status = 'failed' and s.attempts < 10);
$$;

revoke all on function freee_consume_state(text) from public;
revoke all on function users_with_pending_freee() from public;
