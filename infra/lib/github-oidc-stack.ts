// GitHub Actions から「鍵なし」で AWS に入るための設定。
// 最初の1回だけ CloudShell から手で反映する（このあとの公開は GitHub Actions がやる）。
import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";

export interface GithubOidcStackProps extends StackProps {
  /** 例: "lunamoon-00/shinkoku-note" */
  repository: string;
}

export class GithubOidcStack extends Stack {
  constructor(scope: Construct, id: string, props: GithubOidcStackProps) {
    super(scope, id, props);

    // ① 「GitHub が発行する身分証（トークン）を信用する」という登録。アカウントに1つだけ作る
    const provider = new iam.OpenIdConnectProvider(this, "GithubProvider", {
      url: "https://token.actions.githubusercontent.com",
      clientIds: ["sts.amazonaws.com"],
    });

    // ② GitHub Actions が借りる役割（ロール）。
    //    「このリポジトリの main ブランチから来たときだけ」借りられるように絞る
    const deployRole = new iam.Role(this, "DeployRole", {
      roleName: "shinkoku-note-github-deploy",
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": `repo:${props.repository}:ref:refs/heads/main`,
        },
      }),
    });

    // ③ このロール自身には強い権限を持たせない。
    //    CDK が最初に作る「反映用のロール（cdk-xxx）」を借りることだけ許す
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [`arn:aws:iam::${this.account}:role/cdk-*`],
      }),
    );

    new CfnOutput(this, "DeployRoleArn", {
      value: deployRole.roleArn,
      description: "GitHub の Variables に AWS_DEPLOY_ROLE_ARN として登録する",
    });
  }
}
