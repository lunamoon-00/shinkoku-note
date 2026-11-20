// Lambda（Python）に載せるコードの作り方。
// api/ フォルダの shinkoku パッケージと、必要なライブラリ（pg8000 など）を1つにまとめる。
// まずパソコン（または GitHub Actions）にある Python で作り、ダメなら Docker で作る。
import * as lambda from "aws-cdk-lib/aws-lambda";
import { execFileSync } from "node:child_process";
import { cpSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const API_DIR = fileURLToPath(new URL("../../api", import.meta.url));

export function pythonCode(): lambda.Code {
  return lambda.Code.fromAsset(API_DIR, {
    // これらはLambdaに載せない（テストや手元の作業用）
    exclude: [".venv", "tests", "**/__pycache__", ".pytest_cache", "requirements-dev.txt", "pyproject.toml"],
    bundling: {
      image: lambda.Runtime.PYTHON_3_13.bundlingImage,
      command: [
        "bash", "-c",
        "pip install -r requirements.txt -t /asset-output --no-cache-dir && cp -r shinkoku /asset-output/",
      ],
      local: {
        tryBundle(outputDir: string) {
          const python = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
          try {
            // Lambda は Linux（arm64）なので、その形のライブラリを取ってくる
            execFileSync(python, [
              "-m", "pip", "install", "-q",
              "-r", join(API_DIR, "requirements.txt"),
              "-t", outputDir,
              "--platform", "manylinux2014_aarch64",
              "--python-version", "3.13",
              "--implementation", "cp",
              "--only-binary=:all:",
              "--no-cache-dir",
            ], { stdio: "inherit" });
          } catch {
            return false; // 手元で作れなければ Docker で作る
          }
          cpSync(join(API_DIR, "shinkoku"), join(outputDir, "shinkoku"), {
            recursive: true,
            filter: (src) => !src.includes("__pycache__"),
          });
          return true;
        },
      },
    },
  });
}
