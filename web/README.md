# 申告ノート：画面（web/）

Next.js 16（TypeScript）で作り、HTML・JS・CSSに書き出して S3 + CloudFront で配る（サーバーなし）。

## 動かし方

| やりたいこと | コマンド |
|---|---|
| お試しモード（AWSにつながない）で動かす | `npm run dev:mock` → http://localhost:3100 |
| 本物のAPI・ログインで動かす | `.env.example` を `.env.local` にコピーして値を入れ、`npm run dev` → http://localhost:3000 |
| 型チェック・書き方チェック | `npm run typecheck` / `npm run lint` |
| 単体テスト（Vitest） | `npm test` |
| 画面の自動テスト（Playwright） | `npm run build:mock` のあと `npm run e2e` |
| 勘定科目を変えたあと | `npm run gen:accounts`（お試しモード用の一覧を SQL から作りなおす） |

## つくり

- `app/` … 画面（ホーム・記録・一覧・直す・集計・設定・ログイン・はじめの質問）
- `components/` … 部品（ボタン・カード・入力欄・「これなに？」など）と、ログイン中の人の共有
- `lib/entry-builder.ts` … 「仕事でお金を使った」「報酬が入った」の入力 ⇔ 仕訳（借方・貸方）の変換
- `lib/api.ts` … API の呼び出し。DB が起動中（503）なら自動で待ってやりなおす
- `lib/auth.ts` … ログイン（Amazon Cognito）。お試しモードではブラウザの中だけで動く
- `lib/mock-api.ts` … お試しモードの API
