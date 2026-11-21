-- 0006: くり返し設定（毎月おなじお金を自動で記録）と、週1の確認待ちのお知らせ（4c）

create table recurring_rules (
  id             uuid primary key default gen_random_uuid(),
  user_id        text not null,
  name           text not null check (length(name) between 1 and 50),  -- 例：家賃
  account_code   text not null references accounts (code),            -- 経費の科目
  amount         bigint not null check (amount > 0 and amount <= 10000000), -- 毎月払う金額（全額）
  business_ratio int not null default 100 check (business_ratio between 1 and 100), -- 仕事で使う割合（家事按分）
  day_of_month   int not null check (day_of_month between 1 and 31),   -- 31 にすると、短い月は月末
  paid_from      text not null default 'personal' check (paid_from in ('personal', 'business')),
  start_month    date not null check (extract(day from start_month) = 1), -- いつから（その月の1日）
  end_month      date check (end_month is null or extract(day from end_month) = 1),
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);
create index recurring_rules_user on recurring_rules (user_id);

-- どの設定の、何月分を記録したか（同じ月を二重に記録しないため）
create table recurring_runs (
  rule_id  uuid not null references recurring_rules (id) on delete cascade,
  user_id  text not null,
  month    date not null,                       -- その月の1日
  entry_id uuid references journal_entries (id) on delete set null,
  primary key (rule_id, month)
);

alter table recurring_rules enable row level security;
alter table recurring_runs  enable row level security;
create policy own_rows on recurring_rules
  using (user_id = current_setting('app.user_id', true))
  with check (user_id = current_setting('app.user_id', true));
create policy own_rows on recurring_runs
  using (user_id = current_setting('app.user_id', true))
  with check (user_id = current_setting('app.user_id', true));

-- 目覚まし（毎朝・毎週）から使う「特別な窓口」。
-- 目覚ましは特定の利用者としてではなく動くので、「記録が必要な人」「お知らせが必要な人」の番号だけを返す。
-- 中身の記録そのものは、その人として（RLS つきで）行う。

-- 有効な設定を持っている利用者の一覧
create function users_with_recurring_rules() returns setof text
language sql security definer set search_path = public stable as $$
  select distinct user_id from recurring_rules where active;
$$;

-- 確認待ちがあって、LINE とつながっている利用者と、その件数
create function users_to_remind() returns table (user_id text, line_user_id text, drafts bigint)
language sql security definer set search_path = public stable as $$
  select e.user_id, l.line_user_id, count(*)
    from journal_entries e
    join line_links l on l.user_id = e.user_id
   where e.status = 'draft'
   group by e.user_id, l.line_user_id;
$$;

revoke all on function users_with_recurring_rules() from public;
revoke all on function users_to_remind() from public;
