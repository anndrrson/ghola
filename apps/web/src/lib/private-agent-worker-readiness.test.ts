import { beforeEach, describe, expect, it, vi } from "vitest";

const gates = vi.hoisted(() => ({
  normal: vi.fn(),
  emergency: vi.fn(),
}));

vi.mock("./private-agent-spend-policy", () => ({
  privateAgentTransportAllowed: gates.normal,
  privateAgentEmergencyControlTransportAllowed: gates.emergency,
}));

import {
  probeEmergencyLiveTradingWorkerReadiness,
  probeLiveTradingWorkerReadiness,
} from "./private-agent-worker-readiness";
import { canonicalLiveTradingCaps, type LiveTradingReleaseIdentity } from "./live-trading-contract";

const release: LiveTradingReleaseIdentity = {
  contract_version: 2,
  web_git_sha: "a".repeat(40),
  worker_git_sha: "a".repeat(40),
  worker_image_digest: `sha256:${"b".repeat(64)}`,
  config_fingerprint: "live_trading_config_emergency_123",
  valid: true,
  reason_codes: [],
};
const env = {
  GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example",
  GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "configured-worker-auth",
};

beforeEach(() => {
  vi.clearAllMocks();
  gates.normal.mockReturnValue(false);
  gates.emergency.mockReturnValue(true);
});

describe("emergency live-worker readiness", () => {
  it("crosses spend lockdown only through the emergency gate and keeps exact release checks", async () => {
    const fetchImpl = vi.fn(async () => workerResponse()) as unknown as typeof fetch;

    await expect(probeLiveTradingWorkerReadiness({
      env,
      fetchImpl,
      expectedRelease: release,
      requiredCapabilities: ["cancel", "reduce_only"],
    })).resolves.toMatchObject({ ready: false, reason_codes: ["live_worker_not_configured"] });

    await expect(probeEmergencyLiveTradingWorkerReadiness({
      action: "kill_and_flat",
      env,
      fetchImpl,
      expectedRelease: release,
      requiredCapabilities: ["cancel", "reduce_only"],
    })).resolves.toMatchObject({
      ready: true,
      worker_git_sha: release.worker_git_sha,
      worker_image_digest: release.worker_image_digest,
      config_fingerprint: release.config_fingerprint,
      capabilities: ["cancel", "reduce_only"],
    });
    expect(gates.normal).toHaveBeenCalledWith("discover", env, fetchImpl);
    expect(gates.emergency).toHaveBeenCalledWith("kill_and_flat", env, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("tolerates only the coherent killed-live pair while normal readiness stays closed", async () => {
    gates.normal.mockReturnValue(true);
    const fetchImpl = vi.fn(async () => workerResponse({
      live_trading: {
        ready: false,
        reason_codes: ["worker_global_kill_active"],
      },
    })) as unknown as typeof fetch;

    await expect(probeLiveTradingWorkerReadiness({
      env,
      fetchImpl,
      expectedRelease: release,
      requiredCapabilities: ["cancel", "reduce_only"],
    })).resolves.toMatchObject({
      ready: false,
      reason_codes: ["worker_global_kill_active", "worker_live_contract_not_ready"],
    });

    await expect(probeEmergencyLiveTradingWorkerReadiness({
      action: "kill_and_flat",
      env,
      fetchImpl,
      expectedRelease: release,
      requiredCapabilities: ["cancel", "reduce_only"],
    })).resolves.toMatchObject({ ready: true, reason_codes: [] });
  });

  it("rejects kill reason strings unless the live sub-contract is actually killed", async () => {
    const fetchImpl = vi.fn(async () => workerResponse({
      live_trading: {
        ready: true,
        reason_codes: ["worker_global_kill_active", "worker_live_contract_not_ready"],
      },
    })) as unknown as typeof fetch;

    await expect(probeEmergencyLiveTradingWorkerReadiness({
      action: "close",
      env,
      fetchImpl,
      expectedRelease: release,
      requiredCapabilities: ["reduce_only"],
    })).resolves.toMatchObject({
      ready: false,
      reason_codes: ["worker_global_kill_active", "worker_live_contract_not_ready"],
    });
  });

  it("rejects every non-kill contract, release, cap, capability, or auth reason", async () => {
    const fetchImpl = vi.fn(async () => workerResponse({
      live_trading: {
        ready: false,
        reason_codes: ["worker_global_kill_active", "worker_capability_auth_not_required"],
        worker_git_sha: "c".repeat(40),
        worker_image_digest: `sha256:${"d".repeat(64)}`,
        config_fingerprint: "live_trading_config_other",
        capabilities: ["cancel"],
        caps: {
          max_order_notional_usd: 99,
          rolling_24h_notional_usd: 499,
          max_slippage_bps: 99,
        },
      },
    })) as unknown as typeof fetch;

    const result = await probeEmergencyLiveTradingWorkerReadiness({
      action: "kill_and_flat",
      env,
      fetchImpl,
      expectedRelease: release,
      requiredCapabilities: ["cancel", "reduce_only"],
    });
    expect(result.ready).toBe(false);
    expect(result.reason_codes).toEqual(expect.arrayContaining([
      "worker_capability_auth_not_required",
      "worker_git_sha_mismatch",
      "worker_image_digest_mismatch",
      "worker_config_fingerprint_mismatch",
      "worker_max_order_cap_mismatch",
      "worker_daily_cap_mismatch",
      "worker_slippage_cap_mismatch",
      "worker_capability_missing:reduce_only",
    ]));
  });

  it("requires healthy general readiness even when the live contract is killed", async () => {
    const fetchImpl = vi.fn(async () => workerResponse({
      ready: false,
      live_trading: {
        ready: false,
        reason_codes: ["worker_global_kill_active"],
      },
    }, 503)) as unknown as typeof fetch;

    await expect(probeEmergencyLiveTradingWorkerReadiness({
      action: "close",
      env,
      fetchImpl,
      expectedRelease: release,
      requiredCapabilities: ["reduce_only"],
    })).resolves.toMatchObject({ ready: false, reason_codes: ["live_worker_not_ready"] });
  });

  it("requires configured worker authentication before probing an emergency exit", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(probeEmergencyLiveTradingWorkerReadiness({
      action: "close",
      env: { GHOLA_PRIVATE_AGENT_EXECUTION_URL: env.GHOLA_PRIVATE_AGENT_EXECUTION_URL },
      fetchImpl,
      expectedRelease: release,
      requiredCapabilities: ["reduce_only"],
    })).resolves.toMatchObject({ ready: false, reason_codes: ["live_worker_not_configured"] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("still fails closed on stale attestation or release mismatch", async () => {
    const staleFetch = vi.fn(async () => workerResponse({
      ready: false,
      missing: ["attestation"],
      live_trading: { ready: false, worker_git_sha: "c".repeat(40) },
    })) as unknown as typeof fetch;
    const result = await probeEmergencyLiveTradingWorkerReadiness({
      action: "close",
      env,
      fetchImpl: staleFetch,
      expectedRelease: release,
      requiredCapabilities: ["reduce_only"],
    });
    expect(result.ready).toBe(false);
    expect(result.reason_codes).toEqual(expect.arrayContaining([
      "worker_missing:attestation",
      "live_worker_not_ready",
      "worker_live_contract_not_ready",
      "worker_git_sha_mismatch",
    ]));
  });
});

function workerResponse(overrides: Record<string, unknown> = {}, status = 200) {
  const liveOverride = overrides.live_trading && typeof overrides.live_trading === "object"
    ? overrides.live_trading as Record<string, unknown>
    : {};
  return new Response(JSON.stringify({
    ready: true,
    missing: [],
    ...overrides,
    live_trading: {
      ready: true,
      contract_version: 2,
      worker_git_sha: release.worker_git_sha,
      worker_image_digest: release.worker_image_digest,
      config_fingerprint: release.config_fingerprint,
      capabilities: ["limit_order", "cancel", "reduce_only"],
      caps: canonicalLiveTradingCaps(),
      reason_codes: [],
      ...liveOverride,
    },
  }), { status, headers: { "content-type": "application/json" } });
}
