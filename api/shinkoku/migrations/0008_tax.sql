-- 0008: 確定申告の計算（Phase 6a）
-- - 年ごとの税のルール（数字は docs/tax-rules.md と同じ。国税庁のページで確かめたもの）
-- - 利用者が入れる「控除・家族・ほかの所得・源泉徴収・予定納税など」（年ごとに1つ）
-- - 仕訳の行の印（源泉徴収された分など）

alter table journal_lines add column tag text check (tag in ('withholding'));

create table tax_inputs (
  user_id    text not null,
  year       int not null check (year between 2025 and 2100),
  inputs     jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, year)
);
alter table tax_inputs enable row level security;
create policy own_rows on tax_inputs
  using (user_id = current_setting('app.user_id', true)) with check (user_id = current_setting('app.user_id', true));

create table tax_rules (
  year       int not null,
  key        text not null,
  value      jsonb not null,
  source_url text not null,
  primary key (year, key)
);

-- 金額はすべて円。表は [上限（以下）, 値] の並び。上限が null なら「それより上ぜんぶ」
insert into tax_rules (year, key, value, source_url) values
-- ───────── 令和7年分（2025年分） ─────────
(2025, 'basic_deduction', '[[1320000,950000],[3360000,880000],[4890000,680000],[6550000,630000],[23500000,580000],[24000000,480000],[24500000,320000],[25000000,160000],[null,0]]',
 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1199.htm'),
(2025, 'dependent_income_limit', '580000', 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1191.htm'),
(2025, 'spouse_special', '[[950000,[380000,260000,130000]],[1000000,[360000,240000,120000]],[1050000,[310000,210000,110000]],[1100000,[260000,180000,90000]],[1150000,[210000,140000,70000]],[1200000,[160000,110000,60000]],[1250000,[110000,80000,40000]],[1300000,[60000,40000,20000]],[1330000,[30000,20000,10000]]]',
 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1195.htm'),
(2025, 'specific_relative', '[[850000,630000],[900000,610000],[950000,510000],[1000000,410000],[1050000,310000],[1100000,210000],[1150000,110000],[1200000,60000],[1230000,30000]]',
 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1177.htm'),
(2025, 'single_parent_child_income_limit', '580000', 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1171.htm'),
(2025, 'working_student_income_limit', '850000', 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1175.htm'),
(2025, 'life_insurance_young_dependent', 'false', 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1140.htm'),
-- ───────── 令和8年分（2026年分）：令和8年度税制改正（令和8年12月1日施行・令和8年分から） ─────────
(2026, 'basic_deduction', '[[4890000,1040000],[6550000,670000],[23500000,620000],[24000000,480000],[24500000,320000],[25000000,160000],[null,0]]',
 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1199.htm'),
(2026, 'dependent_income_limit', '620000', 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1191.htm'),
(2026, 'spouse_special', '[[950000,[380000,260000,130000]],[1000000,[360000,240000,120000]],[1050000,[310000,210000,110000]],[1100000,[260000,180000,90000]],[1150000,[210000,140000,70000]],[1200000,[160000,110000,60000]],[1250000,[110000,80000,40000]],[1300000,[60000,40000,20000]],[1330000,[30000,20000,10000]]]',
 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1195.htm'),
(2026, 'specific_relative', '[[850000,630000],[900000,610000],[950000,510000],[1000000,410000],[1050000,310000],[1100000,210000],[1150000,110000],[1200000,60000],[1230000,30000]]',
 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1177.htm'),
(2026, 'single_parent_child_income_limit', '620000', 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1171.htm'),
(2026, 'working_student_income_limit', '890000', 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1175.htm'),
(2026, 'life_insurance_young_dependent', 'true', 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1140.htm');

-- 両方の年で同じもの
insert into tax_rules (year, key, value, source_url)
select y, k, v::jsonb, u from (values
  ('rate_table', '[[1949000,5,0],[3299000,10,97500],[6949000,20,427500],[8999000,23,636000],[17999000,33,1536000],[39999000,40,2796000],[null,45,4796000]]',
   'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2260.htm'),
  ('reconstruction_rate_permille', '21', 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2260.htm'),
  ('spouse_deduction', '[[9000000,380000,480000],[9500000,260000,320000],[10000000,130000,160000]]',
   'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1191.htm'),
  ('dependent_amounts', '{"general":380000,"specific":630000,"elderly_living_with_parent":580000,"elderly":480000}',
   'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1180.htm'),
  ('disability_amounts', '{"normal":270000,"special":400000,"special_living_together":750000}',
   'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1160.htm'),
  ('widow', '{"amount":270000,"income_limit":5000000}', 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1170.htm'),
  ('single_parent', '{"amount":350000,"income_limit":5000000}', 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1171.htm'),
  ('working_student_amount', '270000', 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1175.htm'),
  ('medical', '{"floor":100000,"floor_rate_percent":5,"floor_rate_under":2000000,"cap":2000000}',
   'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1120.htm'),
  ('self_medication', '{"floor":12000,"cap":88000}', 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1129.htm'),
  ('donation', '{"floor":2000,"income_rate_percent":40}', 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1150.htm'),
  ('earthquake', '{"cap":50000}', 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1145.htm'),
  ('senjusha', '{"spouse":860000,"other":500000}', 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2075.htm')
) as t(k, v, u)
cross join (values (2025), (2026)) as years(y);
