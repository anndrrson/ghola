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

function workerResponse(overrides: Record<string, unknown> = {}) {
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
  }), { status: 200, headers: { "content-type": "application/json" } });
}
