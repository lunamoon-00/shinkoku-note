-- 0011: 写真から読み取った控除証明書など（国民年金・生命保険・ふるさと納税・源泉徴収票…）
-- 読み取った金額は、確定申告の計算のときに、手で入れた金額に足して使う。

alter table import_files drop constraint import_files_kind_check;
alter table import_files add constraint import_files_kind_check check (kind in ('receipt', 'csv', 'certificate'));

create table tax_documents (
  id             uuid primary key default gen_random_uuid(),
  user_id        text not null,
  year           int not null check (year between 2025 and 2100),
  kind           text not null check (kind in (
                   'social_insurance', 'small_business', 'life_insurance', 'earthquake',
                   'donation', 'salary', 'medical_notice', 'payment_record')),
  issuer         text not null default '',   -- 発行元（例：日本年金機構・○○生命）
  amounts        jsonb not null,             -- 種類ごとの金額
  import_file_id uuid references import_files (id) on delete set null,
  created_at     timestamptz not null default now()
);
create index tax_documents_user_year on tax_documents (user_id, year);
alter table tax_documents enable row level security;
create policy own_rows on tax_documents
  using (user_id = current_setting('app.user_id', true)) with check (user_id = current_setting('app.user_id', true));
