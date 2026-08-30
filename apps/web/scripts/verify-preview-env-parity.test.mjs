import assert from "node:assert/strict";
import test from "node:test";
import {
  assertMaterializedVercelEnvValue,
  buildPreviewEnvCopyPlan,
  copyVerifiedPreviewEnv,
  isOpaqueVercelEnvValue,
  parseVercelEnv,
  verifyPreviewEnvParity,
} from "./verify-preview-env-parity.mjs";

test("parses quoted Vercel environment files", () => {
  assert.deepEqual(parseVercelEnv('A="worker\\nvalue"\nB=true\n'), {
    A: "worker\nvalue",
    B: "true",
  });
});

test("recognizes Vercel placeholders after dotenv decoding", () => {
  const env = parseVercelEnv([
    'SECRET="[SENSITIVE]"',
    "LEGACY='[REDACTED]'",
    "PUBLIC_FLAG=true",
  ].join("\n"));
  assert.equal(isOpaqueVercelEnvValue(env.SECRET), true);
  assert.equal(isOpaqueVercelEnvValue(env.LEGACY), true);
  assert.equal(isOpaqueVercelEnvValue('"[SENSITIVE]"'), true);
  assert.equal(isOpaqueVercelEnvValue(env.PUBLIC_FLAG), false);
  assert.throws(
    () => assertMaterializedVercelEnvValue("SECRET", env.SECRET, "copy"),
    /preview_env_opaque:SECRET:copy/,
  );
});

test("rejects duplicate keys instead of silently changing the copy source", () => {
  assert.throws(
    () => parseVercelEnv("SECRET=first\nSECRET=second\n"),
    /preview_env_duplicate:SECRET/,
  );
});

test("accepts exact parity only for materialized values", () => {
  assert.deepEqual(verifyPreviewEnvParity({
    URL: "https://worker.example",
    SECRET: "concrete-secret",
    VERCEL_OIDC_TOKEN: "reference-token",
  }, {
    URL: "https://worker.example",
    SECRET: "concrete-secret",
    VERCEL_OIDC_TOKEN: "candidate-token",
  }), {
    reference_keys: 2,
    candidate_keys: 2,
    verified_value_keys: 2,
  });
});

test("never treats matching opaque placeholders as value parity", () => {
  assert.throws(
    () => verifyPreviewEnvParity({
      URL: "https://worker.example",
      SECRET: "[SENSITIVE]",
    }, {
      URL: "https://worker.example",
      SECRET: "[SENSITIVE]",
    }),
    /preview_env_parity_unprovable:SECRET/,
  );
  assert.throws(
    () => verifyPreviewEnvParity({ SECRET: "" }, { SECRET: "" }),
    /preview_env_parity_unprovable:SECRET/,
  );
});

test("rejects missing branch-scoped keys", () => {
  assert.throws(
    () => verifyPreviewEnvParity({ URL: "https://worker.example", SECRET: "" }, { URL: "https://worker.example" }),
    /preview_env_missing:SECRET/,
  );
});

test("rejects trailing whitespace before a deployment", () => {
  assert.throws(
    () => verifyPreviewEnvParity({ URL: "https://worker.example" }, { URL: "https://worker.example\n" }),
    /preview_env_whitespace_drift:URL/,
  );
});

test("rejects value drift and unexpected keys", () => {
  assert.throws(
    () => verifyPreviewEnvParity({ URL: "https://worker.example" }, { URL: "https://other.example" }),
    /preview_env_value_mismatch:URL/,
  );
  assert.throws(
    () => verifyPreviewEnvParity({ URL: "https://worker.example" }, {
      URL: "https://worker.example",
      EXTRA: "true",
    }),
    /preview_env_unexpected:EXTRA/,
  );
});

test("requires an explicit copy allowlist", () => {
  assert.throws(
    () => buildPreviewEnvCopyPlan({ SECRET: "concrete" }),
    /preview_env_copy_allowlist_required/,
  );
});

test("validates the full copy source before performing any write", async () => {
  const copied = [];
  await assert.rejects(
    copyVerifiedPreviewEnv({
      source: {
        PUBLIC_FLAG: "true",
        SECRET: "[SENSITIVE]",
      },
      keys: ["PUBLIC_FLAG", "SECRET"],
      copy: async (entry) => copied.push(entry),
    }),
    /preview_env_copy_opaque:SECRET/,
  );
  assert.deepEqual(copied, []);
});

test("copies only allowlisted materialized values and returns no values", async () => {
  const copied = [];
  const result = await copyVerifiedPreviewEnv({
    source: {
      PUBLIC_FLAG: "true",
      SECRET: "concrete-secret",
      EXTRA: "ignored",
    },
    keys: ["SECRET", "PUBLIC_FLAG"],
    copy: async (entry) => copied.push(entry),
  });
  assert.deepEqual(copied, [
    { key: "PUBLIC_FLAG", value: "true" },
    { key: "SECRET", value: "concrete-secret" },
  ]);
  assert.deepEqual(result, {
    copied_keys: 2,
    keys: ["PUBLIC_FLAG", "SECRET"],
  });
  assert.doesNotMatch(JSON.stringify(result), /concrete-secret/);
});
