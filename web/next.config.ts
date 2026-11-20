import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // サーバーを持たず、HTML・JS・CSSに書き出して S3 + CloudFront で配る
  output: "export",
  // /entries → /entries/index.html の形にする（S3 で配りやすい）
  trailingSlash: true,
  images: { unoptimized: true },
  reactCompiler: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
