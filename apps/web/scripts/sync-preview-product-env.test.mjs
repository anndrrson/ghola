import assert from "node:assert/strict";
import test from "node:test";
import {
  PREVIEW_PRODUCT_RUNTIME_ENV_KEYS,
  PRIVATE_WORKER_PREVIEW_ENV_GROUPS,
} from "./check-preview-env-branch-scope.mjs";
import { syncPreviewProductEnv } from "./sync-preview-product-env.mjs";

function sourceEnv(overrides = {}) {
  return {
    NEXT_PUBLIC_TURNKEY_PERPS_ORGANIZATION_ID: "organization-id",
    NEXT_PUBLIC_TURNKEY_PERPS_AUTH_PROXY_CONFIG_ID: "auth-proxy-config-id",
    GHOLA_PRIVATE_AGENT_BETA_PUBLIC_ENABLED: "true",
    NEXT_PUBLIC_GHOLA_PERPS_MAINNET_ENABLED: "true",
    GHOLA_PRIVATE_ACCOUNT_STORE: "postgres",
    ...overrides,
  };
}

test("dry-run validates the fixed allowlist without writing", async () => {
  let writes = 0;
  const result = await syncPreviewProductEnv({
    source_branch: "feature/source",
    target_branch: "feature/target",
    source_env: sourceEnv(),
    copy: async () => { writes += 1; },
    verify: async () => { throw new Error("dry-run must not verify target"); },
  });
  assert.equal(writes, 0);
  assert.deepEqual(result, {
    applied: false,
    source_branch: "feature/source",
    target_branch: "feature/target",
    keys: [...PREVIEW_PRODUCT_RUNTIME_ENV_KEYS].sort(),
  });
});

test("apply copies only product runtime values then verifies the target", async () => {
  const copied = [];
  const result = await syncPreviewProductEnv({
    source_branch: "feature/source",
    target_branch: "feature/target",
    source_env: { ...sourceEnv(), UNRELATED_SECRET: "never-copy" },
    apply: true,
    copy: async (entry) => copied.push(entry),
    verify: async ({ branch }) => ({
      branch,
      checked_groups: PRIVATE_WORKER_PREVIEW_ENV_GROUPS.map((group) => group.id),
    }),
  });
  assert.deepEqual(copied.map(({ key }) => key), [...PREVIEW_PRODUCT_RUNTIME_ENV_KEYS].sort());
  assert.equal(copied.some(({ value }) => value === "never-copy"), false);
  assert.deepEqual(result, {
    applied: true,
    source_branch: "feature/source",
    target_branch: "feature/target",
    keys: [...PREVIEW_PRODUCT_RUNTIME_ENV_KEYS].sort(),
    verified_groups: PRIVATE_WORKER_PREVIEW_ENV_GROUPS.length,
  });
});

test("validates every source value before the first write", async () => {
  let writes = 0;
  await assert.rejects(syncPreviewProductEnv({
    source_branch: "feature/source",
    target_branch: "feature/target",
    source_env: sourceEnv({ NEXT_PUBLIC_TURNKEY_PERPS_AUTH_PROXY_CONFIG_ID: "[SENSITIVE]" }),
    apply: true,
    copy: async () => { writes += 1; },
    verify: async () => ({ checked_groups: [] }),
  }), /preview_env_copy_opaque:NEXT_PUBLIC_TURNKEY_PERPS_AUTH_PROXY_CONFIG_ID/);
  assert.equal(writes, 0);
});

test("rejects invalid or identical branch targets", async () => {
  await assert.rejects(syncPreviewProductEnv({
    source_branch: "feature/same",
    target_branch: "feature/same",
    source_env: sourceEnv(),
  }), /preview_product_env_source_equals_target/);
  await assert.rejects(syncPreviewProductEnv({
    source_branch: "bad branch",
    target_branch: "feature/target",
    source_env: sourceEnv(),
  }), /preview_env_branch_invalid/);
});
