import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/private-agent-worker-readiness", () => ({
  probeLiveTradingWorkerReadiness: vi.fn(async () => ({
    ready: true,
    endpoint_configured: true,
    contract_version: 2,
    worker_git_sha: "a".repeat(40),
    worker_image_digest: `sha256:${"b".repeat(64)}`,
    config_fingerprint: "mocked_by_route",
    capabilities: ["limit_order", "cancel", "reduce_only", "stop_loss", "take_profit"],
    reason_codes: [],
    checked_at: new Date().toISOString(),
  })),
}));

import { GET, POST } from "./route";
import { currentLiveTradingReleaseIdentity } from "@/lib/live-trading-release.server";
import {
  probeLiveTradingWorkerReadiness,
  type LiveTradingWorkerReadiness,
} from "@/lib/private-agent-worker-readiness";
import {
  getLiveTradingLaunchControl,
  putLiveTradingCapabilityEvidence,
  resetLiveTradingStoreForTests,
} from "@/lib/live-trading-store";

const TOKEN = "live-trading-control-token-value-123456789";
const RESET_TOKEN = "live-trading-reset-token-value-1234567890";
const SHA = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const PUBLIC_CONFIRMATION = "ACTIVATE HYPERLIQUID MAINNET LIVE TRADING";
const KILL_CONFIRMATION = "KILL HYPERLIQUID MAINNET LIVE TRADING";
const RESET_CONFIRMATION = "RESET KILLED LIVE TRADING TO DISABLED";
const ORIGINAL_ENV = { ...process.env };
const KEYS = Object.keys(exactEnv());

describe("live-trading operator launch control", () => {
  beforeEach(() => {
    Object.assign(process.env, exactEnv());
    resetLiveTradingStoreForTests();
    vi.mocked(probeLiveTradingWorkerReadiness).mockReset();
    vi.mocked(probeLiveTradingWorkerReadiness).mockResolvedValue(readyWorker());
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
    expect((await transition("public", PUBLIC_CONFIRMATION)).status).toBe(409);
    await recordProof(2);
    expect((await transition("public")).status).toBe(409);

    const activated = await transition("public", PUBLIC_CONFIRMATION);
    expect(activated.status).toBe(200);
    expect(await activated.json()).toMatchObject({
      accepted: true,
      launch_control: {
        state: "public",
        public_capabilities: ["limit_order", "cancel", "reduce_only", "stop_loss", "take_profit"],
        caps: { max_order_notional_usd: 100, rolling_24h_notional_usd: 500 },
      },
    });
  });

  it("persists a confirmed kill without readiness or diagnostics", async () => {
    vi.mocked(probeLiveTradingWorkerReadiness).mockImplementation(async () =>
      await new Promise<never>(() => undefined));
    expect((await transition("killed")).status).toBe(409);
    const killed = await transition("killed", KILL_CONFIRMATION);
    expect(killed.status).toBe(200);
    expect(await getLiveTradingLaunchControl()).toMatchObject({
      state: "killed",
      revision: 1,
      updated_by: "test-operator",
    });
    expect(probeLiveTradingWorkerReadiness).not.toHaveBeenCalled();
  });

  it("keeps killed absorbing against a stale public activation", async () => {
    expect((await transition("canary")).status).toBe(200);
    await recordProofs(3);
    let releaseProbe: (() => void) | undefined;
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    vi.mocked(probeLiveTradingWorkerReadiness).mockImplementationOnce(async () => {
      await probeGate;
      return readyWorker();
    });

    const staleActivation = transition("public", PUBLIC_CONFIRMATION);
    await vi.waitFor(() => expect(probeLiveTradingWorkerReadiness).toHaveBeenCalledTimes(2));
    expect((await transition("killed", KILL_CONFIRMATION)).status).toBe(200);
    releaseProbe?.();

    const staleResponse = await staleActivation;
    expect(staleResponse.status).toBe(409);
    expect(await staleResponse.json()).toMatchObject({ error: "launch_killed_absorbing" });
    expect(await getLiveTradingLaunchControl()).toMatchObject({ state: "killed", revision: 2 });
  });

  it("denies activation from killed without probing the worker", async () => {
    expect((await transition("killed", KILL_CONFIRMATION)).status).toBe(200);
    expect((await transition("canary")).status).toBe(409);
    expect((await transition("public", PUBLIC_CONFIRMATION)).status).toBe(409);
    expect(probeLiveTradingWorkerReadiness).not.toHaveBeenCalled();
  });

  it("requires separate reset authority, exact confirmation, and exact killed revision", async () => {
    const killed = await transition("killed", KILL_CONFIRMATION);
    const killedBody = await killed.json() as { launch_control: { revision: number } };
    const revision = killedBody.launch_control.revision;

    expect((await transition("disabled", RESET_CONFIRMATION, { expectedRevision: revision })).status).toBe(409);
    expect((await transition("disabled", undefined, { token: RESET_TOKEN, expectedRevision: revision })).status).toBe(409);
    expect((await transition("disabled", RESET_CONFIRMATION, {
      token: RESET_TOKEN,
      expectedRevision: revision + 1,
    })).status).toBe(409);

    const reset = await transition("disabled", RESET_CONFIRMATION, {
      token: RESET_TOKEN,
      expectedRevision: revision,
    });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({
      accepted: true,
      launch_control: { state: "disabled", revision: revision + 1 },
    });
  });
});

async function recordProofs(count: number) {
  for (let index = 0; index < count; index += 1) await recordProof(index);
}

async function recordProof(index: number) {
  const release = currentLiveTradingReleaseIdentity();
  const observed = new Date(Date.now() - 30_000 + index * 1_000);
  for (const capability of ["limit_order", "cancel", "reduce_only", "stop_loss", "take_profit"] as const) {
    await putLiveTradingCapabilityEvidence({
      version: 2,
      evidence_id: `operator_proof_${capability}_${index}`,
      capability,
      venue_id: "hyperliquid",
      network: "mainnet",
      status: "green",
      broadcast_performed: true,
      reconciled: true,
      final_flat: true,
      open_order_count: 0,
      order_notional_usd: 11,
      web_git_sha: release.web_git_sha as string,
      worker_git_sha: release.worker_git_sha as string,
      worker_image_digest: release.worker_image_digest as string,
      config_fingerprint: release.config_fingerprint,
      receipt_commitment: `receipt_${capability}_${index}`,
      result_commitment: `result_${capability}_${index}`,
      venue_account_commitment: `sha256:${index.toString(16).padStart(64, "0")}`,
      proof_subject_commitment: `sha256:${index.toString(16).padStart(64, "0")}`,
      reason: null,
      observed_at: observed.toISOString(),
      expires_at: new Date(observed.getTime() + 60 * 60_000).toISOString(),
      created_at: observed.toISOString(),
    });
  }
}

function transition(
  state: "disabled" | "canary" | "public" | "killed",
  confirmation?: string,
  options: { token?: string; expectedRevision?: number } = {},
) {
  return POST(new Request("http://localhost/api/internal/live-trading/launch", {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.token ?? TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      state,
      updated_by: "test-operator",
      ...(confirmation ? { confirmation } : {}),
      ...(options.expectedRevision === undefined ? {} : { expected_revision: options.expectedRevision }),
    }),
  }));
}

function readyWorker(): LiveTradingWorkerReadiness {
  return {
    ready: true,
    endpoint_configured: true,
    contract_version: 2 as const,
    worker_git_sha: SHA,
    worker_image_digest: DIGEST,
    config_fingerprint: "mocked_by_route",
    capabilities: ["limit_order", "cancel", "reduce_only", "stop_loss", "take_profit"],
    reason_codes: [],
    checked_at: new Date().toISOString(),
  };
}

function exactEnv(): Record<string, string> {
  return {
    GHOLA_LIVE_TRADING_CONTROL_TOKEN: TOKEN,
    GHOLA_LIVE_TRADING_RESET_TOKEN: RESET_TOKEN,
    GHOLA_INVESTOR_CANARY_SECRET: "Q9mV4xR7kT2pN8cL5wD1hF6jB3zY0uSa",
    GHOLA_LIVE_TRADING_PUBLIC_ENABLED: "true",
    GHOLA_LIVE_TRADING_PUBLIC_CAPABILITIES: "limit_order,cancel,reduce_only,stop_loss,take_profit",
    GHOLA_LIVE_TRADING_MAX_ORDER_NOTIONAL_USD: "100",
    GHOLA_LIVE_TRADING_DAILY_CAP_USD: "500",
    GHOLA_LIVE_TRADING_MAX_SLIPPAGE_BPS: "100",
    GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET: "secure_private_account_request_proof_secret_value",
    GHOLA_PRIVATE_ACCOUNT_STORE: "postgres",
    GHOLA_PRIVATE_ACCOUNT_DATABASE_URL: "postgres://configured.example/ghola",
    GHOLA_PRIVATE_AGENT_PROVISIONING_MUTATIONS_ENABLED: "false",
    GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.ghola.xyz",
    GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "B7zL4qN9wX2cV8mK5rT1yP6sD3fH0jUa",
    PRIVATE_AGENT_EXECUTION_TOKEN: "B7zL4qN9wX2cV8mK5rT1yP6sD3fH0jUa",
    PRIVATE_AGENT_WORKER_CAPABILITY_SECRET: "M8pR2vW7xZ4cN9kL5tQ1sD6fH3jY0uBa",
    NEXT_PUBLIC_GOOGLE_CLIENT_ID: "ghola-investor.apps.googleusercontent.com",
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
    PRIVATE_AGENT_HYPERLIQUID_RISK_REDUCTION_ENABLED: "true",
    GHOLA_LIVE_TRADING_POSITION_PROTECTION_ENABLED: "true",
    PRIVATE_AGENT_GLOBAL_KILL_SWITCH: "false",
    GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64: Buffer.alloc(44, 7).toString("base64"),
    GHOLA_WEB_GIT_SHA: SHA,
    GHOLA_BAKED_WEB_GIT_SHA: SHA,
    VERCEL_GIT_COMMIT_SHA: SHA,
    GHOLA_PRIVATE_AGENT_WORKER_GIT_SHA: SHA,
    GHOLA_PRIVATE_AGENT_WORKER_IMAGE: `ghcr.io/anndrrson/ghola:private-agent-worker-${SHA}`,
    GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST: DIGEST,
    PRIVATE_AGENT_IMAGE_DIGEST: DIGEST,
    PHALA_CVM_IMAGE_DIGEST: DIGEST,
  };
}
