// 申告ノートの本体：ログイン・DB・ファイル置き場。（画面の配信は web-stack.ts）
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as ec2 from "aws-cdk-lib/aws-ec2";
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
      removalPolicy: RemovalPolicy.RETAIN, // 消しても利用者は残す（事故防止）
    });

    // 画面（ブラウザ）用の入口。ブラウザには秘密を置けないので secret なし
    const userPoolClient = userPool.addClient("WebClient", {
      generateSecret: false,
      authFlows: { userSrp: true },
      accessTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      preventUserExistenceErrors: true,
    });

    // ───────── DB（Aurora PostgreSQL Serverless v2） ─────────
    // DBは必ず「ネットワーク（VPC）」の中に置く決まり。
    // 外への出口（NAT）は月数千円かかるので作らない。外とつながらない部屋（ISOLATED）だけ。
    // Lambda からは Data API（HTTPの窓口）で話しかけるので、Lambda を VPC に入れなくてよい
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: "db", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    const db = new rds.DatabaseCluster(this, "Database", {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_11,
      }),
      writer: rds.ClusterInstance.serverlessV2("writer"),
      serverlessV2MinCapacity: 0, // 使っていないときは0まで縮んで止まる（安くするため）
      serverlessV2MaxCapacity: 2, // 2人で使うだけなので上限は小さく
      enableDataApi: true,
      defaultDatabaseName: "shinkoku",
      credentials: rds.Credentials.fromGeneratedSecret("shinkoku_admin"), // パスワードは自動で作って金庫へ
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      storageEncrypted: true,
      // 無料プランではバックアップは1日分までしか残せない（7日にすると作成が失敗する）
      backup: { retention: Duration.days(1) },
      removalPolicy: RemovalPolicy.SNAPSHOT, // 消すときは最後にバックアップを残す
    });

    // ───────── ファイル置き場（レシート・CSV・PDF） ─────────
    const uploadsBucket = new s3.Bucket(this, "UploadsBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, // 外から絶対に見えない
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true, // 上書き・削除しても前の版に戻せる
      removalPolicy: RemovalPolicy.RETAIN, // 大事な証拠なので、スタックを消しても残す
    });

    // ───────── 次の Phase で使う値を表示 ─────────
    new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, "DbClusterArn", { value: db.clusterArn });
    new CfnOutput(this, "DbSecretArn", { value: db.secret!.secretArn });
    new CfnOutput(this, "UploadsBucketName", { value: uploadsBucket.bucketName });
  }
}
