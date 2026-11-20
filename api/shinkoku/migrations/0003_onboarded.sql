-- 0003: 「はじめの質問」に答え終わった日時（まだなら null → 画面が質問のページを出す）
alter table profiles add column onboarded_at timestamptz;
