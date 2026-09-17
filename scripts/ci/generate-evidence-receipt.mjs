// WI-3.2 步骤④：CI 证据收据生成器（check.yml 末尾步骤调用）。
// 产出 ci-evidence-receipt.json，字段契约见
// docs/roadmap/batches/batch3/design-wi3-2-evidence-import-2026-09-12.md §3.1。
// receiptHash 与 harness_ledger._ci_receipt_hash 同口径：
// 除 receiptHash 外全字段，sort_keys + 紧凑分隔符 + UTF-8 的 sha256。
// 注意：headTree 的 "sha256:" 前缀沿用 harness_ledger.product_tree_hash 的
// 既有口径（git 默认对象格式下实际内容是 SHA-1 十六进制）；两端同源
// （同一 git rev-parse 命令），闭环一致，不单独换算。
import console from "node:console";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import process from "node:process";
import { URL } from "node:url";

function arg(name) {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

const root = process.cwd();
const headSha = git(root, "rev-parse", "HEAD");
const headTree = git(root, "rev-parse", "--verify", "HEAD^{tree}");
const stepName = arg("step");
// repository 字段输出 host/owner/repo 形式（GITHUB_SERVER_URL 的 host +
// GITHUB_REPOSITORY），与 harness_paths._normalize_remote 的归一化口径一致。
function ciRepository() {
  const repository = process.env.GITHUB_REPOSITORY ?? arg("repository");
  if (!repository) return "unknown";
  const serverUrl = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  let host = "github.com";
  try {
    host = new URL(serverUrl).host;
  } catch {
    // non-URL server url: fall back to github.com host
  }
  return `${host}/${repository}`.toLowerCase();
}
const receipt = {
  schemaVersion: 1,
  repository: ciRepository(),
  runId: Number(process.env.GITHUB_RUN_ID ?? arg("runId") ?? 0),
  runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? 1),
  workflow: arg("workflow") ?? "check",
  runUrl: process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : (arg("runUrl") ?? null),
  headSha,
  headTree: `sha256:${headTree}`,
  toolchain: { node: process.version },
  conclusion: arg("conclusion") ?? "success",
  jobs: [
    {
      name: arg("job") ?? "unknown",
      conclusion: arg("conclusion") ?? "success",
      steps: [
        {
          name: stepName ?? "unknown",
          conclusion: arg("conclusion") ?? "success",
          command: arg("command") ?? null,
        },
      ],
    },
  ],
  concludedAt: new Date().toISOString(),
};

const body = { ...receipt };
delete body.receiptHash;
// 与 Python json.dumps(sort_keys=True) 同口径：递归排序所有嵌套对象。
function deepSort(value) {
  if (Array.isArray(value)) return value.map(deepSort);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((k) => [k, deepSort(value[k])]),
    );
  }
  return value;
}
const canonical = JSON.stringify(deepSort(body));
receipt.receiptHash = `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;

const out = arg("out") ?? "ci-evidence-receipt.json";
writeFileSync(out, JSON.stringify(receipt, null, 2) + "\n", "utf8");
console.log(`ci evidence receipt written: ${out}`);
