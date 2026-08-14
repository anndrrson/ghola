import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPrivateAccountAction,
  createPrivateExecutionAccount,
  gholaCommitment,
  previewPrivateAccountAction,
  type GholaPrivateModeEvidenceChain,
} from "./private-account";
import {
  buildPrivateExecutionPlan,
  refreshShieldedSettlementEvidence,
  settlePrivateExecutionPlan,
} from "./private-account-execution-plan";
import { shieldedPoolHealth } from "./private-account-shielded-pool";
import { brandPrivateAgentMockTransport } from "./private-agent-spend-policy";

const NOW = new Date("2026-05-27T12:00:00.000Z");

describe("private account production settlement planning", () => {
  beforeEach(() => {
    delete process.env.GHOLA_SHIELDED_POOL_MODE;
    process.env.GHOLA_SHIELDED_POOL_INDEXER_URL = "https://indexer.ghola.test";
    process.env.GHOLA_SHIELDED_POOL_PROVER_URL = "https://prover.ghola.test";
    process.env.GHOLA_SHIELDED_POOL_RELAYER_URL = "https://relayer.ghola.test";
    process.env.GHOLA_PRIVATE_RUNTIME_URL = "https://runtime.ghola.test";
    process.env.GHOLA_SHIELDED_POOL_MAX_STALE_MS = "300000";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GHOLA_SHIELDED_POOL_INDEXER_URL;
    delete process.env.GHOLA_SHIELDED_POOL_PROVER_URL;
    delete process.env.GHOLA_SHIELDED_POOL_RELAYER_URL;
    delete process.env.GHOLA_PRIVATE_RUNTIME_URL;
    delete process.env.GHOLA_SHIELDED_POOL_MAX_STALE_MS;
    delete process.env.GHOLA_PRIVATE_RUNTIME_MEASUREMENT_COMMITMENT;
    delete process.env.GHOLA_PRIVATE_RUNTIME_COMMITMENT;
    delete process.env.GHOLA_PRIVATE_RUNTIME_TOKEN;
  });

  it("does not fall back to local settlement evidence when the sealed runtime is unavailable", async () => {
    const fetchImpl = brandPrivateAgentMockTransport((async (input: string | URL | Request) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      if (url.includes("/private-mode/settle")) {
        return Response.json({ ok: false }, { status: 503 });
      }
      return greenHealth(url);
    }) as typeof fetch);

    const plan = await readyShieldedPlan(fetchImpl);
    const settled = await settlePrivateExecutionPlan({
      plan,
      approval_commitment: "approval_test",
      execution_commitment: "exec_test",
      now: NOW,
      fetchImpl,
    });

    expect(settled).toEqual({
      ok: false,
      error: "sealed_runtime_settlement_unavailable",
    });
  });

  it("keeps finality-pending runtime evidence out of finalized status", async () => {
    const fetchImpl = brandPrivateAgentMockTransport((async (input: string | URL | Request) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      if (url.includes("/private-mode/settle")) {
        return Response.json({
          ok: true,
          network: "solana-mainnet",
          root_commitment: "root_test",
          proof_commitment: "proof_test",
          witness_commitment: "witness_test",
          relay_commitment: "relay_test",
          finality_commitment: "finality_test",
          relay_status: "accepted",
          lifecycle_status: "finality_pending",
        });
      }
      return greenHealth(url);
    }) as typeof fetch);

    const plan = await readyShieldedPlan(fetchImpl);
    const settled = await settlePrivateExecutionPlan({
      plan,
      approval_commitment: "approval_test",
      execution_commitment: "exec_test",
      now: NOW,
      fetchImpl,
    });

    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.evidence.lifecycle_status).toBe("finality_pending");
    expect(settled.evidence.root_commitment).toBe("root_test");
    expect(settled.evidence.proof_commitment).toBe("proof_test");
    expect(settled.evidence.relay_status.status).toBe("accepted");
  });

  it("does not poll settlement status or forward its runtime token through the default test transport", async () => {
    const fetchImpl = brandPrivateAgentMockTransport((async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/private-mode/settle")) {
        return Response.json({
          ok: true,
          network: "solana-mainnet",
          root_commitment: "root_test",
          proof_commitment: "proof_test",
          witness_commitment: "witness_test",
          relay_commitment: "relay_test",
          finality_commitment: "finality_test",
          relay_status: "accepted",
          lifecycle_status: "finality_pending",
        });
      }
      return greenHealth(url);
    }) as typeof fetch);
    const plan = await readyShieldedPlan(fetchImpl);
    const settled = await settlePrivateExecutionPlan({
      plan,
      approval_commitment: "approval_test",
      execution_commitment: "exec_test",
      now: NOW,
      fetchImpl,
    });
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;

    process.env.GHOLA_PRIVATE_RUNTIME_TOKEN = "sealed-runtime-token";
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchSpy);
    const refreshed = await refreshShieldedSettlementEvidence({
      evidence: settled.evidence,
      now: new Date("2026-05-27T12:01:00.000Z"),
    });

    expect(refreshed).toEqual(settled.evidence);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

async function readyShieldedPlan(fetchImpl: typeof fetch) {
  const account = createPrivateExecutionAccount({
    sessionId: "session",
    turnkeyWalletId: "wallet",
    vaultSeed: "vault",
    vaultReady: true,
  });
  const action = createPrivateAccountAction({
    action_class: "transfer",
    product_bucket: "stablecoin",
    now: NOW,
  });
  const evidenceChain: GholaPrivateModeEvidenceChain = {
    version: 1,
    funding_import_commitment: "funding_import_test",
    batch_id: "batch_test",
    batch_evidence_commitment: "anon_evidence_test",
    preview_commitment: "pending",
    approval_commitment: null,
    execution_commitment: null,
  };
  const preview = previewPrivateAccountAction({
    account,
    action,
    platform_class: "solana_private_balance",
    requested_rail: "shielded_pool",
    anonymity_set: {
      required: 2,
      effective: 2,
      amount_bucketed: true,
      timing_window_met: true,
      uniqueness_score_bps: 0,
    },
    evidence_status: "ready",
    evidence_chain: evidenceChain,
    sealed_runtime_context: sealedRuntime(),
    schedule_decision: scheduleDecision(),
    rotation: platformRotation(),
    linkability_simulation: linkabilitySimulation(),
    require_private_mode_evidence: true,
    now: NOW,
  });
  const health = await shieldedPoolHealth(NOW, { fetchImpl });
  const plan = buildPrivateExecutionPlan({
    preview,
    shielded_pool_health: health,
    evidence_chain: evidenceChain,
    now: NOW,
  });
  expect(plan.status).toBe("ready");
  return plan;
}

function greenHealth(url: string) {
  return Response.json({
    status: "green",
    observed_at: NOW.toISOString(),
    commitment: gholaCommitment("service", url),
  });
}

function sealedRuntime() {
  return {
    version: 1 as const,
    runtime_status: "ready" as const,
    runtime_mode: "http" as const,
    runtime_envelope_commitment: "runtime_envelope_test",
    runtime_attestation_commitment: "runtime_attestation_test",
    runtime_measurement_commitment: "runtime_measurement_test",
    runtime_policy_commitment: "runtime_policy_test",
    runtime_health_commitment: "runtime_health_test",
    runtime_observed_at: NOW.toISOString(),
    reason_codes: [],
  };
}

function scheduleDecision() {
  return {
    version: 1 as const,
    schedule_commitment: "privacy_schedule_test",
    mode: "ready_now" as const,
    status: "ready" as const,
    privacy_window_commitment: "privacy_window_test",
    execute_after: null,
    reason_codes: [],
  };
}

function platformRotation() {
  return {
    version: 1 as const,
    rotation_commitment: "platform_rotation_test",
    platform_funding_account_commitment: "platform_funding_account_test",
    rotation_epoch_commitment: "platform_rotation_epoch_test",
    reuse_count: 0,
    withdrawal_destination_reuse_count: 0,
    status: "ready" as const,
    reason_codes: [],
  };
}

function linkabilitySimulation() {
  return {
    version: 1 as const,
    simulator_commitment: "adversarial_linkability_simulator_test",
    score_bps: 0,
    decision: "proceed" as const,
    actors: {
      chain_observer: 0,
      venue: 0,
      solver: 0,
      provider: 0,
      colluding_platforms: 0,
    },
    reason_codes: [],
    simulated_at: NOW.toISOString(),
  };
}
