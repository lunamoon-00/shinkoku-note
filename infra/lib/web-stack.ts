// 画面の配信（S3 + CloudFront）。
// 新しいAWSアカウントは「アカウントの確認」が終わるまで CloudFront を作れないため、
// 本体とは別のスタックに分けてある（確認が終わってから反映する）。
import { CfnOutput, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import type { Construct } from "constructs";
import { fileURLToPath } from "node:url";

export class WebStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const webBucket = new s3.Bucket(this, "WebBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, // 直接は見せず、CloudFront経由だけ
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true, // 画面はいつでも作り直せるので消してOK
    });

    const distribution = new cloudfront.Distribution(this, "WebDistribution", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      defaultRootObject: "index.html",
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200, // 日本を含む地域だけ（いちばん高い地域は除く）
    });

    // Phase 3 で本物の画面に置きかえるまでの「準備中」ページ
    new s3deploy.BucketDeployment(this, "PlaceholderPage", {
      sources: [s3deploy.Source.asset(fileURLToPath(new URL("../placeholder", import.meta.url)))],
      destinationBucket: webBucket,
      distribution,
    });

    new CfnOutput(this, "WebUrl", { value: `https://${distribution.distributionDomainName}` });
  }
}
