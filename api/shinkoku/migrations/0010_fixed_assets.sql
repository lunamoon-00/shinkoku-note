-- 0010: 減価償却（10万円以上のパソコンなど、何年かに分けて経費にするもの）
-- 償却率は「減価償却資産の耐用年数等に関する省令」別表第八（平成19年4月1日以後に取得した資産の定額法）を
-- e-Gov で直接読んで入れた（千分率。例：4年 → 250 ＝ 0.250）。3年が 0.334、9年が 0.112 など、ただの 1÷年数 ではない。

create table fixed_assets (
  id             uuid primary key default gen_random_uuid(),
  user_id        text not null,
  name           text not null check (length(name) between 1 and 50),   -- 例：ノートパソコン
  acquired_on    date not null,          -- 仕事で使い始めた日
  cost           bigint not null check (cost > 0 and cost <= 1000000000), -- 取得価額（買った値段）
  useful_life    int not null check (useful_life between 2 and 100),     -- 耐用年数
  method         text not null default 'straight' check (method in ('straight', 'lump3')), -- 定額法／一括償却（3年）
  business_ratio int not null default 100 check (business_ratio between 1 and 100), -- 仕事で使う割合
  disposed_on    date,                   -- 売った・捨てた日（その年までで終わり）
  created_at     timestamptz not null default now()
);
create index fixed_assets_user on fixed_assets (user_id);
alter table fixed_assets enable row level security;
create policy own_rows on fixed_assets
  using (user_id = current_setting('app.user_id', true)) with check (user_id = current_setting('app.user_id', true));

insert into tax_rules (year, key, value, source_url)
select y, 'straight_line_rates',
  '{"2":500,"3":334,"4":250,"5":200,"6":167,"7":143,"8":125,"9":112,"10":100,"11":91,"12":84,"13":77,"14":72,"15":67,"16":63,"17":59,"18":56,"19":53,"20":50,"21":48,"22":46,"23":44,"24":42,"25":40,"26":39,"27":38,"28":36,"29":35,"30":34,"31":33,"32":32,"33":31,"34":30,"35":29,"36":28,"37":28,"38":27,"39":26,"40":25,"41":25,"42":24,"43":24,"44":23,"45":23,"46":22,"47":22,"48":21,"49":21,"50":20,"51":20,"52":20,"53":19,"54":19,"55":19,"56":18,"57":18,"58":18,"59":17,"60":17,"61":17,"62":17,"63":16,"64":16,"65":16,"66":16,"67":15,"68":15,"69":15,"70":15,"71":15,"72":14,"73":14,"74":14,"75":14,"76":14,"77":13,"78":13,"79":13,"80":13,"81":13,"82":13,"83":13,"84":12,"85":12,"86":12,"87":12,"88":12,"89":12,"90":12,"91":11,"92":11,"93":11,"94":11,"95":11,"96":11,"97":11,"98":11,"99":11,"100":10}'::jsonb,
  'https://laws.e-gov.go.jp/law/340M50000040015'
from (values (2025), (2026)) as t(y);
