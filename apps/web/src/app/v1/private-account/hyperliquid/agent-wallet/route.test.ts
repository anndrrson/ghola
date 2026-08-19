import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class AuthorizationError extends Error {
    constructor(readonly code: string, readonly status: number) {
      super(code);
    }
  }
  return {
    AuthorizationError,
    verifyVenue: vi.fn(),
    assertBinding: vi.fn(),
    preflight: vi.fn(),
    verifyWorker: vi.fn(),
    verifyLegacyWorker: vi.fn(),
    identityCommitments: vi.fn(),
    seal: vi.fn(),
    revoke: vi.fn(),
    getVault: vi.fn(),
    entitlement: vi.fn(),
    launch: vi.fn(),
    quota: vi.fn(),
  };
});

vi.mock("@/lib/hyperliquid-agent-wallet.server", () => ({
  HyperliquidAgentAuthorizationError: mocks.AuthorizationError,
  assertHyperliquidAgentVaultBinding: mocks.assertBinding,
  preflightHyperliquidMasterAccount: mocks.preflight,
  verifyAndSubmitHyperliquidAgentAuthorization: mocks.verifyVenue,
}));
vi.mock("@/lib/hyperliquid-agent-wallet-worker.server", () => ({
  verifyHyperliquidAgentVaultWithWorker: mocks.verifyWorker,
  verifyLegacyHyperliquidAgentRevokedWithWorker: mocks.verifyLegacyWorker,
}));
vi.mock("@/lib/hyperliquid-vault-seal", () => ({
  hyperliquidVaultIdentityCommitments: mocks.identityCommitments,
}));
vi.mock("@/lib/live-trading-opening-access.server", () => ({
  paidLiveTradingEntitlement: mocks.entitlement,
}));
vi.mock("@/lib/live-trading-store", () => ({
  getLiveTradingLaunchControl: mocks.launch,
}));
vi.mock("@/lib/consumer-production-store", () => ({
  consumeConsumerRateLimit: mocks.quota,
}));
vi.mock("@/lib/private-account-store", () => ({
  getHyperliquidExecutionVaultByAccount: mocks.getVault,
  getLatestVenueEligibilityByAccount: vi.fn(async () => ({
    owner_commitment: "owner_test",
    status: "verified",
    expires_at: "2099-01-01T00:00:00.000Z",
    credential: {
      credential_type: "self_attested_eligible_user",
      eligibility_basis: "self_attested_non_us",
      eligible_non_us: true,
      terms_version: "2026-08-14",
      risk_disclosure_version: "2026-08-14",
      accepted_at: "2026-08-19T00:00:00.000Z",
    },
  })),
}));
vi.mock("../../_lib", () => ({
  createOrGetStoredPrivateAccount: vi.fn(async () => ({ account_commitment: "account_test" })),
  json: (body: unknown, status = 200) => Response.json(body, { status }),
  privateAccountOwnerFromRequest: vi.fn(async () => ({
    owner_commitment: "owner_test",
    user: { email_verified: true },
  })),
  privateAccountSessionTokenFromRequest: vi.fn(() => "session_test"),
  readJson: (request: Request) => request.json(),
  revokeHyperliquidVaultForOwner: mocks.revoke,
  sealHyperliquidVaultFromBody: mocks.seal,
  unauthorized: () => Response.json({ error: "unauthorized" }, { status: 401 }),
}));

import { DELETE, POST } from "./route";

const REQUEST_BODY = {
  version: 1,
  action: {
    type: "approveAgent",
    hyperliquidChain: "Mainnet",
    signatureChainId: "0x66eee",
    agentAddress: `0x${"22".repeat(20)}`,
    agentName: "ghola-mainnet valid_until 1780086400000",
    nonce: 1_780_000_000_000,
  },
  signature: { r: `0x${"33".repeat(32)}`, s: `0x${"44".repeat(32)}`, v: 27 },
  nonce: 1_780_000_000_000,
  encrypted_execution_vault: {
    alg: "sealed-provider-v1",
    ciphertext: "sealed",
    recipient: "attested:test",
    aad: "committed-aad",
  },
};

const VERIFIED = {
  request: REQUEST_BODY,
  authorization: {
    account_address: `0x${"11".repeat(20)}`,
    agent_address: REQUEST_BODY.action.agentAddress,
    agent_base_name: "ghola-mainnet",
    valid_until_ms: 1_780_086_400_000,
    approve_nonce: 1_780_000_000_000,
    recovered_existing_authorization: false,
  },
};

describe("Hyperliquid agent-wallet onboarding route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyVenue.mockResolvedValue(VERIFIED);
    mocks.assertBinding.mockReturnValue({
      venue_account_commitment: "hyperliquid_venue_account_test",
      agent_wallet_commitment: "hyperliquid_agent_wallet_test",
    });
    mocks.verifyWorker.mockResolvedValue({
      verification_commitment: `hyperliquid_agent_onboarding_verification_${"a".repeat(48)}`,
      checked_at: "2026-08-19T00:00:00.000Z",
      worker_contract_version: 2,
      worker_git_sha: "b".repeat(40),
      worker_image_digest: `sha256:${"c".repeat(64)}`,
      config_fingerprint: `live_trading_config_${"d".repeat(48)}`,
    });
    mocks.verifyLegacyWorker.mockResolvedValue({
      verification_commitment: `hyperliquid_agent_legacy_removal_verification_${"e".repeat(48)}`,
      checked_at: "2026-08-19T00:00:00.000Z",
    });
    mocks.entitlement.mockResolvedValue({ ok: true });
    mocks.launch.mockResolvedValue({ state: "public" });
    mocks.quota.mockResolvedValue({ ok: true });
    mocks.seal.mockResolvedValue({ ready: true });
    mocks.identityCommitments.mockReturnValue({
      venue_account_commitment: "hyperliquid_venue_account_test",
      agent_wallet_commitment: "hyperliquid_agent_wallet_replacement",
    });
    mocks.getVault.mockResolvedValue({
      owner_commitment: "owner_test",
      account_commitment: "account_test",
      vault_commitment: "vault_automatic",
      status: "sealed",
      vault: {
        authorization: {
          source: "phantom_approve_agent_v1",
          venue_account_commitment: "hyperliquid_venue_account_test",
          agent_wallet_commitment: "hyperliquid_agent_wallet_original",
        },
      },
    });
    mocks.revoke.mockResolvedValue({ ready: false });
  });

  it("does not persist when the worker cannot prove decryption and exact authority", async () => {
    mocks.verifyWorker.mockRejectedValue(new mocks.AuthorizationError(
      "hyperliquid_agent_vault_worker_verification_unknown",
      503,
    ));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "hyperliquid_agent_vault_worker_verification_unknown",
      retry_safe: true,
    });
    expect(mocks.seal).not.toHaveBeenCalled();
  });

  it("persists only after the worker proof and binds its exact release metadata", async () => {
    const order: string[] = [];
    mocks.verifyWorker.mockImplementation(async () => {
      order.push("worker");
      return {
        verification_commitment: `hyperliquid_agent_onboarding_verification_${"a".repeat(48)}`,
        checked_at: "2026-08-19T00:00:00.000Z",
        worker_contract_version: 2,
        worker_git_sha: "b".repeat(40),
        worker_image_digest: `sha256:${"c".repeat(64)}`,
        config_fingerprint: `live_trading_config_${"d".repeat(48)}`,
      };
    });
    mocks.seal.mockImplementation(async () => {
      order.push("store");
      return { ready: true };
    });

    const response = await POST(request());
    expect(response.status).toBe(201);
    expect(order).toEqual(["worker", "store"]);
    expect(mocks.seal.mock.calls[0]?.[2]?.authorization).toMatchObject({
      worker_verification_commitment: `hyperliquid_agent_onboarding_verification_${"a".repeat(48)}`,
      worker_contract_version: 2,
      worker_git_sha: "b".repeat(40),
      worker_image_digest: `sha256:${"c".repeat(64)}`,
      worker_config_fingerprint: `live_trading_config_${"d".repeat(48)}`,
    });
  });

  it.each([
    [429, "wallet_setup_rate_limited"],
    [503, "wallet_setup_quota_unavailable"],
  ])("marks only pre-submit context failure %s retry-safe", async (status, code) => {
    if (status === 429) {
      mocks.quota.mockResolvedValueOnce({ ok: false, retry_after_seconds: 12 });
    } else {
      mocks.quota.mockRejectedValueOnce(new Error("database unavailable"));
    }
    const response = await POST(request());
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: code, retry_safe: true });
    expect(mocks.verifyVenue).not.toHaveBeenCalled();
  });

  it("never marks authentication or legal-access failures retry-safe", async () => {
    mocks.entitlement.mockResolvedValueOnce({
      ok: false,
      error: "investor_access_required",
      reason_codes: ["complimentary_pass_required"],
      status: 451,
    });
    const legal = await POST(request());
    expect(legal.status).toBe(451);
    expect(await legal.json()).toEqual({
      error: "investor_access_required",
      reason_codes: ["complimentary_pass_required"],
    });

    const crossOrigin = await POST(new Request(
      "https://ghola.test/v1/private-account/hyperliquid/agent-wallet",
      {
        method: "POST",
        headers: {
          host: "ghola.test",
          origin: "https://attacker.test",
          "content-type": "application/json",
        },
        body: JSON.stringify(REQUEST_BODY),
      },
    ));
    expect(crossOrigin.status).toBe(403);
    expect(await crossOrigin.json()).toEqual({ error: "same_origin_json_required" });
  });

  it.each([
    ["hyperliquid_agent_signature_invalid", 400],
    ["hyperliquid_agent_authorization_stale", 400],
    ["hyperliquid_agent_authorization_state_unknown", 503],
  ])("does not mark %s retry-safe", async (code, status) => {
    mocks.verifyVenue.mockRejectedValueOnce(new mocks.AuthorizationError(code, status));
    const response = await POST(request());
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code });
  });

  it("revokes the stored vault only after exact-master, different-agent venue replacement", async () => {
    mocks.verifyVenue.mockResolvedValue({
      request: { ...REQUEST_BODY, encrypted_execution_vault: undefined },
      authorization: VERIFIED.authorization,
    });
    const response = await DELETE(request("DELETE"));
    expect(response.status).toBe(200);
    expect(mocks.revoke).toHaveBeenCalledWith(expect.anything(), {
      expectedVaultCommitment: "vault_automatic",
    });
    expect(await response.json()).toMatchObject({
      venue_authorization: { status: "replaced_with_discarded_key" },
    });
  });

  it("does not revoke local state when the recovered venue master differs", async () => {
    mocks.identityCommitments.mockReturnValue({
      venue_account_commitment: "hyperliquid_venue_account_other",
      agent_wallet_commitment: "hyperliquid_agent_wallet_replacement",
    });
    const response = await DELETE(request("DELETE"));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "hyperliquid_agent_revocation_binding_mismatch" });
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it("removes a legacy vault only after exact worker-proven venue absence", async () => {
    mocks.getVault.mockResolvedValueOnce(legacyVault());
    const response = await DELETE(request("DELETE", {}));
    expect(response.status).toBe(200);
    expect(mocks.verifyLegacyWorker).toHaveBeenCalledWith({
      accountCommitment: "account_test",
      encryptedExecutionVault: {
        alg: "sealed-provider-v1",
        ciphertext: "sealed-legacy",
        recipient: "attested:test",
        aad: "ghola/hyperliquid-execution-vault-v1|account:account_test|recipient:attested:test|network:mainnet",
      },
    });
    expect(mocks.verifyVenue).not.toHaveBeenCalled();
    expect(mocks.revoke).toHaveBeenCalledOnce();
    expect(await response.json()).toMatchObject({
      venue_authorization: {
        status: "verified_absent",
        verification_commitment: `hyperliquid_agent_legacy_removal_verification_${"e".repeat(48)}`,
      },
    });
  });

  it("never verifies or removes a vault outside the authenticated owner binding", async () => {
    mocks.getVault.mockResolvedValueOnce({ ...legacyVault(), owner_commitment: "owner_other" });
    const response = await DELETE(request("DELETE", {}));
    expect(response.status).toBe(404);
    expect(mocks.verifyLegacyWorker).not.toHaveBeenCalled();
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it("keeps legacy local state when the worker finds authority or cannot prove absence", async () => {
    for (const [code, status] of [
      ["legacy_hyperliquid_agent_still_authorized", 409],
      ["hyperliquid_agent_authorization_state_unknown", 503],
    ] as const) {
      mocks.getVault.mockResolvedValueOnce(legacyVault());
      mocks.verifyLegacyWorker.mockRejectedValueOnce(new mocks.AuthorizationError(code, status));
      const response = await DELETE(request("DELETE", {}));
      expect(response.status).toBe(status);
      const body = await response.json();
      expect(body.error).toBe(code);
      expect(body.retry_safe).toBeUndefined();
    }
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it("never revokes a replacement vault if local state changes after legacy proof", async () => {
    mocks.getVault.mockResolvedValueOnce(legacyVault());
    mocks.revoke.mockResolvedValueOnce({ error: "hyperliquid_execution_vault_state_changed" });
    const response = await DELETE(request("DELETE", {}));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "hyperliquid_execution_vault_state_changed" });
    expect(mocks.revoke).toHaveBeenCalledWith(expect.anything(), {
      expectedVaultCommitment: "vault_legacy",
    });
  });
});

function legacyVault() {
  return {
    owner_commitment: "owner_test",
    account_commitment: "account_test",
    vault_commitment: "vault_legacy",
    status: "sealed",
    vault: {
      authorization: null,
      encrypted_execution_vault: {
        alg: "sealed-provider-v1",
        ciphertext: "sealed-legacy",
        recipient: "attested:test",
        aad: "ghola/hyperliquid-execution-vault-v1|account:account_test|recipient:attested:test|network:mainnet",
        ciphertext_commitment: "not-forwarded",
      },
    },
  };
}

function request(method = "POST", body: unknown = REQUEST_BODY) {
  return new Request("https://ghola.test/v1/private-account/hyperliquid/agent-wallet", {
    method,
    headers: {
      host: "ghola.test",
      origin: "https://ghola.test",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
