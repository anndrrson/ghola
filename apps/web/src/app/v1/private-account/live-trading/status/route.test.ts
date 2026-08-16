import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLiveTradingStatusGet } from "./_handler";
import { GET } from "./route";
import { POST as postCapabilityEvidence } from "@/app/api/internal/live-trading/capability-evidence/route";
import { canonicalLiveTradingCaps } from "@/lib/live-trading-contract";
import { currentLiveTradingReleaseIdentity } from "@/lib/live-trading-release.server";
import {
  putLiveTradingCapabilityEvidence,
  putLiveTradingLaunchControl,
  resetLiveTradingStoreForTests,
} from "@/lib/live-trading-store";
import { brandPrivateAgentMockTransport } from "@/lib/private-agent-spend-policy";

const SHA = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const ENV_KEYS = [
  "GHOLA_LIVE_TRADING_PUBLIC_ENABLED",
  "GHOLA_LIVE_TRADING_PUBLIC_CAPABILITIES",
  "GHOLA_LIVE_TRADING_MAX_ORDER_NOTIONAL_USD",
  "GHOLA_LIVE_TRADING_DAILY_CAP_USD",
  "GHOLA_LIVE_TRADING_MAX_SLIPPAGE_BPS",
  "GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET",
  "GHOLA_V6_HYPERLIQUID_PILOT_ENABLED",
  "GHOLA_HYPERLIQUID_LIVE_MODE",
  "PRIVATE_AGENT_VENUE_DRY_RUN",
  "PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET",
  "PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE",
  "PRIVATE_AGENT_HYPERLIQUID_MAINNET_PROOF_ENABLED",
  "PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD",
  "PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD",
  "PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS",
  "PRIVATE_AGENT_LIVE_MAX_ORDER_NOTIONAL_USD",
  "PRIVATE_AGENT_LIVE_DAILY_NOTIONAL_CAP_USD",
  "PRIVATE_AGENT_STATE_STORE",
  "PRIVATE_AGENT_REQUIRE_DSTACK_QUOTE",
  "PRIVATE_AGENT_REQUIRE_WORKER_CAPABILITY",
  "PRIVATE_AGENT_GLOBAL_KILL_SWITCH",
  "GHOLA_WEB_GIT_SHA",
  "GHOLA_PRIVATE_AGENT_WORKER_GIT_SHA",
  "GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST",
  "GHOLA_PRIVATE_AGENT_EXECUTION_URL",
  "PRIVATE_AGENT_WORKER_CAPABILITY_SECRET",
  "GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64",
  "GHOLA_LIVE_TRADING_CONTROL_TOKEN",
] as const;

describe("private account live trading launch gate", () => {
  beforeEach(async () => {
    clearEnv();
    await resetLiveTradingStoreForTests();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    clearEnv();
    await resetLiveTradingStoreForTests();
  });

  it("keeps public live trading red by default", async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      contract_version: 2,
      status: "red",
      launch_state: "disabled",
      live_trading_enabled: false,
      live_submit_mode: "disabled",
      pooled_live_trading_enabled: false,
      public_live_copy_allowed: false,
    });
    expect(body.reason_codes).toContain("live_trading_public_flag_disabled");
  });

  it("turns green only for the exact public release with three funded proofs", async () => {
    enableExactEnvironment();
    await primeLaunch("public", 3);
    const fetchMock = readyWorkerMock();

    const response = await statusGet(fetchMock)();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: "green",
      launch_state: "public",
      live_trading_enabled: true,
      live_submit_mode: "byo_mainnet",
      byo_live_trading_enabled: true,
      pooled_live_trading_enabled: false,
      public_live_copy_allowed: true,
      effective_caps: canonicalLiveTradingCaps(),
      reason_codes: [],
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(body.byo_live_venues.filter((venue: { status: string }) => venue.status === "green"))
      .toEqual([expect.objectContaining({ id: "hyperliquid" })]);
    expect(body.hyperliquid_capabilities.find((item: { id: string }) => item.id === "limit_order"))
      .toMatchObject({ state: "live", visible: true, consecutive_mainnet_proofs: 3 });
    expect(body.pooled_reason_codes).toEqual(["pooled_execution_not_in_launch"]);
  });

  it("keeps a fully proven canary hidden until explicit public activation", async () => {
    enableExactEnvironment();
    await primeLaunch("canary", 3);
    const response = await statusGet(readyWorkerMock())();
    const body = await response.json();

    expect(body.status).toBe("red");
    expect(body.launch_state).toBe("canary");
    expect(body.public_live_copy_allowed).toBe(false);
    expect(body.reason_codes).toContain("live_trading_launch_state_invalid");
    expect(body.hyperliquid_capabilities.find((item: { id: string }) => item.id === "limit_order"))
      .toMatchObject({ state: "verifying", visible: false, consecutive_mainnet_proofs: 3 });
  });

  it("resets the consecutive proof sequence after a red canary result", async () => {
    enableExactEnvironment();
    await primeLaunch("public", 3);
    await putEvidence("red", 10);

    const body = await (await statusGet(readyWorkerMock())()).json();
    const limit = body.hyperliquid_capabilities.find((item: { id: string }) => item.id === "limit_order");
    expect(body.status).toBe("red");
    expect(limit).toMatchObject({ state: "disabled", consecutive_mainnet_proofs: 0 });
  });

  it("fails closed on release drift and durable kill", async () => {
    enableExactEnvironment();
    await primeLaunch("public", 3);
    process.env.GHOLA_WEB_GIT_SHA = "c".repeat(40);

    let body = await (await statusGet(readyWorkerMock())()).json();
    expect(body.status).toBe("red");
    expect(body.reason_codes).toEqual(expect.arrayContaining([
      "web_worker_release_mismatch",
      "launch_release_binding_mismatch",
    ]));

    process.env.GHOLA_WEB_GIT_SHA = SHA;
    await primeLaunch("killed", 3);
    body = await (await statusGet(readyWorkerMock())()).json();
    expect(body.status).toBe("red");
    expect(body.reason_codes).toContain("live_trading_killed");
  });

  it("rejects legacy live mode and manual green evidence", async () => {
    enableExactEnvironment();
    await primeLaunch("canary", 0);
    process.env.GHOLA_HYPERLIQUID_LIVE_MODE = "full_ticket";
    let body = await (await statusGet(readyWorkerMock())()).json();
    expect(body.reason_codes).toContain("legacy_hyperliquid_live_mode_present");

    process.env.GHOLA_LIVE_TRADING_CONTROL_TOKEN = "control-token-strong-value-123456789";
    const release = currentLiveTradingReleaseIdentity();
    const response = await postCapabilityEvidence(new Request("https://ghola.test/api/internal/live-trading/capability-evidence", {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.GHOLA_LIVE_TRADING_CONTROL_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        capability: "limit_order",
        status: "green",
        venue_id: "hyperliquid",
        network: "mainnet",
        broadcast_performed: true,
        reconciled: true,
        final_flat: true,
        open_order_count: 0,
        order_notional_usd: 10.5,
        web_git_sha: release.web_git_sha,
        worker_git_sha: release.worker_git_sha,
        worker_image_digest: release.worker_image_digest,
        config_fingerprint: release.config_fingerprint,
        receipt_commitment: "receipt_commitment_manual",
        result_commitment: "result_commitment_manual",
        observed_at: new Date().toISOString(),
      }),
    }));
    body = await response.json();
    expect(response.status).toBe(400);
    expect(body.reason_codes).toContain("green_evidence_must_be_worker_recorded");
  });
});

function enableExactEnvironment() {
  Object.assign(process.env, {
    GHOLA_LIVE_TRADING_PUBLIC_ENABLED: "true",
    GHOLA_LIVE_TRADING_PUBLIC_CAPABILITIES: "limit_order",
    GHOLA_LIVE_TRADING_MAX_ORDER_NOTIONAL_USD: "100",
    GHOLA_LIVE_TRADING_DAILY_CAP_USD: "500",
    GHOLA_LIVE_TRADING_MAX_SLIPPAGE_BPS: "100",
    GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET: "secure_private_account_request_proof_secret_value",
    GHOLA_V6_HYPERLIQUID_PILOT_ENABLED: "true",
    PRIVATE_AGENT_VENUE_DRY_RUN: "false",
    PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET: "true",
    PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE: "full_ticket",
    PRIVATE_AGENT_HYPERLIQUID_MAINNET_PROOF_ENABLED: "true",
    PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD: "100",
    PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD: "500",
    PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS: "100",
    PRIVATE_AGENT_LIVE_MAX_ORDER_NOTIONAL_USD: "100",
    PRIVATE_AGENT_LIVE_DAILY_NOTIONAL_CAP_USD: "500",
    PRIVATE_AGENT_STATE_STORE: "postgres",
    PRIVATE_AGENT_REQUIRE_DSTACK_QUOTE: "true",
    PRIVATE_AGENT_REQUIRE_WORKER_CAPABILITY: "true",
    PRIVATE_AGENT_GLOBAL_KILL_SWITCH: "false",
    GHOLA_WEB_GIT_SHA: SHA,
    GHOLA_PRIVATE_AGENT_WORKER_GIT_SHA: SHA,
    GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST: DIGEST,
    GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.ghola.test",
    PRIVATE_AGENT_WORKER_CAPABILITY_SECRET: "worker-capability-secret-value-123456789",
    GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64: Buffer.alloc(44, 7).toString("base64"),
  });
}

async function primeLaunch(state: "canary" | "public" | "killed", proofCount: number) {
  const release = currentLiveTradingReleaseIdentity();
  const now = new Date().toISOString();
  await putLiveTradingLaunchControl({
    version: 2,
    state,
    contract_version: 2,
    web_git_sha: release.web_git_sha,
    worker_git_sha: release.worker_git_sha,
    worker_image_digest: release.worker_image_digest,
    config_fingerprint: release.config_fingerprint,
    public_capabilities: ["limit_order"],
    caps: canonicalLiveTradingCaps(),
    evidence_commitment: "launch_evidence_commitment",
    updated_by: "test-operator",
    created_at: now,
    updated_at: now,
  });
  for (let index = 0; index < proofCount; index += 1) await putEvidence("green", index);
}

async function putEvidence(status: "green" | "red", offset: number) {
  const release = currentLiveTradingReleaseIdentity();
  const observed = new Date(Date.now() - 60_000 + offset * 1_000);
  await putLiveTradingCapabilityEvidence({
    version: 2,
    evidence_id: `evidence_${status}_${offset}_${observed.getTime()}`,
    capability: "limit_order",
    venue_id: "hyperliquid",
    network: "mainnet",
    status,
    broadcast_performed: status === "green",
    reconciled: status === "green",
    final_flat: status === "green",
    open_order_count: status === "green" ? 0 : -1,
    order_notional_usd: 10.5,
    web_git_sha: release.web_git_sha as string,
    worker_git_sha: release.worker_git_sha as string,
    worker_image_digest: release.worker_image_digest as string,
    config_fingerprint: release.config_fingerprint,
    receipt_commitment: status === "green" ? `receipt_commitment_${offset}` : null,
    result_commitment: status === "green" ? `result_commitment_${offset}` : null,
    venue_account_commitment: status === "green"
      ? `sha256:${offset.toString(16).padStart(64, "0")}`
      : null,
    proof_subject_commitment: status === "green"
      ? `sha256:${offset.toString(16).padStart(64, "0")}`
      : null,
    reason: status === "red" ? "canary_failure" : null,
    observed_at: observed.toISOString(),
    expires_at: new Date(observed.getTime() + 60 * 60_000).toISOString(),
    created_at: observed.toISOString(),
  });
}

function readyWorkerMock() {
  const release = currentLiveTradingReleaseIdentity();
  return vi.fn<typeof fetch>().mockResolvedValue(Response.json({
    ready: true,
    missing: [],
    live_trading: {
      ready: true,
      reason_codes: [],
      contract_version: 2,
      worker_git_sha: release.worker_git_sha,
      worker_image_digest: release.worker_image_digest,
      config_fingerprint: release.config_fingerprint,
      caps: {
        max_order_notional_usd: 100,
        rolling_24h_notional_usd: 500,
        max_slippage_bps: 100,
      },
      capabilities: ["limit_order", "cancel", "reduce_only"],
    },
  }));
}

function statusGet(fetchImpl: typeof fetch) {
  return createLiveTradingStatusGet({ fetchImpl: brandPrivateAgentMockTransport(fetchImpl) });
}

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}
