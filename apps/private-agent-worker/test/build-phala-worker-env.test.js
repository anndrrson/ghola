import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("Phala env builder validates the exact live contract and signer binding", () => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-phala-env-"));
  try {
    const pair = generateKeyPairSync("ed25519");
    const privateKey = pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const input = join(dir, "input.env");
    const output = join(dir, "output.env");
    writeFileSync(input, liveEnv(privateKey, publicKey));

    const accepted = runBuilder(input, output);
    assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
    const built = readFileSync(output, "utf8");
    assert.match(built, /PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE=full_ticket/);
    assert.match(built, /PRIVATE_AGENT_HYPERLIQUID_MAINNET_PROOF_ENABLED=true/);
    assert.match(built, /PRIVATE_AGENT_HYPERLIQUID_TIMEOUT_MS=30000/);
    assert.match(built, new RegExp(`GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64=${escapeRegex(publicKey)}`));

    writeFileSync(input, liveEnv(privateKey, publicKey).replace(
      "PRIVATE_AGENT_LIVE_TRADING_CAPABILITIES=limit_order\n",
      "PRIVATE_AGENT_HYPERLIQUID_RISK_REDUCTION_ENABLED=true\nPRIVATE_AGENT_LIVE_TRADING_CAPABILITIES=limit_order,cancel,reduce_only\n",
    ));
    const riskReduction = runBuilder(input, output);
    assert.equal(riskReduction.status, 0, riskReduction.stderr || riskReduction.stdout);
    assert.match(readFileSync(output, "utf8"), /PRIVATE_AGENT_HYPERLIQUID_RISK_REDUCTION_ENABLED=true/);

    writeFileSync(input, liveEnv(privateKey, Buffer.alloc(44, 9).toString("base64")));
    const wrongSigner = runBuilder(input, output);
    assert.equal(wrongSigner.status, 1);
    assert.match(wrongSigner.stderr, /must pin the configured funding signer/);

    writeFileSync(input, `${liveEnv(privateKey, publicKey)}GHOLA_HYPERLIQUID_LIVE_MODE=full_ticket\n`);
    const legacy = runBuilder(input, output);
    assert.equal(legacy.status, 1);
    assert.match(legacy.stderr, /is deprecated/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runBuilder(input, output) {
  return spawnSync(process.execPath, [
    resolve("../../scripts/build-phala-worker-env.mjs"),
    "--env",
    input,
    "--out",
    output,
  ], { cwd: resolve("../.."), encoding: "utf8" });
}

function liveEnv(privateKey, publicKey) {
  return [
    "PRIVATE_AGENT_EXECUTION_TOKEN=execution-token-value",
    "PRIVATE_AGENT_WORKER_CAPABILITY_SECRET=capability-secret-value",
    `PRIVATE_AGENT_FUNDING_SIGNING_KEY=${privateKey}`,
    `GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64=${publicKey}`,
    "PRIVATE_AGENT_STATE_STORE=postgres",
    "PRIVATE_AGENT_STATE_POSTGRES_URL=postgres://worker-state.example/test",
    "PRIVATE_AGENT_REQUIRE_DSTACK_QUOTE=true",
    "PRIVATE_AGENT_REQUIRE_WORKER_CAPABILITY=true",
    "PRIVATE_AGENT_VENUE_DRY_RUN=false",
    "PRIVATE_AGENT_GLOBAL_KILL_SWITCH=false",
    "PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET=true",
    "PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE=full_ticket",
    "PRIVATE_AGENT_HYPERLIQUID_MAINNET_PROOF_ENABLED=true",
    "PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD=100",
    "PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD=500",
    "PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS=100",
    "PRIVATE_AGENT_LIVE_MAX_ORDER_NOTIONAL_USD=100",
    "PRIVATE_AGENT_LIVE_DAILY_NOTIONAL_CAP_USD=500",
    "PRIVATE_AGENT_LIVE_TRADING_CAPABILITIES=limit_order",
    `PRIVATE_AGENT_BUILD_GIT_SHA=${"a".repeat(40)}`,
    `PRIVATE_AGENT_IMAGE_DIGEST=sha256:${"b".repeat(64)}`,
  ].join("\n") + "\n";
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
