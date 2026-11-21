// CDK のテスト：「作られる設定」が、決めたルールどおりかを確かめる。
// AWS には何も作らずに、手元で設定の中身（テンプレート）だけを調べる。
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { GithubOidcStack } from "../lib/github-oidc-stack.js";
import { ShinkokuStack } from "../lib/shinkoku-stack.js";
import { WebStack } from "../lib/web-stack.js";

const env = { account: "123456789012", region: "ap-southeast-2" };
// テストでは Lambda のコードのまとめ作業（pip install）を飛ばして速くする
const testApp = () => new App({ context: { "aws:cdk:bundling-stacks": [] } });

describe("本体スタック", () => {
  const template = Template.fromStack(new ShinkokuStack(testApp(), "Test", { env }));

  it("お金のかかる NAT ゲートウェイもネットワーク（VPC）も作らない", () => {
    template.resourceCountIs("AWS::EC2::NatGateway", 0);
    template.resourceCountIs("AWS::EC2::VPC", 0);
  });

  it("DB は無料プランで使えるエクスプレス構成の Aurora PostgreSQL", () => {
    template.hasResourceProperties("AWS::RDS::DBCluster", {
      Engine: "aurora-postgresql",
      WithExpressConfiguration: true,
    });
  });

  it("DB のバックアップは無料プランの上限（1日）におさめる", () => {
    template.hasResourceProperties("AWS::RDS::DBCluster", {
      BackupRetentionPeriod: 1,
    });
  });

  it("DB に暗号化の指定を入れない（エクスプレス構成では作成が失敗するため）", () => {
    template.hasResourceProperties("AWS::RDS::DBCluster", {
      StorageEncrypted: Match.absent(),
    });
  });

  it("API は LINE の入口以外すべてログインが必要（Cognito のトークンを確かめる）", () => {
    const routes = Object.values(template.findResources("AWS::ApiGatewayV2::Route"));
    expect(routes.length).toBe(34);
    const publicRoutes = ["POST /line/webhook", "GET /freee/callback"]; // それぞれ署名・合言葉で本物か確かめる
    for (const route of routes) {
      const expected = publicRoutes.includes(route.Properties.RouteKey) ? "NONE" : "JWT";
      expect([route.Properties.RouteKey, route.Properties.AuthorizationType ?? "NONE"]).toEqual([route.Properties.RouteKey, expected]);
    }
  });

  it("レシートの読み取りは3回失敗したら失敗の置き場（DLQ）へ", () => {
    template.hasResourceProperties("AWS::SQS::Queue", {
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }),
    });
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      BatchSize: 1,
      FunctionResponseTypes: ["ReportBatchItemFailures"],
    });
  });

  it("freee の鍵（トークン）は決まった場所にだけ書ける", () => {
    const policies = JSON.stringify(template.findResources("AWS::IAM::Policy"));
    expect(policies).toContain("parameter/shinkoku/freee/tokens/*");
    expect(policies).toContain("ssm:PutParameter");
  });

  it("鍵はパラメータストアの決まった名前だけ読める", () => {
    const policies = JSON.stringify(template.findResources("AWS::IAM::Policy"));
    expect(policies).toContain("parameter/shinkoku/line/channel-secret");
    expect(policies).toContain("parameter/shinkoku/gemini/api-key");
    expect(policies).not.toContain("parameter/*");
  });

  it("API は呼ばれすぎないように速さの上限がある", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      DefaultRouteSettings: { ThrottlingRateLimit: 10, ThrottlingBurstLimit: 20 },
    });
  });

  it("Lambda は Python 3.13・arm64", () => {
    const fns = template.findResources("AWS::Lambda::Function", {
      Properties: { Runtime: "python3.13" },
    });
    expect(Object.keys(fns).length).toBe(6); // API・マイグレーション・LINEの受け取り係・読み取り係・目覚まし係・freeeに送る係
    for (const fn of Object.values(fns)) {
      expect(fn.Properties.Architectures).toEqual(["arm64"]);
    }
  });

  it("API の Lambda はアプリ用ユーザーとしてだけ DB につなげる（管理ユーザーは使えない）", () => {
    const fns = template.findResources("AWS::Lambda::Function", {
      Properties: { Handler: "shinkoku.handler.handler" },
    });
    const [apiFn] = Object.values(fns);
    expect(apiFn.Properties.Environment.Variables.DB_USER).toBe("shinkoku_app");
    const policies = JSON.stringify(template.findResources("AWS::IAM::Policy"));
    expect(policies).toContain("/shinkoku_app");
    expect(policies).toContain("/postgres"); // マイグレーション用だけ
  });

  it("目覚ましは日本時間：毎朝6時にくり返しの記録、毎週月曜9時にお知らせ（お知らせはやりなおさない）", () => {
    template.hasResourceProperties("AWS::Scheduler::Schedule", {
      ScheduleExpression: "cron(0 6 * * ? *)",
      ScheduleExpressionTimezone: "Asia/Tokyo",
      Target: Match.objectLike({ Input: JSON.stringify({ task: "recurring" }), RetryPolicy: Match.objectLike({ MaximumRetryAttempts: 2 }) }),
    });
    template.hasResourceProperties("AWS::Scheduler::Schedule", {
      ScheduleExpression: "cron(0 9 ? * MON *)",
      ScheduleExpressionTimezone: "Asia/Tokyo",
      Target: Match.objectLike({ Input: JSON.stringify({ task: "review_reminder" }), RetryPolicy: Match.objectLike({ MaximumRetryAttempts: 0 }) }),
    });
  });

  it("公開のたびにマイグレーションを自動で流す", () => {
    template.resourceCountIs("Custom::Trigger", 1);
  });

  it("ログインの利用者も消えない（作成失敗のときだけ残さない）", () => {
    template.hasResource("AWS::Cognito::UserPool", { DeletionPolicy: "RetainExceptOnCreate" });
  });

  it("利用者は自分で登録できない（2人だけで使う）", () => {
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    });
  });

  it("ブラウザ用の入口に秘密（シークレット）を持たせない", () => {
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      GenerateSecret: false,
    });
  });

  it("S3 はすべて外から見えない", () => {
    const buckets = template.findResources("AWS::S3::Bucket");
    expect(Object.keys(buckets).length).toBeGreaterThanOrEqual(1);
    for (const bucket of Object.values(buckets)) {
      expect(bucket.Properties.PublicAccessBlockConfiguration).toEqual({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });
    }
  });

  it("レシート置き場は版を残し、スタックを消しても消えない（作成失敗のときだけ残さない）", () => {
    template.hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "RetainExceptOnCreate",
      Properties: Match.objectLike({ VersioningConfiguration: { Status: "Enabled" } }),
    });
  });
});

describe("画面のスタック", () => {
  const template = Template.fromStack(new WebStack(new App(), "TestWeb", { env }));

  it("画面は HTTPS だけで配る", () => {
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: "redirect-to-https" }),
      }),
    });
  });

  it("画面の置き場も外から直接は見えない（CloudFront経由だけ）", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it("本体スタックには CloudFront を入れない（アカウント確認前でも反映できるように）", () => {
    const main = Template.fromStack(new ShinkokuStack(testApp(), "TestMain", { env }));
    main.resourceCountIs("AWS::CloudFront::Distribution", 0);
  });
});

describe("GitHub 用のスタック", () => {
  const template = Template.fromStack(
    new GithubOidcStack(new App(), "TestOidc", {
      env,
      subjectPrefix: "repo:lunamoon-00@204539346/shinkoku-note@1465897294",
    }),
  );

  it("このリポジトリの main ブランチからだけ入れる", () => {
    template.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Condition: {
              StringEquals: {
                "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
                "token.actions.githubusercontent.com:sub":
                  "repo:lunamoon-00@204539346/shinkoku-note@1465897294:ref:refs/heads/main",
              },
            },
          }),
        ]),
      }),
    });
  });

  it("ロールは CDK の反映用ロールを借りることしかできない", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: [
          {
            Action: "sts:AssumeRole",
            Effect: "Allow",
            Resource: "arn:aws:iam::123456789012:role/cdk-*",
          },
        ],
        Version: "2012-10-17",
      },
    });
  });
});
