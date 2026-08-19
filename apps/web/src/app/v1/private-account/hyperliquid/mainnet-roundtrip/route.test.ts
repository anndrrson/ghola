import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hyperliquidMainnetProofUiEnabled,
  recordValidatedHyperliquidMainnetCapabilityEvidence,
  runAtExactHyperliquidProofLaunchEpoch,
  validHyperliquidMainnetProofReport,
} from "../../_lib";
import {
  evaluateLiveTradingCapability,
  putLiveTradingLaunchControl,
  resetLiveTradingStoreForTests,
  transitionLiveTradingLaunchControl,
} from "@/lib/live-trading-store";
import {
  LIVE_TRADING_REQUIRED_CAPABILITIES,
  type LiveTradingReleaseIdentity,
} from "@/lib/live-trading-contract";
import { POST } from "./route";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  resetLiveTradingStoreForTests();
});

describe("Hyperliquid mainnet proof route", () => {
  it("is unavailable unless the local loopback execution gate is exact", async () => {
    delete process.env.GHOLA_HYPERLIQUID_MAINNET_PROOF_UI_ENABLED;
    const response = await POST(new Request(
      "http://localhost:3000/v1/private-account/hyperliquid/mainnet-roundtrip",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    ));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "hyperliquid_mainnet_roundtrip_unavailable" });
  });

  it("requires explicit spend gates and a loopback worker", () => {
    const env = {
      NODE_ENV: "development",
      GHOLA_HYPERLIQUID_MAINNET_PROOF_UI_ENABLED: "true",
      GHOLA_PRIVATE_AGENT_SPEND_ARMED: "true",
      GHOLA_PRIVATE_AGENT_REMOTE_EXECUTION_DISABLED: "false",
      GHOLA_PRIVATE_AGENT_SPEND_LOCKDOWN: "false",
      GHOLA_PRIVATE_AGENT_EXECUTION_URL: "http://127.0.0.1:8787",
    };
    expect(hyperliquidMainnetProofUiEnabled(env)).toBe(true);
    expect(hyperliquidMainnetProofUiEnabled({ ...env, GHOLA_PRIVATE_AGENT_SPEND_ARMED: "false" })).toBe(false);
    expect(hyperliquidMainnetProofUiEnabled({ ...env, GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example" })).toBe(false);
    expect(hyperliquidMainnetProofUiEnabled({ ...env, NODE_ENV: "production" })).toBe(false);
  });

  it("blocks a generic paid account before wallet-proof consumption during canary", async () => {
    await setCanary();
    enableProofRoute();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain("/api/billing/status");
      return Response.json(billing({ access_source: "subscription", invite_state: "none" }));
    });
    vi.stubGlobal("fetch", fetchImpl);

    const response = await POST(proofRequest());
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ error: "investor_invite_required" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/api/billing/status");
  });

  it("lets an active complimentary canary pass reach the guarded proof flow", async () => {
    await setCanary();
    enableProofRoute();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain("/api/billing/status");
      return Response.json(billing());
    });
    vi.stubGlobal("fetch", fetchImpl);

    const response = await POST(proofRequest());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "mobile_wallet_step_up_required" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not run worker or evidence work after a stale proof epoch is killed", async () => {
    const launch = await setCanary();
    await transitionLiveTradingLaunchControl({
      kind: "kill",
      updated_by: "emergency-test",
      updated_at: new Date().toISOString(),
      evidence_commitment: "proof_epoch_kill_evidence",
    });
    const operation = vi.fn(async () => Response.json({ ok: true }));

    await expect(runAtExactHyperliquidProofLaunchEpoch({
      state: "canary",
      revision: launch.revision,
    }, operation)).resolves.toMatchObject({
      ok: false,
      error: "live_trading_killed",
      status: 409,
    });
    expect(operation).not.toHaveBeenCalled();
  });

  it("records all five capabilities green only for strict two-child protection proof", async () => {
    const release = proofRelease();
    const report = proofReport(release);
    expect(validHyperliquidMainnetProofReport(report, release)).toBe(true);
    await expect(recordValidatedHyperliquidMainnetCapabilityEvidence({
      release,
      report,
      receiptCommitment: "proof_receipt_commitment_valid",
    })).resolves.toBe("green");
    for (const capability of LIVE_TRADING_REQUIRED_CAPABILITIES) {
      await expect(evaluateLiveTradingCapability({
        capability,
        release,
        launch_state: "canary",
        visible: false,
      })).resolves.toMatchObject({ consecutive_mainnet_proofs: 1 });
    }

    for (const missing of ["take_profit", "stop_loss"] as const) {
      resetLiveTradingStoreForTests();
      const invalid = structuredClone(report);
      delete invalid.venue_evidence.protection[missing];
      expect(validHyperliquidMainnetProofReport(invalid, release)).toBe(false);
      await expect(recordValidatedHyperliquidMainnetCapabilityEvidence({
        release,
        report: invalid,
        receiptCommitment: "must_not_turn_green",
        reason: `missing_${missing}`,
      })).resolves.toBe("red");
      for (const capability of LIVE_TRADING_REQUIRED_CAPABILITIES) {
        await expect(evaluateLiveTradingCapability({
          capability,
          release,
          launch_state: "canary",
          visible: false,
        })).resolves.toMatchObject({
          consecutive_mainnet_proofs: 0,
          reason_codes: expect.arrayContaining(["capability_proof_failed"]),
        });
      }
    }
  });
});

function enableProofRoute() {
  Object.assign(process.env, { NODE_ENV: "development" });
  process.env.GHOLA_HYPERLIQUID_MAINNET_PROOF_UI_ENABLED = "true";
  process.env.GHOLA_PRIVATE_AGENT_SPEND_ARMED = "true";
  process.env.GHOLA_PRIVATE_AGENT_REMOTE_EXECUTION_DISABLED = "false";
  process.env.GHOLA_PRIVATE_AGENT_SPEND_LOCKDOWN = "false";
  process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL = "http://127.0.0.1:8787";
  process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
}

function proofRequest() {
  const authorization = `Bearer ${[
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: "canary-user", email: "canary@example.com" })).toString("base64url"),
    "sig",
  ].join(".")}`;
  return new Request("http://localhost:3000/v1/private-account/hyperliquid/mainnet-roundtrip", {
    method: "POST",
    headers: { "content-type": "application/json", authorization },
    body: "{}",
  });
}

async function setCanary() {
  const now = new Date().toISOString();
  return putLiveTradingLaunchControl({
    version: 2,
    state: "canary",
    contract_version: 2,
    web_git_sha: "a".repeat(40),
    worker_git_sha: "a".repeat(40),
    worker_image_digest: `sha256:${"b".repeat(64)}`,
    config_fingerprint: `live_trading_config_${"c".repeat(48)}`,
    public_capabilities: ["limit_order", "cancel", "reduce_only", "stop_loss", "take_profit"],
    caps: {
      first_proof_notional_usd: 11,
      max_order_notional_usd: 100,
      rolling_24h_notional_usd: 500,
      default_slippage_bps: 50,
      max_slippage_bps: 100,
    },
    evidence_commitment: null,
    updated_by: "test",
    created_at: now,
    updated_at: now,
  });
}

function billing(overrides: Record<string, unknown> = {}) {
  const past = new Date(Date.now() - 60_000).toISOString();
  const future = new Date(Date.now() + 60 * 60_000).toISOString();
  return {
    tier: "starter",
    access_source: "complimentary_pass",
    access_state: "active",
    invite_state: "active",
    expires_at: future,
    private_agent_compute: {
      remaining_seconds: 3_600,
      active_agent_limit: 1,
      active_agent_count: 0,
      period_start: past,
      period_end: future,
    },
    private_agent_trading: {
      remaining_included_notional_micro_usd: 100_000_000,
      overage_fee_bps: 0,
      cap_reached: false,
      live_trading_allowed: true,
      period_start: past,
      period_end: future,
    },
    ...overrides,
  };
}

function proofRelease(): LiveTradingReleaseIdentity {
  return {
    contract_version: 2,
    web_git_sha: "a".repeat(40),
    worker_git_sha: "a".repeat(40),
    worker_image_digest: `sha256:${"b".repeat(64)}`,
    config_fingerprint: `live_trading_config_${"c".repeat(48)}`,
    valid: true,
    reason_codes: [],
  };
}

function proofReport(release: LiveTradingReleaseIdentity) {
  const completedAt = new Date().toISOString();
  const takeProfit = protectionLeg("201", `0x${"c".repeat(32)}`);
  const stopLoss = protectionLeg("202", `0x${"d".repeat(32)}`);
  const entry = filledLeg("101", `0x${"a".repeat(32)}`, false, `0x${"e".repeat(64)}`);
  const exit = filledLeg("102", `0x${"b".repeat(32)}`, true, `0x${"f".repeat(64)}`);
  const releaseBinding = {
    contract_version: 2,
    web_git_sha: release.web_git_sha,
    worker_git_sha: release.worker_git_sha,
    worker_image_digest: release.worker_image_digest,
    config_fingerprint: release.config_fingerprint,
  };
  return {
    ok: true,
    status: "filled",
    network: "mainnet",
    market: "HYPE",
    notional_usd: 11,
    max_slippage_bps: 100,
    claim_store: "postgres",
    release_binding: releaseBinding,
    entry_status: "filled",
    preflight_verified: true,
    api_wallet_authorization_verified: true,
    api_wallet_address: `0x${"1".repeat(40)}`,
    api_wallet_valid_until: new Date(Date.now() + 60 * 60_000).toISOString(),
    preflight_transaction_broadcast: false,
    preflight_action_expiry_proven: true,
    entry_order_readback_proven: true,
    entry_fill_proven: true,
    duplicate_entry_prevented: true,
    opened_position_verified: true,
    venue_position_protection_proven: true,
    take_profit_oid: takeProfit.oid,
    take_profit_cloid: takeProfit.cloid,
    stop_loss_oid: stopLoss.oid,
    stop_loss_cloid: stopLoss.cloid,
    protection_acceptance: {
      take_profit: acceptanceLeg(takeProfit),
      stop_loss: acceptanceLeg(stopLoss),
    },
    protection_cleanup_confirmed: true,
    protection_cleanup: {
      take_profit: cleanupLeg(takeProfit),
      stop_loss: cleanupLeg(stopLoss),
    },
    protection_children_terminal: true,
    protection_children_no_fill_proven: true,
    default_margin_mode: "isolated",
    default_leverage: 1,
    exit_status: "filled",
    exit_order_readback_proven: true,
    exit_fill_proven: true,
    duplicate_exit_prevented: true,
    stored_receipt_replayed: true,
    independent_venue_evidence_proven: true,
    venue_evidence_commitment: `sha256:${"9".repeat(64)}`,
    venue_evidence: {
      proof_kind: "hyperliquid_mainnet_public_venue_evidence_v1",
      independently_queried: true,
      network: "mainnet",
      market: "HYPE",
      account_address_commitment: `sha256:${"8".repeat(64)}`,
      entry_exit_sizes_match: true,
      entry_before_exit: true,
      reduce_only_exit_proven: true,
      position_protection_proven: true,
      protection_children_terminal: true,
      protection_children_no_fill_proven: true,
      protection: { take_profit: takeProfit, stop_loss: stopLoss },
      transaction_hashes_distinct: true,
      flat_after_exit: true,
      open_orders_after_exit: 0,
      entry,
      exit,
      verified_at: completedAt,
    },
    entry_order_reference: entry,
    exit_order_reference: exit,
    flat_after_exit: true,
    open_orders_after_exit: 0,
    proof_work_order_commitment: "proof_work_order_commitment",
    entry_work_order_commitment: "entry_work_order_commitment",
    exit_work_order_commitment: "exit_work_order_commitment",
    final_proof: {
      venue_position_protection_proven: true,
      protection_cleanup_proven: true,
      protection_children_terminal: true,
      protection_children_no_fill_proven: true,
    },
    completed_at: completedAt,
  };
}

function protectionLeg(oid: string, cloid: string) {
  return {
    oid,
    cloid,
    order_status: "canceled",
    venue_accepted: true,
    venue_order_readback_proven: true,
    final_cancellation_proven: true,
    final_no_fill_proven: true,
    fill_count: 0,
    filled_base_size: "0",
    side: "sell",
    reduce_only: true,
    trigger_order: true,
  };
}

function acceptanceLeg(leg: { oid: string; cloid: string }) {
  return { ...leg, venue_accepted: true, venue_order_readback_proven: true };
}

function cleanupLeg(leg: { oid: string; cloid: string }) {
  return {
    oid: leg.oid,
    cloid: leg.cloid,
    terminal_status: "canceled",
    cancellation_readback_proven: true,
    final_cancellation_proven: true,
    broadcast_performed: true,
    already_terminal: false,
    action_expiry_proven: true,
  };
}

function filledLeg(oid: string, cloid: string, reduceOnly: boolean, hash: string) {
  return {
    oid,
    cloid,
    order_status: "filled",
    reduce_only: reduceOnly,
    filled_base_size: "0.18",
    average_fill_price: 60,
    filled_notional_usd: 11,
    fee_usd: 0.004,
    fee_token: "USDC",
    transaction_hashes: [hash],
  };
}
