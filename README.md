# 申告ノート（shinkoku-note）

LINEにレシートを送るだけで帳簿がつき、freeeへの自動登録か、確定申告書に入れる値まで出せる、個人事業主向けのWebアプリ。
確定申告をまったく知らない人でも、質問に答えて写真を送るだけで申告まで進めることを目指しています。

> 🚧 作成中（Phase 1）。設計は [docs/design.md](docs/design.md) を見てください。

## できること（予定）

- LINEにレシート・控除証明書の写真を送ると、AIが読み取って自動で記録（あやしいものだけ確認）
- 固定費・社会保険料など、くり返すものは設定で1回登録するだけ
- freee連携モード：確定した仕訳をfreeeに自動登録
- アプリ内モード：収支内訳書・確定申告書の値・下書きPDF、申告の日のガイド
- インボイス登録者は消費税（2割特例・簡易課税・本則課税）にも対応

## 使っている技術

| 分野 | 技術 |
|---|---|
| 画面 | Next.js / TypeScript（S3 + CloudFront） |
| API・処理 | AWS Lambda（Python）、API Gateway、SQS、EventBridge Scheduler |
| DB | Amazon Aurora PostgreSQL Serverless v2（Data API） |
| ログイン | Amazon Cognito |
| インフラ | AWS CDK（TypeScript） |
| CI/CD | GitHub Actions（OIDCでAWSへ） |
| 外部連携 | LINE Messaging API、freee会計API、Gemini API |

## 進み具合

| Phase | 内容 | 状態 |
|---|---|---|
| 0 | 設計・準備 | ✅ |
| 1 | 土台をコードで（CDK・GitHub Actions） | ⬜ |
| 2 | DBと帳簿API | ⬜ |
| 3 | 画面 | ⬜ |
| 4 | 取り込み（LINE・CSV・くり返し設定） | ⬜ |
| 5 | freee連携 | ⬜ |
| 6 | 申告の計算・ガイド | ⬜ |
| 6.5 | インボイス（消費税） | ⬜ |
| 7 | 仕上げ | ⬜ |
