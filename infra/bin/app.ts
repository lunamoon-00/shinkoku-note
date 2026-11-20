// CDK の入口。どのスタック（AWSの部品のまとまり）を作るかを並べる。
import { App, Tags } from "aws-cdk-lib";
import { GithubOidcStack } from "../lib/github-oidc-stack.js";
import { ShinkokuStack } from "../lib/shinkoku-stack.js";

const app = new App();

// アカウント番号はコードに書かず、そのとき使っている認証情報から自動で入る
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: "ap-southeast-2", // シドニー（このアカウントは東京を使えない）
};

new GithubOidcStack(app, "ShinkokuGithubOidc", {
  env,
  repository: "lunamoon-00/shinkoku-note",
  description: "申告ノート: GitHub Actions から AWS に入るための設定",
});

new ShinkokuStack(app, "Shinkoku", {
  env,
  description: "申告ノート: ログイン・DB・ファイル置き場・画面の配信",
});

// 全部の部品に「どのプロジェクトのものか」の札をつける（料金の内訳で見分けられる）
Tags.of(app).add("project", "shinkoku-note");
