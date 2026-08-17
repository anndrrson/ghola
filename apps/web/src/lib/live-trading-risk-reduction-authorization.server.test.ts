import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  account: vi.fn(),
  vault: vi.fn(),
  worker: vi.fn(),
  release: vi.fn(),
  launch: vi.fn(),
}));

vi.mock("./private-account-store", () => ({
  getPrivateAccountByOwner: mocks.account,
  getHyperliquidExecutionVaultByAccount: mocks.vault,
  getLatestVenueEligibilityByAccount: vi.fn(),
}));
vi.mock("./private-agent-worker-readiness", () => ({
  probeEmergencyLiveTradingWorkerReadiness: mocks.worker,
  probeLiveTradingWorkerReadiness: vi.fn(),
}));
vi.mock("./live-trading-release.server", () => ({
  currentLiveTradingReleaseIdentity: mocks.release,
  liveTradingLaunchBindingFailures: vi.fn(),
}));
vi.mock("./live-trading-store", () => ({
  evaluateLiveTradingCapability: vi.fn(),
  getActiveLiveTradingAccountGraduation: vi.fn(),
  getLiveTradingLaunchControl: mocks.launch,
  reserveLiveTradingNotional: vi.fn(),
}));

import { authorizeLiveTradingRiskReduction } from "./live-trading-authorization.server";

const env = {
  GHOLA_LIVE_TRADING_PUBLIC_CAPABILITIES: "limit_order,cancel,reduce_only",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.account.mockResolvedValue({ account_commitment: "account_commitment_risk_123" });
  mocks.vault.mockResolvedValue({
    owner_commitment: "owner_commitment_risk_123",
    account_commitment: "account_commitment_risk_123",
    vault_commitment: "vault_commitment_risk_123",
    status: "sealed",
  });
  mocks.release.mockReturnValue({
    contract_version: 2,
    web_git_sha: "a".repeat(40),
    worker_git_sha: "a".repeat(40),
    worker_image_digest: `sha256:${"b".repeat(64)}`,
    config_fingerprint: "live_trading_config_risk_123",
    valid: true,
    reason_codes: [],
  });
  mocks.worker.mockResolvedValue({ ready: true, reason_codes: [] });
  mocks.launch.mockRejectedValue(new Error("launch state is killed or disabled"));
});

describe("risk-reduction authorization", () => {
  it.each(["killed", "disabled"])("survives %s launch and unavailable billing", async (launchState) => {
    mocks.launch.mockResolvedValue({ state: launchState });
    const unavailableBilling = vi.fn(async () => { throw new Error("billing unavailable"); }) as unknown as typeof fetch;
    const result = await authorizeLiveTradingRiskReduction({
      owner_commitment: "owner_commitment_risk_123",
      web_session_token: "expired-or-unavailable-billing-session",
      emergency_action: "kill_and_flat",
      required_capabilities: ["cancel", "reduce_only"],
      env,
      fetchImpl: unavailableBilling,
    });
    expect(result).toEqual({
      ok: true,
      account_commitment: "account_commitment_risk_123",
      vault_commitment: "vault_commitment_risk_123",
    });
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(unavailableBilling).not.toHaveBeenCalled();
    expect(mocks.worker).toHaveBeenCalledWith(expect.objectContaining({
      action: "kill_and_flat",
      requiredCapabilities: ["cancel", "reduce_only"],
    }));
  });

  it("fails closed without the matching sealed owner vault", async () => {
    mocks.vault.mockResolvedValue(null);
    await expect(authorize()).resolves.toMatchObject({
      ok: false,
      error: "sealed_hyperliquid_vault_required",
    });
  });

  it("fails closed on stale or unattested worker readiness", async () => {
    mocks.worker.mockResolvedValue({ ready: false, reason_codes: ["worker_attestation_stale"] });
    await expect(authorize()).resolves.toEqual({
      ok: false,
      error: "live_trading_gate_closed",
      status: 503,
      reason_codes: ["worker_attestation_stale"],
    });
  });

  it("fails closed when risk capabilities or the exact release are invalid", async () => {
    await expect(authorize({ GHOLA_LIVE_TRADING_PUBLIC_CAPABILITIES: "limit_order" })).resolves.toMatchObject({
      ok: false,
      error: "live_capability_not_public",
    });
    mocks.release.mockReturnValue({ valid: false, reason_codes: ["worker_release_identity_missing"] });
    await expect(authorize()).resolves.toMatchObject({
      ok: false,
      error: "live_trading_gate_closed",
      reason_codes: ["worker_release_identity_missing"],
    });
  });
});

function authorize(customEnv = env) {
  return authorizeLiveTradingRiskReduction({
    owner_commitment: "owner_commitment_risk_123",
    web_session_token: "session-token",
    emergency_action: "kill_and_flat",
    required_capabilities: ["cancel", "reduce_only"],
    env: customEnv,
    fetchImpl: vi.fn() as unknown as typeof fetch,
  });
}
