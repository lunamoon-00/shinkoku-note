-- 0012: インボイス（消費税）の設定と、年ごとの消費税のルール（Phase 6.5）

create table invoice_settings (
  user_id             text primary key,
  registered          boolean not null default false,          -- インボイス登録している（チェック）
  registration_number text check (registration_number ~ '^T[0-9]{13}$'),
  registered_on       date,                                   -- 登録日（この日より前の売上は免税）
  method              text not null default 'two_tenths' check (method in ('two_tenths', 'simplified', 'standard')),
  business_category   int check (business_category between 1 and 6), -- 簡易課税の事業区分（第1種〜第6種）
  updated_at          timestamptz not null default now()
);
alter table invoice_settings enable row level security;
create policy own_rows on invoice_settings
  using (user_id = current_setting('app.user_id', true)) with check (user_id = current_setting('app.user_id', true));

-- 2割特例：令和5年10月1日〜令和8年9月30日の日をふくむ課税期間（個人は 令和5年分〜令和8年分）。売上税額 × 20% を納める
-- 簡易課税：みなし仕入率（第1種90%・第2種80%・第3種70%・第4種60%・第5種50%・第6種40%）
-- 税率：10%のうち国 7.8%・地方 2.2%（＝国の消費税額 × 22/78）
insert into tax_rules (year, key, value, source_url)
select y, 'consumption',
  '{"special":"two_tenths","special_payable_percent":20,"national_rate_permille":78,"local_ratio":[22,78],"deemed_rates":{"1":90,"2":80,"3":70,"4":60,"5":50,"6":40}}'::jsonb,
  'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6505.htm'
from (values (2025), (2026)) as t(y);
