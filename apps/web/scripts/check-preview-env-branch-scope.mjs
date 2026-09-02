#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const BRANCH_RE = /^(?!\/)(?!.*(?:\.\.|\/\/|@\{|\.lock(?:\/|$)))[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export const PREVIEW_PRODUCT_RUNTIME_ENV_KEYS = Object.freeze([
  "NEXT_PUBLIC_TURNKEY_PERPS_ORGANIZATION_ID",
  "NEXT_PUBLIC_TURNKEY_PERPS_AUTH_PROXY_CONFIG_ID",
  "GHOLA_PRIVATE_AGENT_BETA_PUBLIC_ENABLED",
  "NEXT_PUBLIC_GHOLA_PERPS_MAINNET_ENABLED",
  "GHOLA_PRIVATE_ACCOUNT_STORE",
  "GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET",
  "GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_MODE",
]);

export const PRIVATE_WORKER_PREVIEW_ENV_GROUPS = Object.freeze([
  Object.freeze({
    id: "private_worker_url",
    keys: Object.freeze([
      "GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL",
      "GHOLA_PRIVATE_AGENT_EXECUTION_URL",
      "GHOLA_PRIVATE_AGENT_WORKER_URL",
      "PHALA_AGENT_ENDPOINT",
    ]),
  }),
  Object.freeze({
    id: "private_worker_auth",
    keys: Object.freeze([
      "PRIVATE_AGENT_WORKER_CAPABILITY_SECRET",
      "GHOLA_WORKER_CAPABILITY_SECRET",
      "GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN",
      "PRIVATE_AGENT_EXECUTION_TOKEN",
    ]),
  }),
  Object.freeze({
    id: "private_worker_image_digest",
    keys: Object.freeze([
      "GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST",
      "GHOLA_PRIVATE_AGENT_IMAGE_DIGEST",
      "PHALA_CVM_IMAGE_DIGEST",
    ]),
  }),
  Object.freeze({
    id: "private_worker_funding_signer",
    keys: Object.freeze([
      "GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64",
      "PRIVATE_AGENT_FUNDING_SIGNER_KEYS_B64",
    ]),
  }),
  Object.freeze({
    id: "turnkey_perps_organization",
    keys: Object.freeze([PREVIEW_PRODUCT_RUNTIME_ENV_KEYS[0]]),
  }),
  Object.freeze({
    id: "turnkey_perps_auth_proxy",
    keys: Object.freeze([PREVIEW_PRODUCT_RUNTIME_ENV_KEYS[1]]),
  }),
  Object.freeze({
    id: "private_agent_public_beta",
    keys: Object.freeze([PREVIEW_PRODUCT_RUNTIME_ENV_KEYS[2]]),
  }),
  Object.freeze({
    id: "perps_mainnet_delegation",
    keys: Object.freeze([PREVIEW_PRODUCT_RUNTIME_ENV_KEYS[3]]),
  }),
  Object.freeze({
    id: "private_account_persistence",
    keys: Object.freeze([PREVIEW_PRODUCT_RUNTIME_ENV_KEYS[4]]),
  }),
  Object.freeze({
    id: "private_account_request_proof_secret",
    keys: Object.freeze([PREVIEW_PRODUCT_RUNTIME_ENV_KEYS[5]]),
  }),
  Object.freeze({
    id: "private_account_request_proof_mode",
    keys: Object.freeze([PREVIEW_PRODUCT_RUNTIME_ENV_KEYS[6]]),
  }),
  Object.freeze({
    id: "turnkey_query_organization",
    keys: Object.freeze(["GHOLA_TURNKEY_QUERY_ORGANIZATION_ID"]),
  }),
  Object.freeze({
    id: "turnkey_query_api_public_key",
    keys: Object.freeze(["GHOLA_TURNKEY_QUERY_API_PUBLIC_KEY"]),
  }),
  Object.freeze({
    id: "turnkey_query_api_private_key",
    keys: Object.freeze(["GHOLA_TURNKEY_QUERY_API_PRIVATE_KEY"]),
  }),
  Object.freeze({
    id: "lighter_ethereum_rpc",
    keys: Object.freeze(["GHOLA_LIGHTER_ETHEREUM_RPC_URL"]),
  }),
]);

const KNOWN_KEYS = Object.freeze(PRIVATE_WORKER_PREVIEW_ENV_GROUPS.flatMap((group) => group.keys));

export function parseVercelEnvListKeys(output, knownKeys = KNOWN_KEYS) {
  const found = new Set();
  for (const rawLine of String(output || "").split(/\r?\n/)) {
    const line = rawLine.trimStart();
    for (const key of knownKeys) {
      if (line === key || (line.startsWith(key) && /\s/.test(line[key.length] || ""))) {
        found.add(key);
        break;
      }
    }
  }
  return found;
}

export function assessPreviewBranchEnvScope({ branch, allPreviewKeys, branchPreviewKeys }) {
  const normalizedBranch = validPreviewBranch(branch);
  const allKeys = normalizedKeySet(allPreviewKeys);
  const branchKeys = normalizedKeySet(branchPreviewKeys);
  const missing = PRIVATE_WORKER_PREVIEW_ENV_GROUPS.filter((group) => !hasAny(branchKeys, group.keys));
  if (missing.length === 0) {
    return Object.freeze({
      branch: normalizedBranch,
      checked_groups: PRIVATE_WORKER_PREVIEW_ENV_GROUPS.map((group) => group.id),
    });
  }

  const otherBranchOnly = missing.filter((group) => hasAny(allKeys, group.keys)).map((group) => group.id);
  const absent = missing.filter((group) => !hasAny(allKeys, group.keys)).map((group) => group.id);
  const details = [
    otherBranchOnly.length
      ? `configured only outside this branch scope: ${otherBranchOnly.join(",")}`
      : null,
    absent.length
      ? `missing from every Preview scope: ${absent.join(",")}`
      : null,
  ].filter(Boolean).join("; ");
  throw new Error(
    `preview_env_branch_scope_invalid:${normalizedBranch}:${details}. ` +
    `Configure the required product runtime variables for Preview branch ${normalizedBranch} before deploying.`,
  );
}

export function currentGitBranch({ cwd = REPO_ROOT, run = spawnSync } = {}) {
  const result = run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024,
  });
  if (result?.status !== 0) throw new Error("preview_env_branch_unavailable:check out a named git branch before deploying");
  return validPreviewBranch(result.stdout);
}

export function listVercelPreviewEnvKeys({ branch = null, cwd = REPO_ROOT, run = spawnSync } = {}) {
  const args = ["env", "list", "preview"];
  if (branch !== null) args.push(validPreviewBranch(branch));
  args.push("--no-color", "--cwd", cwd);
  const result = run("vercel", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", VERCEL_TELEMETRY_DISABLED: "1" },
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result?.status !== 0) {
    const scope = branch === null ? "all_preview" : "current_branch";
    throw new Error(
      `preview_env_scope_list_failed:${scope}:verify Vercel login and project link; output is suppressed to protect values`,
    );
  }
  // Vercel's table may contain values. Only known first-column names leave this function.
  return parseVercelEnvListKeys(result.stdout);
}

export function verifyCurrentPreviewBranchEnvScope({
  cwd = REPO_ROOT,
  branch = null,
  list = listVercelPreviewEnvKeys,
  run = spawnSync,
} = {}) {
  const currentBranch = branch === null ? currentGitBranch({ cwd, run }) : validPreviewBranch(branch);
  return assessPreviewBranchEnvScope({
    branch: currentBranch,
    allPreviewKeys: list({ cwd, run }),
    branchPreviewKeys: list({ branch: currentBranch, cwd, run }),
  });
}

function normalizedKeySet(value) {
  return new Set(Array.from(value || [], (key) => String(key)));
}

function hasAny(keys, candidates) {
  return candidates.some((key) => keys.has(key));
}

export function validPreviewBranch(value) {
  const branch = String(value || "").trim();
  if (!BRANCH_RE.test(branch)) throw new Error("preview_env_branch_invalid");
  return branch;
}

function main() {
  const result = verifyCurrentPreviewBranchEnvScope();
  console.log(`[preview-env-branch-scope] verified ${result.checked_groups.length} required groups for ${result.branch}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(`[preview-env-branch-scope] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
