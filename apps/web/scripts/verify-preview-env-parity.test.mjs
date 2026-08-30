import assert from "node:assert/strict";
import test from "node:test";
import {
  parseVercelEnv,
  verifyPreviewEnvParity,
} from "./verify-preview-env-parity.mjs";

test("parses quoted Vercel environment files", () => {
  assert.deepEqual(parseVercelEnv('A="worker\\nvalue"\nB=true\n'), {
    A: "worker\nvalue",
    B: "true",
  });
});

test("accepts exact parity while treating empty reference values as opaque", () => {
  assert.deepEqual(verifyPreviewEnvParity({
    URL: "https://worker.example",
    SECRET: "",
    VERCEL_OIDC_TOKEN: "reference-token",
  }, {
    URL: "https://worker.example",
    SECRET: "",
    VERCEL_OIDC_TOKEN: "candidate-token",
  }), {
    reference_keys: 2,
    candidate_keys: 2,
    opaque_keys: 1,
  });
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
