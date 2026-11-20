-- 0004: LINEでレシートを送って記録する（4a）
-- - LINE とアプリの利用者のひも付け（6けたの番号で）
-- - 取りこんだ写真の記録（同じ写真を2回送ったら気づけるように、画像のハッシュを持つ）
-- - 覚えた科目（お店 → 科目）

-- ───────── LINE とのひも付け ─────────
create table line_links (
  user_id      text primary key,
  line_user_id text not null unique,
  linked_at    timestamptz not null default now()
);

-- アプリで出す6けたの番号（10分で期限切れ）
create table line_link_codes (
  code       text primary key check (code ~ '^[0-9]{6}$'),
  user_id    text not null unique,      -- 1人1つだけ（出しなおすと前の番号は消える）
  expires_at timestamptz not null
);

-- ───────── 取りこんだファイル ─────────
create table import_files (
  id            uuid primary key default gen_random_uuid(),
  user_id       text not null,
  kind          text not null check (kind in ('receipt', 'csv')),
  via           text not null check (via in ('line', 'web')),
  s3_key        text not null,
  image_hash    text,                   -- 画像の中身から作る指紋（SHA-256）
  status        text not null default 'queued'
                check (status in ('queued', 'auto_confirmed', 'needs_review', 'duplicate', 'not_receipt', 'failed')),
  review_reason text not null default '',
  error         text not null default '',
  ai_result     jsonb,                  -- AIが読み取った中身（あとで見直せるように）
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, image_hash)
);
create index import_files_user_created on import_files (user_id, created_at desc);

alter table journal_entries add column import_file_id uuid references import_files (id) on delete set null;

-- ───────── 覚えた科目（このお店はこの科目） ─────────
create table partner_rules (
  user_id      text not null,
  partner_key  text not null,           -- お店の名前をそろえたもの（空白をとる・小文字にする）
  account_code text not null references accounts (code),
  updated_at   timestamptz not null default now(),
  primary key (user_id, partner_key)
);

-- ───────── RLS（自分の行しか見えない） ─────────
alter table line_links      enable row level security;
alter table line_link_codes enable row level security;
alter table import_files    enable row level security;
alter table partner_rules   enable row level security;

create policy own_rows on line_links
  using (user_id = current_setting('app.user_id', true))
  with check (user_id = current_setting('app.user_id', true));
create policy own_rows on line_link_codes
  using (user_id = current_setting('app.user_id', true))
  with check (user_id = current_setting('app.user_id', true));
create policy own_rows on import_files
  using (user_id = current_setting('app.user_id', true))
  with check (user_id = current_setting('app.user_id', true));
create policy own_rows on partner_rules
  using (user_id = current_setting('app.user_id', true))
  with check (user_id = current_setting('app.user_id', true));

-- ───────── LINE から届いたときだけ使う「特別な窓口」 ─────────
-- LINE の通知には「LINE の利用者番号」しか入っていないので、アプリの利用者番号はまだ分からない。
-- そこで、この2つの関数だけは持ち主（postgres）の権限で動かして、番号の引き当てだけをする。
-- （security definer：関数の持ち主の権限で動く。中でやることを最小限にしぼっている）

-- 6けたの番号で LINE とアプリの利用者をひも付ける。成功したらアプリの利用者番号を返す
create function line_link_by_code(p_code text, p_line_user_id text) returns text
language plpgsql security definer set search_path = public as $$
declare
  found_user text;
begin
  delete from line_link_codes
   where code = p_code and expires_at > now()
  returning user_id into found_user;
  if found_user is null then
    return null;
  end if;
  -- 同じ LINE が別の利用者につながっていたら外してから、つなぎなおす
  delete from line_links where line_user_id = p_line_user_id or user_id = found_user;
  insert into line_links (user_id, line_user_id) values (found_user, p_line_user_id);
  return found_user;
end;
$$;

-- LINE の利用者番号から、アプリの利用者番号を引く（つながっていなければ null）
create function line_user_lookup(p_line_user_id text) returns text
language sql security definer set search_path = public stable as $$
  select user_id from line_links where line_user_id = p_line_user_id;
$$;

-- だれでも呼べる状態をやめて、アプリ用ユーザーだけに許す
revoke all on function line_link_by_code(text, text) from public;
revoke all on function line_user_lookup(text) from public;
