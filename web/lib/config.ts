// 画面の設定。値は公開して問題ないもの（APIのURL・Cognitoの番号）だけ。
// .env.local（手元）や GitHub Actions の環境変数から入る。

export const config = {
  /** お試しモード：AWSにつながず、ブラウザの中だけで動く（テスト・デザイン確認用） */
  mock: process.env.NEXT_PUBLIC_MOCK === "1",
  apiUrl: process.env.NEXT_PUBLIC_API_URL ?? "",
  userPoolId: process.env.NEXT_PUBLIC_USER_POOL_ID ?? "",
  userPoolClientId: process.env.NEXT_PUBLIC_USER_POOL_CLIENT_ID ?? "",
};
