// CDK のテスト：「作られる設定」が、決めたルールどおりかを確かめる。
// AWS には何も作らずに、手元で設定の中身（テンプレート）だけを調べる。
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { GithubOidcStack } from "../lib/github-oidc-stack.js";
import { ShinkokuStack } from "../lib/shinkoku-stack.js";

const env = { account: "123456789012", region: "ap-southeast-2" };

describe("本体スタック", () => {
  const template = Template.fromStack(new ShinkokuStack(new App(), "Test", { env }));

  it("お金のかかる NAT ゲートウェイを作らない", () => {
    template.resourceCountIs("AWS::EC2::NatGateway", 0);
  });

  it("DB は使わないとき0まで縮み、Data API が使える", () => {
    template.hasResourceProperties("AWS::RDS::DBCluster", {
      Engine: "aurora-postgresql",
      EnableHttpEndpoint: true,
      StorageEncrypted: true,
      ServerlessV2ScalingConfiguration: { MinCapacity: 0, MaxCapacity: 2 },
    });
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
    expect(Object.keys(buckets).length).toBeGreaterThanOrEqual(2);
    for (const bucket of Object.values(buckets)) {
      expect(bucket.Properties.PublicAccessBlockConfiguration).toEqual({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });
    }
  });

  it("レシート置き場は版を残し、スタックを消しても消えない", () => {
    template.hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Retain",
      Properties: Match.objectLike({ VersioningConfiguration: { Status: "Enabled" } }),
    });
  });

  it("画面は HTTPS だけで配る", () => {
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: "redirect-to-https" }),
      }),
    });
  });
});

describe("GitHub 用のスタック", () => {
  const template = Template.fromStack(
    new GithubOidcStack(new App(), "TestOidc", { env, repository: "lunamoon-00/shinkoku-note" }),
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
                  "repo:lunamoon-00/shinkoku-note:ref:refs/heads/main",
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
