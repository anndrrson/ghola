#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PREVIEW_PRODUCT_RUNTIME_ENV_KEYS,
  currentGitBranch,
  validPreviewBranch,
  verifyCurrentPreviewBranchEnvScope,
} from "./check-preview-env-branch-scope.mjs";
import {
  buildPreviewEnvCopyPlan,
  copyVerifiedPreviewEnv,
  parseVercelEnv,
} from "./verify-preview-env-parity.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export async function syncPreviewProductEnv({
  source_branch: sourceBranch,
  target_branch: targetBranch,
  source_env: sourceEnv,
  apply = false,
  copy,
  verify,
}) {
  const source = validPreviewBranch(sourceBranch);
  const target = validPreviewBranch(targetBranch);
  if (source === target) throw new Error("preview_product_env_source_equals_target");
  const plan = buildPreviewEnvCopyPlan(sourceEnv, PREVIEW_PRODUCT_RUNTIME_ENV_KEYS);
  if (!apply) {
    return Object.freeze({
      applied: false,
      source_branch: source,
      target_branch: target,
      keys: plan.map(({ key }) => key),
    });
  }
  const copied = await copyVerifiedPreviewEnv({
    source: sourceEnv,
    keys: PREVIEW_PRODUCT_RUNTIME_ENV_KEYS,
    copy,
  });
  const verified = await verify({ branch: target });
  return Object.freeze({
    applied: true,
    source_branch: source,
    target_branch: target,
    keys: copied.keys,
    verified_groups: verified.checked_groups.length,
  });
}

function pullPreviewBranchEnv({ branch, cwd = REPO_ROOT, run = spawnSync }) {
  const directory = mkdtempSync(path.join(tmpdir(), "ghola-preview-env-"));
  const filename = path.join(directory, "source.env");
  try {
    const result = run("vercel", [
      "env", "pull", filename,
      "--environment", "preview",
      "--git-branch", branch,
      "--yes",
      "--no-color",
      "--cwd", cwd,
    ], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1", VERCEL_TELEMETRY_DISABLED: "1" },
      maxBuffer: 2 * 1024 * 1024,
    });
    if (result?.status !== 0) throw new Error("preview_product_env_pull_failed:output_suppressed");
    return parseVercelEnv(readFileSync(filename, "utf8"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function copyPreviewEntry({ entry, targetBranch, cwd = REPO_ROOT, run = spawnSync }) {
  const result = run("vercel", [
    "env", "add", entry.key, "preview", targetBranch,
    "--force",
    "--no-color",
    "--cwd", cwd,
  ], {
    cwd,
    encoding: "utf8",
    input: entry.value,
    env: { ...process.env, NO_COLOR: "1", VERCEL_TELEMETRY_DISABLED: "1" },
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result?.status !== 0) {
    throw new Error(`preview_product_env_copy_failed:${entry.key}:output_suppressed`);
  }
}

function parseArguments(argv) {
  const args = { source_branch: "", target_branch: "", apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--from-branch") args.source_branch = argv[++index] || "";
    else if (arg === "--to-branch") args.target_branch = argv[++index] || "";
    else if (arg === "--apply") args.apply = true;
    else throw new Error(`preview_product_env_argument_invalid:${arg}`);
  }
  if (!args.source_branch) {
    throw new Error("usage: sync-preview-product-env --from-branch <branch> [--to-branch <branch>] [--apply]");
  }
  return args;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const targetBranch = args.target_branch || currentGitBranch({ cwd: REPO_ROOT });
  const sourceEnv = pullPreviewBranchEnv({ branch: validPreviewBranch(args.source_branch) });
  const result = await syncPreviewProductEnv({
    ...args,
    target_branch: targetBranch,
    source_env: sourceEnv,
    copy: async (entry) => copyPreviewEntry({ entry, targetBranch }),
    verify: async ({ branch }) => verifyCurrentPreviewBranchEnvScope({ branch }),
  });
  console.log(result.applied
    ? `[preview-product-env] copied ${result.keys.length} allowlisted values to ${result.target_branch}; ${result.verified_groups} groups verified`
    : `[preview-product-env] verified ${result.keys.length} source values for ${result.target_branch}; no changes made`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`[preview-product-env] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
