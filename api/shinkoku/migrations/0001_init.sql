-- 0001: 帳簿の土台（利用者の設定・勘定科目・仕訳・操作の記録）
-- 金額はすべて「円の整数」。小数は使わない。

-- ───────── 勘定科目（全員共通のマスタ） ─────────
create table accounts (
  code          text primary key,              -- 例: '5100'
  name          text not null,                 -- 正式な名前（例: 消耗品費）
  friendly_name text not null,                 -- ふだんの言葉（例: 仕事の道具・文房具）
  description   text not null default '',      -- 「これなに？」の説明
  kind          text not null check (kind in ('asset', 'liability', 'equity', 'revenue', 'expense')),
  normal_side   text not null check (normal_side in ('debit', 'credit')), -- 増えるときの側
  white_line    text,                          -- 収支内訳書のどの欄か（売上・経費だけ）
  sort_order    int  not null
);

-- ───────── 利用者の設定 ─────────
create table profiles (
  user_id       text primary key,              -- Cognito の利用者番号（sub）
  display_name  text not null default '',
  filing_type   text not null default 'white' check (filing_type in ('white', 'blue')),
  mode          text not null default 'in_app' check (mode in ('freee', 'in_app')),
  business_name text not null default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ───────── 仕訳 ─────────
create table journal_entries (
  id          uuid primary key default gen_random_uuid(),
  user_id     text not null,
  entry_date  date not null,
  description text not null default '',        -- 摘要（何のお金か）
  partner     text not null default '',        -- 取引先・お店
  status      text not null default 'draft' check (status in ('draft', 'confirmed')),
  source      text not null default 'manual' check (source in ('manual', 'csv', 'receipt', 'recurring')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (id, user_id)                         -- 行（journal_lines）から「同じ持ち主」で参照するため
);
create index journal_entries_user_date on journal_entries (user_id, entry_date);

-- 仕訳の行（借方・貸方）
create table journal_lines (
  id           bigint generated always as identity primary key,
  entry_id     uuid not null,
  user_id      text not null,
  side         text not null check (side in ('debit', 'credit')),
  account_code text not null references accounts (code),
  amount       bigint not null check (amount > 0),
  -- 仕訳と行の持ち主が必ず同じになるようにする（他人の仕訳に行を足せない）
  foreign key (entry_id, user_id) references journal_entries (id, user_id) on delete cascade
);
create index journal_lines_entry on journal_lines (entry_id);

-- ───────── 帳簿のルール：借方の合計 ＝ 貸方の合計 ─────────
-- トランザクションの最後（COMMIT のとき）にまとめて確かめる（行を1行ずつ足している途中では確かめない）
create function check_entry_balanced() returns trigger
language plpgsql as $$
declare
  target uuid;
  line_count int;
  debit_sum bigint;
  credit_sum bigint;
begin
  -- どの仕訳を確かめるか（仕訳の表から呼ばれたときと、行の表から呼ばれたときで項目名がちがう）
  if tg_table_name = 'journal_entries' then
    target := new.id;
  elsif tg_op = 'DELETE' then
    target := old.entry_id;
  else
    target := new.entry_id;
  end if;
  -- 仕訳そのものが消えた場合は確かめなくてよい
  if not exists (select 1 from journal_entries where id = target) then
    return null;
  end if;
  select count(*),
         coalesce(sum(amount) filter (where side = 'debit'), 0),
         coalesce(sum(amount) filter (where side = 'credit'), 0)
    into line_count, debit_sum, credit_sum
    from journal_lines where entry_id = target;
  if line_count < 2 then
    raise exception 'ENTRY_TOO_FEW_LINES: 仕訳 % には借方と貸方の行が必要です', target;
  end if;
  if debit_sum <> credit_sum then
    raise exception 'ENTRY_UNBALANCED: 仕訳 % の借方 % 円と貸方 % 円が合っていません', target, debit_sum, credit_sum;
  end if;
  return null;
end;
$$;

create constraint trigger journal_lines_balanced
  after insert or update or delete on journal_lines
  deferrable initially deferred
  for each row execute function check_entry_balanced();

create constraint trigger journal_entries_balanced
  after insert on journal_entries
  deferrable initially deferred
  for each row execute function check_entry_balanced();

-- ───────── 操作の記録 ─────────
create table audit_logs (
  id         bigint generated always as identity primary key,
  user_id    text not null,
  action     text not null,                    -- 例: entry.create
  target     text not null default '',
  created_at timestamptz not null default now()
);

-- ───────── 2人のデータを分ける（RLS：行レベルセキュリティ） ─────────
-- API はリクエストごとに app.user_id にログイン中の人の番号を入れる。
-- その番号と同じ user_id の行しか、見る・足す・変える・消すことができない。
alter table profiles        enable row level security;
alter table journal_entries enable row level security;
alter table journal_lines   enable row level security;
alter table audit_logs      enable row level security;

create policy own_rows on profiles
  using (user_id = current_setting('app.user_id', true))
  with check (user_id = current_setting('app.user_id', true));
create policy own_rows on journal_entries
  using (user_id = current_setting('app.user_id', true))
  with check (user_id = current_setting('app.user_id', true));
create policy own_rows on journal_lines
  using (user_id = current_setting('app.user_id', true))
  with check (user_id = current_setting('app.user_id', true));
create policy own_rows on audit_logs
  using (user_id = current_setting('app.user_id', true))
  with check (user_id = current_setting('app.user_id', true));

-- ───────── 集計：年・科目ごとの合計（確定した仕訳だけ） ─────────
-- security_invoker: 見る人の権限で動く → RLS がそのまま効く
create view account_totals with (security_invoker = true) as
select e.user_id,
       extract(year from e.entry_date)::int as year,
       l.account_code,
       -- 円の整数のまま返す（sum はそのままだと小数も扱える型になるため）
       coalesce(sum(l.amount) filter (where l.side = 'debit'), 0)::bigint  as debit_total,
       coalesce(sum(l.amount) filter (where l.side = 'credit'), 0)::bigint as credit_total
  from journal_entries e
  join journal_lines l on l.entry_id = e.id
 where e.status = 'confirmed'
 group by e.user_id, extract(year from e.entry_date), l.account_code;
