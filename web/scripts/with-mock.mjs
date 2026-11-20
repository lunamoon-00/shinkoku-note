// お試しモード（AWSにつながない）で next を動かす。Windows でも Linux でも同じ書き方で使えるように。
// 使い方: node scripts/with-mock.mjs dev --port 3100
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const nextBin = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));
const child = spawn(process.execPath, [nextBin, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, NEXT_PUBLIC_MOCK: "1" },
});
child.on("exit", (code) => process.exit(code ?? 0));
