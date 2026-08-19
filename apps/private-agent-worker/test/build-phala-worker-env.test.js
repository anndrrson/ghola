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
      "PRIVATE_AGENT_LIVE_TRADING_CAPABILITIES=limit_order,cancel,reduce_only,stop_loss,take_profit\n",
      "PRIVATE_AGENT_LIVE_TRADING_CAPABILITIES=limit_order,cancel,reduce_only\n",
    ));
    const missingProtectionCapabilities = runBuilder(input, output);
    assert.equal(missingProtectionCapabilities.status, 1);
    assert.match(missingProtectionCapabilities.stderr, /PRIVATE_AGENT_LIVE_TRADING_CAPABILITIES/);

    writeFileSync(input, liveEnv(privateKey, publicKey).replace(
      "GHOLA_LIVE_TRADING_POSITION_PROTECTION_ENABLED=true\n",
      "GHOLA_LIVE_TRADING_POSITION_PROTECTION_ENABLED=false\n",
    ));
    const missingProtectionFlag = runBuilder(input, output);
    assert.equal(missingProtectionFlag.status, 1);
    assert.match(missingProtectionFlag.stderr, /GHOLA_LIVE_TRADING_POSITION_PROTECTION_ENABLED/);

    writeFileSync(input, liveEnv(privateKey, publicKey).replace("a".repeat(40), "a".repeat(12)));
    const shortSha = runBuilder(input, output);
    assert.equal(shortSha.status, 1);
    assert.match(shortSha.stderr, /exact lowercase 40-character release SHA/);

    writeFileSync(input, liveEnv(privateKey, publicKey).replace(
      `GHOLA_PRIVATE_AGENT_WORKER_IMAGE=ghcr.io/anndrrson/ghola:private-agent-worker-${"a".repeat(40)}`,
      "GHOLA_PRIVATE_AGENT_WORKER_IMAGE=ghcr.io/anndrrson/ghola:private-agent-worker-stale",
    ));
    const staleImage = runBuilder(input, output);
    assert.equal(staleImage.status, 1);
    assert.match(staleImage.stderr, /exact source-bound tag/);

    writeFileSync(input, liveEnv(privateKey, publicKey).replace(
      `PRIVATE_AGENT_IMAGE_DIGEST=sha256:${"b".repeat(64)}`,
      `PRIVATE_AGENT_IMAGE_DIGEST=${"b".repeat(64)}`,
    ));
    const bareDigest = runBuilder(input, output);
    assert.equal(bareDigest.status, 1);
    assert.match(bareDigest.stderr, /canonical lowercase sha256/);

    writeFileSync(input, liveEnv(privateKey, publicKey).replace(
      "PRIVATE_AGENT_EXECUTION_TOKEN=B7zL4qN9wX2cV8mK5rT1yP6sD3fH0jUa",
      "PRIVATE_AGENT_EXECUTION_TOKEN=short",
    ));
    const weakSecret = runBuilder(input, output);
    assert.equal(weakSecret.status, 1);
    assert.match(weakSecret.stderr, /strong 32\+ character secret/);

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

test("static Phala compose forwards position-protection readiness", () => {
  const compose = readFileSync(resolve("docker-compose.phala.yml"), "utf8");
  assert.match(
    compose,
    /GHOLA_LIVE_TRADING_POSITION_PROTECTION_ENABLED: "\$\{GHOLA_LIVE_TRADING_POSITION_PROTECTION_ENABLED:-false\}"/,
  );
  assert.match(
    compose,
    /PRIVATE_AGENT_LIVE_TRADING_CAPABILITIES: "\$\{PRIVATE_AGENT_LIVE_TRADING_CAPABILITIES:-limit_order\}"/,
  );
});

test("worker image workflow bakes and source-binds the exact commit SHA", () => {
  const dockerfile = readFileSync(resolve("Dockerfile"), "utf8");
  const workflow = readFileSync(resolve("../../.github/workflows/build-private-agent-worker-image.yml"), "utf8");
  assert.match(dockerfile, /ARG PRIVATE_AGENT_BUILD_GIT_SHA/);
  assert.match(dockerfile, /org\.opencontainers\.image\.revision="\$\{PRIVATE_AGENT_BUILD_GIT_SHA\}"/);
  assert.match(dockerfile, /> \/app\/build-identity\.json/);
  assert.match(workflow, /ref_to_build, checked-out HEAD, and the workflow attestation source SHA/);
  assert.match(workflow, /expected_image="ghcr\.io\/\$\{repository\}:private-agent-worker-\$\{actual\}"/);
  assert.match(workflow, /PRIVATE_AGENT_BUILD_GIT_SHA=\$\{\{ steps\.source\.outputs\.git_sha \}\}/);
  assert.match(workflow, /provenance: mode=max/);
  assert.match(workflow, /sbom: true/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /attestations: write/);
  assert.match(workflow, /subject-name: \$\{\{ steps\.image\.outputs\.name \}\}/);
  assert.match(workflow, /subject-digest: \$\{\{ steps\.build\.outputs\.digest \}\}/);
  assert.match(workflow, /push-to-registry: true/);
  assert.match(workflow, /environment: investor-worker-release/);
  assert.match(workflow, /timeout-minutes: 60/);
  assert.match(workflow, /group: investor-worker-release-\$\{\{ github\.sha \}\}/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /RUN_ATTEMPT: \$\{\{ github\.run_attempt \}\}/);
  assert.match(workflow, /paid worker builds are single-attempt/);
  assert.match(workflow, /immutable image tag already exists/);
  assert.match(workflow, /WORKFLOW_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /uses: actions\/checkout@[0-9a-f]{40}/);
  assert.match(workflow, /uses: docker\/setup-buildx-action@[0-9a-f]{40}/);
  assert.match(workflow, /uses: docker\/login-action@[0-9a-f]{40}/);
  assert.match(workflow, /uses: docker\/build-push-action@[0-9a-f]{40}/);
  assert.match(workflow, /uses: actions\/attest@[0-9a-f]{40}/);
  assert.match(dockerfile, /^FROM node:20-slim@sha256:[0-9a-f]{64}$/m);
  assert.doesNotMatch(dockerfile, /chown -R node:node \/data \/app/);
});

test("Thumper image workflow is immutable, source-bound, and single-attempt", () => {
  const dockerfile = readFileSync(resolve("../../Dockerfile.thumper"), "utf8");
  const workflow = readFileSync(resolve("../../.github/workflows/build-thumper-image.yml"), "utf8");
  assert.match(dockerfile, /^FROM rust:slim-bookworm@sha256:[0-9a-f]{64} AS builder$/m);
  assert.match(dockerfile, /^FROM debian:bookworm-slim@sha256:[0-9a-f]{64}$/m);
  assert.match(dockerfile, /ARG THUMPER_BUILD_GIT_SHA/);
  assert.match(dockerfile, /org\.opencontainers\.image\.revision="\$\{THUMPER_BUILD_GIT_SHA\}"/);
  assert.match(dockerfile, /> \/app\/build-identity\.json/);
  assert.match(workflow, /expected_image="ghcr\.io\/\$\{repository\}:thumper-cloud-\$\{actual\}"/);
  assert.match(workflow, /THUMPER_BUILD_GIT_SHA=\$\{\{ steps\.source\.outputs\.git_sha \}\}/);
  assert.match(workflow, /environment: investor-worker-release/);
  assert.match(workflow, /timeout-minutes: 60/);
  assert.match(workflow, /group: investor-thumper-release-\$\{\{ github\.sha \}\}/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /paid Thumper builds are single-attempt/);
  assert.match(workflow, /immutable image tag already exists/);
  assert.match(workflow, /provenance: mode=max/);
  assert.match(workflow, /sbom: true/);
  assert.match(workflow, /uses: actions\/checkout@[0-9a-f]{40}/);
  assert.match(workflow, /uses: docker\/setup-buildx-action@[0-9a-f]{40}/);
  assert.match(workflow, /uses: docker\/login-action@[0-9a-f]{40}/);
  assert.match(workflow, /uses: docker\/build-push-action@[0-9a-f]{40}/);
  assert.match(workflow, /uses: actions\/attest@[0-9a-f]{40}/);
  assert.match(workflow, /subject-digest: \$\{\{ steps\.build\.outputs\.digest \}\}/);
  assert.match(workflow, /grep -q '\[\[:space:\]\[:cntrl:\]\]'/);
  assert.match(workflow, /ref_to_build, checked-out HEAD, and attestation source SHA must match exactly/);

  const exactTag = /^ghcr\.io\/anndrrson\/ghola:thumper-cloud-[0-9a-f]{40}$/u;
  assert.equal(exactTag.test(`ghcr.io/anndrrson/ghola:thumper-cloud-${"a".repeat(40)}`), true);
  assert.equal(exactTag.test(`ghcr.io/other/ghola:thumper-cloud-${"a".repeat(40)}`), false);
  assert.equal(exactTag.test(`ghcr.io/anndrrson/ghola:thumper-cloud-${"A".repeat(40)}`), false);
  assert.equal(exactTag.test(`ghcr.io/anndrrson/ghola:thumper-cloud-${"a".repeat(39)}`), false);
  assert.equal(exactTag.test("ghcr.io/anndrrson/ghola:latest"), false);
  assert.equal(exactTag.test(`ghcr.io/anndrrson/ghola:thumper-cloud-${"a".repeat(40)}\nevil`), false);
});

test("legacy private-stack workflow is a mutation-free tombstone", () => {
  const workflow = readFileSync(resolve("../../.github/workflows/launch-private-stack.yml"), "utf8");
  assert.match(workflow, /Legacy private trading launch \(disabled\)/);
  assert.match(workflow, /This legacy launch path is permanently disabled/);
  assert.doesNotMatch(workflow, /vercel\s|PHALA_CLOUD_API_KEY|PRIVATE_AGENT_EXECUTION_TOKEN|docker\/build-push-action/);
});

test("pooled testnet cleanup cannot discover or stop production CVMs", () => {
  const workflow = readFileSync(resolve("../../.github/workflows/pooled-testnet-ceremony.yml"), "utf8");
  assert.match(workflow, /--names "\$CVM_NAME"/);
  assert.doesNotMatch(workflow, /--prefixes "ghola-"/);
});

test("release manifests disable automatic service deploys and document the five-capability contract", () => {
  const render = readFileSync(resolve("../../render.yaml"), "utf8");
  const vercel = readFileSync(resolve("../web/vercel.json"), "utf8");
  const runbook = readFileSync(resolve("../../docs/WORKER-DEPLOY-RUNBOOK.md"), "utf8");
  assert.equal((render.match(/autoDeployTrigger: off/g) || []).length, 3);
  assert.match(vercel, /"installCommand": "npm ci --ignore-scripts"/);
  assert.doesNotMatch(vercel, /"crons"/);
  assert.match(runbook, /PRIVATE_AGENT_LIVE_TRADING_CAPABILITIES=limit_order,cancel,reduce_only,stop_loss,take_profit/);
  assert.match(runbook, /Stop and report the first failure\. Never auto-retry a paid build, deploy, or\s+provision/);
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
    "PRIVATE_AGENT_EXECUTION_TOKEN=B7zL4qN9wX2cV8mK5rT1yP6sD3fH0jUa",
    "PRIVATE_AGENT_WORKER_CAPABILITY_SECRET=M8pR2vW7xZ4cN9kL5tQ1sD6fH3jY0uBa",
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
    "PRIVATE_AGENT_HYPERLIQUID_RISK_REDUCTION_ENABLED=true",
    "GHOLA_LIVE_TRADING_POSITION_PROTECTION_ENABLED=true",
    "PRIVATE_AGENT_LIVE_TRADING_CAPABILITIES=limit_order,cancel,reduce_only,stop_loss,take_profit",
    `PRIVATE_AGENT_BUILD_GIT_SHA=${"a".repeat(40)}`,
    `GHOLA_PRIVATE_AGENT_WORKER_IMAGE=ghcr.io/anndrrson/ghola:private-agent-worker-${"a".repeat(40)}`,
    `GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST=sha256:${"b".repeat(64)}`,
    `PRIVATE_AGENT_IMAGE_DIGEST=sha256:${"b".repeat(64)}`,
  ].join("\n") + "\n";
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
