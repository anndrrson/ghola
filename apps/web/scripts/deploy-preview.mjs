#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { verifyCurrentPreviewBranchPreflight } from "./check-preview-env-branch-scope.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export function deployPreview({
  args = process.argv.slice(2),
  cwd = REPO_ROOT,
  run = spawnSync,
  verify = verifyCurrentPreviewBranchPreflight,
} = {}) {
  if (args.length !== 0) {
    throw new Error("preview_deploy_arguments_forbidden:Preview deploy accepts no forwarded arguments");
  }

  const scope = verify({ cwd, run });
  const result = run(process.execPath, ["apps/web/scripts/create-git-preview-deployment.mjs"], {
    cwd,
    encoding: "utf8",
    stdio: "inherit",
    env: { ...process.env, VERCEL_TELEMETRY_DISABLED: "1" },
  });
  if (result?.status !== 0) {
    throw new Error(`preview_deploy_failed:${Number.isInteger(result?.status) ? result.status : "unknown"}`);
  }
  return Object.freeze({ branch: scope.branch });
}

function main() {
  const result = deployPreview();
  console.log(`[preview-deploy] created Preview deployment from ${result.branch}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(`[preview-deploy] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
