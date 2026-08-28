import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  auditPhalaWorkerEnv,
  auditWorkerWebAuthorization,
} from "./phala-worker-env.mjs";

const DIGEST = `sha256:${"a".repeat(64)}`;
const FUNDING_KEY = generateKeyPairSync("ed25519").privateKey.export({
  format: "der",
  type: "pkcs8",
}).toString("base64");

function completeEnv(overrides = {}) {
  return {
    GHOLA_PRIVATE_AGENT_WORKER_IMAGE: "ghcr.io/anndrrson/ghola:private-agent-worker-sha",
    GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST: DIGEST,
    PRIVATE_AGENT_EXECUTION_TOKEN: "execution-token",
    PRIVATE_AGENT_WORKER_CAPABILITY_SECRET: "capability-secret",
    PRIVATE_AGENT_FUNDING_SIGNING_KEY: FUNDING_KEY,
    PHALA_CVM_IMAGE_DIGEST: DIGEST,
    PRIVATE_AGENT_VENUE_DRY_RUN: "false",
    PRIVATE_AGENT_GLOBAL_KILL_SWITCH: "false",
    PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT: "false",
    PRIVATE_AGENT_STATE_STORE: "postgres",
    PRIVATE_AGENT_STATE_POSTGRES_URL: "postgres://state",
    PRIVATE_AGENT_MAX_VENUE_REQUESTS_PER_MINUTE: "60",
    PRIVATE_AGENT_MIN_ORDER_NOTIONAL_USD: "0",
    PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET: "false",
    PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE: "disabled",
    PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD: "5",
    PRIVATE_AGENT_HYPERLIQUID_DAILY_NOTIONAL_CAP_USD: "25",
    PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS: "50",
    ...overrides,
  };
}

test("accepts a complete fail-closed worker env", () => {
  const audit = auditPhalaWorkerEnv(completeEnv());
  assert.equal(audit.complete, true);
  assert.deepEqual(audit.missing, []);
  assert.deepEqual(audit.invalid, []);
  assert.match(audit.capability_secret_fingerprint, /^sha256:[0-9a-f]{12}$/);
});

test("rejects missing auth and mismatched image pins", () => {
  const audit = auditPhalaWorkerEnv(completeEnv({
    PRIVATE_AGENT_WORKER_CAPABILITY_SECRET: "",
    PHALA_CVM_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
  }));
  assert.equal(audit.complete, false);
  assert.ok(audit.missing.includes("PRIVATE_AGENT_WORKER_CAPABILITY_SECRET"));
  assert.ok(audit.invalid.includes("worker image and runtime image digests do not match"));
});

test("rejects placeholder and malformed signing material", () => {
  const audit = auditPhalaWorkerEnv(completeEnv({
    PRIVATE_AGENT_EXECUTION_TOKEN: "REPLACE_ME",
    PRIVATE_AGENT_FUNDING_SIGNING_KEY: "not-a-key",
  }));
  assert.equal(audit.complete, false);
  assert.ok(audit.invalid.includes("PRIVATE_AGENT_EXECUTION_TOKEN contains a placeholder"));
  assert.ok(audit.invalid.includes("PRIVATE_AGENT_FUNDING_SIGNING_KEY must be base64 PKCS8 Ed25519 material"));
});

test("requires explicit full-ticket caps", () => {
  const audit = auditPhalaWorkerEnv(completeEnv({
    PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE: "full_ticket",
  }));
  assert.equal(audit.complete, false);
  assert.ok(audit.missing.includes("PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD"));
  assert.ok(audit.missing.includes("PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD"));
});

test("requires durable state configuration", () => {
  const postgres = auditPhalaWorkerEnv(completeEnv({ PRIVATE_AGENT_STATE_POSTGRES_URL: "" }));
  assert.ok(postgres.invalid.some((value) => value.includes("postgres state requires")));

  const single = auditPhalaWorkerEnv(completeEnv({
    PRIVATE_AGENT_STATE_STORE: "json",
    PRIVATE_AGENT_STATE_POSTGRES_URL: "",
  }));
  assert.ok(single.invalid.some((value) => value.includes("SINGLE_CVM_OK=true")));
});

test("compares web and worker authorization without exposing secrets", () => {
  const worker = completeEnv();
  const aligned = auditWorkerWebAuthorization(worker, {
    PRIVATE_AGENT_WORKER_CAPABILITY_SECRET: worker.PRIVATE_AGENT_WORKER_CAPABILITY_SECRET,
    GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: worker.PRIVATE_AGENT_EXECUTION_TOKEN,
  });
  assert.equal(aligned.aligned, true);
  assert.equal(JSON.stringify(aligned).includes(worker.PRIVATE_AGENT_EXECUTION_TOKEN), false);

  const drift = auditWorkerWebAuthorization(worker, {
    PRIVATE_AGENT_WORKER_CAPABILITY_SECRET: "different",
    GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: worker.PRIVATE_AGENT_EXECUTION_TOKEN,
  });
  assert.equal(drift.aligned, false);
  assert.equal(drift.capability_secret_match, false);
});
