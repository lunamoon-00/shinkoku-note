// 申告ノートの本体：ログイン・DB・ファイル置き場。（画面の配信は web-stack.ts）
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";

export class ShinkokuStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // ───────── ログイン（Cognito） ─────────
    // 使うのは2人だけなので、自分で登録（サインアップ）はできないようにして、
    // 利用者はコンソールから作る
    const userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: "shinkoku-note-users",
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      passwordPolicy: { minLength: 12, requireSymbols: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      // 消しても利用者は残す（事故防止）。ただし「最初に作るときに失敗した」ときは残さない
      removalPolicy: RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
    });

    // 画面（ブラウザ）用の入口。ブラウザには秘密を置けないので secret なし
    const userPoolClient = userPool.addClient("WebClient", {
      generateSecret: false,
      authFlows: { userSrp: true },
      accessTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      preventUserExistenceErrors: true,
    });

    // ───────── DB（Aurora PostgreSQL・エクスプレス構成） ─────────
    // AWSの無料プランでは、Aurora は「エクスプレス構成」でしか作れない。
    // - 数秒で作れて、使っていないときは0まで縮む（安い）
    // - ネットワーク（VPC）を使わず、インターネット経由の入口（internet access gateway）でつなぐ
    // - パスワードではなく、AWSの通行証（IAM認証）を持っている人だけがつながれる
    //   → Lambda には「このDBにつないでいい」という権限だけを渡せばよく、パスワードの管理がいらない
    // ※ 書き手のインスタンスはエクスプレス構成が自動で作る（CDKでは別に書かない）
    const db = new rds.CfnDBCluster(this, "Database", {
      engine: "aurora-postgresql",
      withExpressConfiguration: true,
      // 無料プランではバックアップは1日分までしか残せない（7日にすると作成が失敗する）
      backupRetentionPeriod: 1,
    });
    db.applyRemovalPolicy(RemovalPolicy.SNAPSHOT); // 消すときは最後にバックアップを残す

    // ───────── ファイル置き場（レシート・CSV・PDF） ─────────
    const uploadsBucket = new s3.Bucket(this, "UploadsBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, // 外から絶対に見えない
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true, // 上書き・削除しても前の版に戻せる
      // 大事な証拠なので、スタックを消しても残す。ただし「最初に作るときに失敗した」ときは残さない
      removalPolicy: RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
    });

    // ───────── 次の Phase で使う値を表示 ─────────
    new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, "DbEndpoint", { value: db.attrEndpointAddress });
    new CfnOutput(this, "DbClusterResourceId", {
      value: db.attrDbClusterResourceId,
      description: "Lambda に「このDBにつないでいい」権限を渡すときに使う",
    });
    new CfnOutput(this, "UploadsBucketName", { value: uploadsBucket.bucketName });
  }
}
