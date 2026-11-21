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

test("LINEとつなぐ：番号を出すと、つながる（お試しモード）", async ({ page }) => {
  await login(page);
  await onboard(page);
  await page.goto("/settings/");
  await page.getByRole("button", { name: "番号を出す" }).click();
  await expect(page.getByText("LINEとつながっています")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "つなぐのをやめる" }).click();
  await expect(page.getByRole("button", { name: "番号を出す" })).toBeVisible();
});

test("レシートの確認待ち：写真を見て、科目を直して確定する", async ({ page }) => {
  await login(page);
  await onboard(page);
  // LINE から下書きが届いた状態をつくる
  await page.evaluate(() => {
    const raw = JSON.parse(sessionStorage.getItem("shinkoku-mock-db")!);
    raw.entries.push({
      id: "r1", entry_date: "2026-11-20", description: "コーヒー", partner: "カフェ", status: "draft", source: "receipt",
      created_at: "2026-11-20T00:00:00Z", updated_at: "2026-11-20T00:00:00Z", total: 600, has_receipt: true,
      lines: [
        { side: "debit", account_code: "5900", amount: 600, account_name: "雑費", friendly_name: "そのほかの経費" },
        { side: "credit", account_code: "2900", amount: 600, account_name: "事業主借", friendly_name: "生活のお金で仕事の物を買った" },
      ],
    });
    sessionStorage.setItem("shinkoku-mock-db", JSON.stringify(raw));
  });
  await page.reload();
  await page.getByText("確認待ちが 1件 あります").click();
  await expect(page.getByText("確認待ち").first()).toBeVisible();
  await page.getByRole("link", { name: /そのほかの経費/ }).click();
  await expect(page.getByRole("img", { name: "送ったレシートの写真" })).toBeVisible();
  await page.getByLabel("何に使った？").selectOption({ label: "打ち合わせのお茶代（会議費）" });
  await page.getByRole("button", { name: /直した内容で保存する/ }).click();
  await expect(page.getByText("記録しました")).toBeVisible();
  await page.goto("/");
  await expect(page.getByText(/確認待ちが/)).toBeHidden();
  await expect(page.getByText("打ち合わせのお茶代")).toBeVisible();
});

test("CSVから取りこむ：仕事の分だけ選んで、科目を直して取りこむ", async ({ page }) => {
  await login(page);
  await onboard(page);
  await page.goto("/record/");
  await page.getByText("銀行・カードのCSVからまとめて取りこむ").click();
  await page.getByLabel("CSVファイル").setInputFiles({
    name: "card.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("ご利用日,ご利用店名,ご利用金額\n2026/11/03,文房具店,1100\n2026/11/04,スーパー,2180\n"),
  });
  await page.getByRole("button", { name: "読みこむ" }).click();
  await expect(page.getByRole("heading", { name: "仕事の分に✅をつけてね" })).toBeVisible();
  await page.getByLabel(/スーパー .* を取りこむ/).uncheck();
  await page.getByLabel("文房具店 の科目").selectOption({ label: "本・新聞・資料代（新聞図書費）" });
  await page.getByRole("button", { name: /✅の1件を取りこむ/ }).click();
  await expect(page.getByText("1件を記録しました")).toBeVisible();
  await page.goto("/summary/");
  await expect(page.getByText("本・新聞・資料代")).toBeVisible();
  await expect(page.getByText("スーパー")).toBeHidden();
});

test("毎月の固定費：家賃を30%で登録すると、過去の月の分がまとめて記録される", async ({ page }) => {
  await login(page);
  await onboard(page);
  await page.goto("/recurring/");
  await expect(page.getByText("まだ登録がありません")).toBeVisible();
  await page.getByRole("button", { name: /家賃/ }).click();
  await page.getByLabel("毎月の金額（全額）").fill("80000");
  await expect(page.getByText("24,000円")).toBeVisible();
  await page.getByLabel("いつから？").fill(`${new Date().getFullYear()}-01`);
  await page.getByRole("button", { name: "登録する" }).click();
  await expect(page.getByText(/登録しました/)).toBeVisible();
  await expect(page.getByText("80,000円 の 30%")).toBeVisible();
  await page.getByRole("button", { name: "お休みする" }).click();
  await expect(page.getByText("お休み中")).toBeVisible();
});

test("freeeとつなぐ：許可してもどってくると、つながって送るものを選べる（お試しモード）", async ({ page }) => {
  await login(page);
  await onboard(page);
  await page.goto("/settings/");
  await page.getByRole("button", { name: "freeeとつなぐ" }).click();
  await expect(page.getByText("freee とつながりました！")).toBeVisible();
  await expect(page.getByText("お試し事業所 とつながっています")).toBeVisible();
  const csv = page.getByRole("checkbox", { name: /CSVで取りこんだもの/ });
  await expect(csv).not.toBeChecked();
  await csv.check();
  await expect(csv).toBeChecked();
  await page.getByRole("button", { name: "つなぐのをやめる" }).click();
  await page.getByRole("button", { name: "やめる", exact: true }).click();
  await expect(page.getByRole("button", { name: "freeeとつなぐ" })).toBeVisible();
});

test("確定申告の準備：社会保険料を入れて保存すると、税金のめやすとチェックリストが更新される", async ({ page }) => {
  await login(page);
  await onboard(page);
  await page.goto("/record/");
  await page.getByText("報酬が入った", { exact: true }).click();
  await page.getByLabel("報酬はいくら？").fill("3000000");
  await page.getByLabel("実際に振り込まれたのはいくら？").fill("2693700");
  await page.getByRole("button", { name: /記録する/ }).click();
  await expect(page.getByText("記録しました")).toBeVisible();

  await page.goto("/");
  await page.getByText("確定申告の準備").click();
  await expect(page.getByRole("heading", { name: "確定申告の準備" })).toBeVisible();
  await page.getByRole("button", { name: /健康保険・年金など/ }).click();
  await page.getByLabel("払った社会保険料の合計").fill("300000");
  await page.getByRole("checkbox", { name: /確認した/ }).check();
  await page.getByRole("button", { name: "保存して計算する" }).click();
  await expect(page.getByText("保存して、計算しなおしました")).toBeVisible();
  await expect(page.getByText("戻ってくるお金（還付）のめやす")).toBeVisible();
  await expect(page.getByRole("heading", { name: "申告の日に入れる数字" })).toBeVisible();
  await expect(page.getByText("源泉徴収税額")).toBeVisible();
});

test("減価償却：パソコンを登録すると、その年の経費に入る。印刷ボタンもある", async ({ page }) => {
  await login(page);
  await onboard(page);
  await page.goto("/tax/");
  // 「売上と経費」は最初から開いている
  await page.getByLabel("名前", { exact: true }).fill("ノートパソコン");
  await page.getByLabel("買った値段").fill("50000");
  await page.getByRole("button", { name: "＋ 登録する" }).click();
  await expect(page.getByText(/10万円未満のものは/).first()).toBeVisible();   // 10万円未満は断る
  await page.getByLabel("買った値段").fill("240000");
  await page.getByLabel("使い始めた日").fill(`${new Date().getFullYear()}-01-01`);
  await page.getByRole("button", { name: "＋ 登録する" }).click();
  await expect(page.getByText("耐用年数4年")).toBeVisible();
  await expect(page.getByText("60,000円").first()).toBeVisible();      // 240,000 × 0.250
  await expect(page.getByRole("button", { name: "🖨️ 印刷・PDFで保存" })).toBeVisible();
});


test("インボイス：設定でチェックすると、確定申告の準備に消費税（2割特例）が出る", async ({ page }) => {
  await login(page);
  await onboard(page);
  await page.goto("/record/");
  await page.getByText("報酬が入った", { exact: true }).click();
  await page.getByLabel("報酬はいくら？").fill("1100000");
  await page.getByLabel("実際に振り込まれたのはいくら？").fill("1100000");
  await page.getByRole("button", { name: /記録する/ }).click();
  await expect(page.getByText("記録しました")).toBeVisible();

  await page.goto("/settings/");
  await page.getByRole("checkbox", { name: "インボイス登録している" }).check();
  await page.getByLabel("登録番号").fill("T1234567890123");
  await page.getByLabel("登録日").fill(`${new Date().getFullYear()}-01-01`);
  await page.getByRole("button", { name: "インボイスの設定を保存する" }).click();
  await expect(page.getByText("保存しました")).toBeVisible();

  await page.goto("/tax/");
  await expect(page.getByRole("heading", { name: "消費税（インボイス）" })).toBeVisible();
  // 1,100,000 → 課税標準 1,000,000 → 78,000 → 2割特例で 15,600 → 地方 4,400 → 合計 20,000
  await expect(page.getByText("20,000円").first()).toBeVisible();
});
