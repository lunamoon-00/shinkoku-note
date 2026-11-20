// はじめて使う人の流れを、最初から最後まで画面で試す（お試しモード）。
import { expect, test, type Page } from "@playwright/test";

async function login(page: Page, email = "demo@example.com") {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login\//);
  await page.getByLabel("メールアドレス").fill(email);
  await page.getByLabel("パスワード").fill("anything");
  await page.getByRole("button", { name: "ログイン" }).click();
}

async function onboard(page: Page) {
  await expect(page.getByText("はじめの質問 1 / 3")).toBeVisible();
  await page.getByLabel("呼び名").fill("みちる");
  await page.getByRole("button", { name: "つぎへ" }).click();
  await page.getByText("使っていない", { exact: true }).click();
  await page.getByRole("button", { name: "つぎへ" }).click();
  await page.getByText("白色申告", { exact: true }).click();
  await page.getByRole("button", { name: "はじめる" }).click();
  await expect(page.getByRole("heading", { name: /年の帳簿/ })).toBeVisible();
}

test("ログイン → はじめの質問 → 報酬と経費を記録 → 集計 → 直す → 消す", async ({ page }) => {
  await login(page);
  await onboard(page);
  await expect(page.getByText("みちるさん")).toBeVisible();
  await expect(page.getByText("まだ記録がありません")).toBeVisible();

  // 報酬：10万円、振り込みは 89,790円 → 源泉徴収 10,210円が自動で出る
  await page.goto("/record/");
  await page.getByText("報酬が入った", { exact: true }).click();
  await page.getByLabel("報酬はいくら？").fill("100000");
  await page.getByLabel("実際に振り込まれたのはいくら？").fill("89,790");
  await expect(page.getByText("源泉徴収された税金：")).toContainText("10,210円");
  await page.getByLabel("取引先").fill("A社");
  await page.getByRole("button", { name: /記録する/ }).click();
  await expect(page.getByText("記録しました")).toBeVisible();
  await expect(page.getByText("100,000円")).toBeVisible();

  // 経費：USBケーブル 3,300円（全角で入れてもOK）
  await page.goto("/record/");
  await page.getByLabel("金額").fill("３，３００");
  await page.getByLabel("何に使った？").selectOption({ label: "仕事の道具・文房具（消耗品費）" });
  await page.getByLabel("メモ").fill("USBケーブル");
  await page.getByRole("button", { name: /記録する/ }).click();
  await expect(page.getByText("記録しました")).toBeVisible();
  await expect(page.getByText("2件（新しい順）")).toBeVisible();

  // 集計：もうけの目安 = 100,000 − 3,300
  await page.goto("/summary/");
  await expect(page.getByText("96,700円")).toBeVisible();
  await expect(page.getByText("仕事の道具・文房具")).toBeVisible();

  // 直す：経費を 5,500円に
  await page.goto("/entries/");
  await page.getByRole("link", { name: /仕事の道具・文房具/ }).click();
  await expect(page.getByRole("heading", { name: "記録を直す" })).toBeVisible();
  await expect(page.getByLabel("金額")).toHaveValue("3,300");
  await page.getByLabel("金額").fill("5500");
  await page.getByRole("button", { name: /直した内容で保存する/ }).click();
  await expect(page.getByText("5,500円")).toBeVisible();

  // 消す：確認してから消える
  await page.getByRole("link", { name: /仕事の道具・文房具/ }).click();
  await page.getByRole("button", { name: "消す" }).click();
  await expect(page.getByText("本当に消しますか？")).toBeVisible();
  await page.getByRole("button", { name: "消す" }).last().click();
  await expect(page.getByText("消しました")).toBeVisible();
  await expect(page.getByText("1件（新しい順）")).toBeVisible();
});

test("入力がたりないと、どこを直せばいいか教える", async ({ page }) => {
  await login(page);
  await onboard(page);
  await page.goto("/record/");
  await page.getByRole("button", { name: /記録する/ }).click();
  await expect(page.getByText("金額を1円以上で入れてください")).toBeVisible();
  await expect(page.getByText("何に使ったかを選んでください")).toBeVisible();

  await page.getByText("報酬が入った", { exact: true }).click();
  await page.getByLabel("報酬はいくら？").fill("1000");
  await page.getByLabel("実際に振り込まれたのはいくら？").fill("2000");
  await page.getByRole("button", { name: /記録する/ }).click();
  await expect(page.getByText("振り込まれた金額が、報酬より多くなっています")).toBeVisible();
});

test("初めてのログインでは、新しいパスワードを決める", async ({ page }) => {
  await login(page, "new-user@example.com");
  await expect(page.getByRole("heading", { name: "新しいパスワードを決めましょう" })).toBeVisible();
  await page.getByLabel("新しいパスワード").fill("short");
  await page.getByRole("button", { name: "このパスワードにする" }).click();
  await expect(page.getByText(/12文字以上/).last()).toBeVisible();
  await page.getByLabel("新しいパスワード").fill("Longer-Password-1");
  await page.getByRole("button", { name: "このパスワードにする" }).click();
  await expect(page.getByText("はじめの質問 1 / 3")).toBeVisible();
});

test("DBが起動中でも、待ってから自動で読みこむ", async ({ page }) => {
  await login(page);
  await onboard(page);
  // ホームの読みこみが終わってから「次の1回は起動中」にする（ホームの読みこみに横取りされないように）
  await expect(page.getByText("まだ記録がありません")).toBeVisible();
  await page.evaluate(() => {
    window.__mockWakeOnce = true;
  });
  await page.getByRole("link", { name: /一覧/ }).first().click();
  await expect(page.getByText(/データベースを起こしています/)).toBeVisible();
  await expect(page.getByText(/年の記録はまだありません/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/データベースを起こしています/)).toBeHidden();
});

test("ログインしていないと、ログイン画面に案内する（戻り先は覚えておく）", async ({ page }) => {
  await page.goto("/summary/");
  await expect(page).toHaveURL(/\/login\/\?next=%2Fsummary/);
});
