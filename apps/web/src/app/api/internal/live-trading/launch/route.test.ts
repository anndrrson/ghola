import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/private-agent-worker-readiness", () => ({
  probeLiveTradingWorkerReadiness: vi.fn(async () => ({
    ready: true,
    endpoint_configured: true,
    contract_version: 2,
    worker_git_sha: "a".repeat(40),
    worker_image_digest: `sha256:${"b".repeat(64)}`,
    config_fingerprint: "mocked_by_route",
    capabilities: ["limit_order"],
    reason_codes: [],
    checked_at: new Date().toISOString(),
  })),
}));

import { GET, POST } from "./route";
import { currentLiveTradingReleaseIdentity } from "@/lib/live-trading-release.server";
import {
  getLiveTradingLaunchControl,
  putLiveTradingCapabilityEvidence,
  resetLiveTradingStoreForTests,
} from "@/lib/live-trading-store";

const TOKEN = "live-trading-control-token-value-123456789";
const SHA = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const ORIGINAL_ENV = { ...process.env };
const KEYS = Object.keys(exactEnv());

describe("live-trading operator launch control", () => {
  beforeEach(() => {
    Object.assign(process.env, exactEnv());
    resetLiveTradingStoreForTests();
  });

  afterEach(() => {
    vi.clearAllMocks();
    resetLiveTradingStoreForTests();
    for (const key of KEYS) {
      if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
      else process.env[key] = ORIGINAL_ENV[key];
    }
  });

  it("requires operator authentication", async () => {
    expect((await GET(new Request("http://localhost/api/internal/live-trading/launch"))).status).toBe(401);
  });

  it("requires three proofs and the exact public confirmation", async () => {
    expect((await transition("canary")).status).toBe(200);
    expect((await transition("public")).status).toBe(409);
    await recordProofs(2);
    expect((await transition("public", "ACTIVATE HYPERLIQUID MAINNET LIVE TRADING")).status).toBe(409);
    await recordProof(2);
    expect((await transition("public")).status).toBe(409);

    const activated = await transition("public", "ACTIVATE HYPERLIQUID MAINNET LIVE TRADING");
    expect(activated.status).toBe(200);
    expect(await activated.json()).toMatchObject({
      accepted: true,
      launch_control: {
        state: "public",
        public_capabilities: ["limit_order"],
        caps: { max_order_notional_usd: 100, rolling_24h_notional_usd: 500 },
      },
    });
  });

  it("persists an immediate kill without needing a confirmation", async () => {
    await transition("canary");
    const killed = await transition("killed");
    expect(killed.status).toBe(200);
    expect(await getLiveTradingLaunchControl()).toMatchObject({
      state: "killed",
      updated_by: "test-operator",
    });
  });
});

async function recordProofs(count: number) {
  for (let index = 0; index < count; index += 1) await recordProof(index);
}

async function recordProof(index: number) {
  const release = currentLiveTradingReleaseIdentity();
  const observed = new Date(Date.now() - 30_000 + index * 1_000);
  await putLiveTradingCapabilityEvidence({
    version: 2,
    evidence_id: `operator_proof_${index}`,
    capability: "limit_order",
    venue_id: "hyperliquid",
    network: "mainnet",
    status: "green",
    broadcast_performed: true,
    reconciled: true,
    final_flat: true,
    open_order_count: 0,
    order_notional_usd: 10.5,
    web_git_sha: release.web_git_sha as string,
    worker_git_sha: release.worker_git_sha as string,
    worker_image_digest: release.worker_image_digest as string,
    config_fingerprint: release.config_fingerprint,
    receipt_commitment: `receipt_${index}`,
    result_commitment: `result_${index}`,
    proof_subject_commitment: `proof_account_${index}`,
    reason: null,
    observed_at: observed.toISOString(),
    expires_at: new Date(observed.getTime() + 60 * 60_000).toISOString(),
    created_at: observed.toISOString(),
  });
}

function transition(state: "canary" | "public" | "killed", confirmation?: string) {
  return POST(new Request("http://localhost/api/internal/live-trading/launch", {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ state, updated_by: "test-operator", ...(confirmation ? { confirmation } : {}) }),
  }));
}

function exactEnv(): Record<string, string> {
  return {
    GHOLA_LIVE_TRADING_CONTROL_TOKEN: TOKEN,
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
    GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64: Buffer.alloc(44, 7).toString("base64"),
    GHOLA_WEB_GIT_SHA: SHA,
    GHOLA_PRIVATE_AGENT_WORKER_GIT_SHA: SHA,
    GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST: DIGEST,
  };
}
