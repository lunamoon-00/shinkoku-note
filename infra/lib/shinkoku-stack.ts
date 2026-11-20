// 申告ノートの本体：ログイン・DB・ファイル置き場。（画面の配信は web-stack.ts）
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpUserPoolAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as triggers from "aws-cdk-lib/triggers";
import type { Construct } from "constructs";
import { pythonCode } from "./python-code.js";

/** 画面からAPIを呼んでよい場所（Phase 3 で本番の画面のURLを足す） */
const ALLOWED_ORIGINS = ["http://localhost:3000"];

/** DBの名前とユーザー（マイグレーションが作る） */
const DB_NAME = "shinkoku";
const DB_ADMIN_USER = "postgres";
const DB_APP_USER = "shinkoku_app";

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
      // ※ 保存データの暗号化（storageEncrypted）はエクスプレス構成では使えない（AWSに断られる）。
      //   通信はTLS、接続はIAM認証のLambdaだけに限って守る。有料プランに上げたら暗号化つきに作り直す（設計書の課題）
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


    // ───────── API（API Gateway + Lambda） ─────────
    const code = pythonCode();
    const dbEnv = { DB_HOST: db.attrEndpointAddress, DB_PORT: "5432", DB_NAME };

    // 「このDBに、このユーザーとしてつないでいい」という通行証の権限
    const dbConnect = (user: string) =>
      new iam.PolicyStatement({
        actions: ["rds-db:connect"],
        resources: [
          `arn:aws:rds-db:${this.region}:${this.account}:dbuser:${db.attrDbClusterResourceId}/${user}`,
        ],
      });

    // 帳簿のAPI。権限をしぼったアプリ用ユーザー（shinkoku_app）でDBにつなぐ
    const apiFn = new lambda.Function(this, "ApiFunction", {
      runtime: lambda.Runtime.PYTHON_3_13,
      architecture: lambda.Architecture.ARM_64, // 安くて速い
      code,
      handler: "shinkoku.handler.handler",
      memorySize: 512,
      timeout: Duration.seconds(29), // API Gateway の上限（30秒）より少し短く
      environment: { ...dbEnv, DB_USER: DB_APP_USER, DB_CONNECT_TIMEOUT: "20" },
      logGroup: new logs.LogGroup(this, "ApiLogs", {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    apiFn.addToRolePolicy(dbConnect(DB_APP_USER));

    // マイグレーション（テーブル作成・変更）。公開のたびに、コードが変わっていれば自動で実行される
    const migrateFn = new lambda.Function(this, "MigrateFunction", {
      runtime: lambda.Runtime.PYTHON_3_13,
      architecture: lambda.Architecture.ARM_64,
      code,
      handler: "shinkoku.migrate.handler",
      memorySize: 256,
      timeout: Duration.minutes(5), // DBが止まっていたら起きるのを待つ
      environment: { ...dbEnv, DB_USER: DB_ADMIN_USER, DB_CONNECT_TIMEOUT: "120" },
      logGroup: new logs.LogGroup(this, "MigrateLogs", {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    migrateFn.addToRolePolicy(dbConnect(DB_ADMIN_USER));
    new triggers.Trigger(this, "MigrateOnDeploy", {
      handler: migrateFn,
      executeAfter: [db],
      executeOnHandlerChange: true,
      timeout: Duration.minutes(5),
    });

    // ログインしている人だけ通す（Cognito のトークンを API Gateway が確かめる）
    const authorizer = new HttpUserPoolAuthorizer("CognitoAuthorizer", userPool, {
      userPoolClients: [userPoolClient],
    });
    const httpApi = new apigw.HttpApi(this, "HttpApi", {
      apiName: "shinkoku-note-api",
      corsPreflight: {
        allowOrigins: ALLOWED_ORIGINS,
        allowMethods: [
          apigw.CorsHttpMethod.GET,
          apigw.CorsHttpMethod.POST,
          apigw.CorsHttpMethod.PUT,
          apigw.CorsHttpMethod.DELETE,
        ],
        allowHeaders: ["authorization", "content-type"],
        maxAge: Duration.hours(1),
      },
    });
    // たくさん呼ばれすぎないように、速さの上限をつける（いたずら・バグ対策）
    const stage = httpApi.defaultStage!.node.defaultChild as apigw.CfnStage;
    stage.defaultRouteSettings = { throttlingRateLimit: 10, throttlingBurstLimit: 20 };

    const integration = new HttpLambdaIntegration("ApiIntegration", apiFn);
    const routes: [string, apigw.HttpMethod][] = [
      ["/me", apigw.HttpMethod.GET],
      ["/me", apigw.HttpMethod.PUT],
      ["/accounts", apigw.HttpMethod.GET],
      ["/entries", apigw.HttpMethod.GET],
      ["/entries", apigw.HttpMethod.POST],
      ["/entries/{id}", apigw.HttpMethod.GET],
      ["/entries/{id}", apigw.HttpMethod.PUT],
      ["/entries/{id}", apigw.HttpMethod.DELETE],
      ["/entries/{id}/confirm", apigw.HttpMethod.POST],
      ["/summary", apigw.HttpMethod.GET],
    ];
    for (const [path, method] of routes) {
      httpApi.addRoutes({ path, methods: [method], integration, authorizer });
    }

    // ───────── 次の Phase で使う値を表示 ─────────
    new CfnOutput(this, "ApiUrl", { value: httpApi.apiEndpoint });
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
