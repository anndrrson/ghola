import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalLiveTradingCaps, type LiveTradingReleaseIdentity } from "./live-trading-contract";
import type { GholaHyperliquidExecutionVault } from "./private-account";
import type { PrivateHyperliquidVaultRecordV1 } from "./private-account-store";
import {
  inspectLiveTradingOpeningAccess,
  paidLiveTradingEntitlement,
  type LiveTradingOpeningAccessDependencies,
} from "./live-trading-opening-access.server";

const OWNER = "owner_canary_test";
const ACCOUNT = "account_canary_test";
const VAULT = "vault_canary_test";
const SHA = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const RELEASE: LiveTradingReleaseIdentity = {
  contract_version: 2,
  web_git_sha: SHA,
  worker_git_sha: SHA,
  worker_image_digest: DIGEST,
  config_fingerprint: "live_trading_config_canary_test",
  valid: true,
  reason_codes: [],
};
const ENV = {
  GHOLA_LIVE_TRADING_PUBLIC_CAPABILITIES: "limit_order,cancel,reduce_only",
};

describe("account-scoped live-trading opening access", () => {
  beforeEach(() => vi.clearAllMocks());

  it("authorizes only the exact graduated owner during canary", async () => {
    const dependencies = readyDependencies();
    const result = await inspect(dependencies);

    expect(result).toMatchObject({
      ready: true,
      access_mode: "account_canary",
      launch_state: "canary",
      account_commitment: ACCOUNT,
      vault_commitment: VAULT,
      authorized_capabilities: ["limit_order"],
      reason_codes: [],
    });
    expect(dependencies.probeWorker).toHaveBeenCalledWith(expect.objectContaining({
      requiredCapabilities: ["limit_order", "cancel", "reduce_only"],
      expectedRelease: RELEASE,
    }));
    expect(dependencies.getGraduation).toHaveBeenCalledWith({
      owner_commitment: OWNER,
      account_commitment: ACCOUNT,
      vault_commitment: VAULT,
      release: RELEASE,
    });
    expect(dependencies.entitlement).toHaveBeenCalledWith(
      "session-token",
      expect.any(Function),
      ENV,
      {
        requireComplimentaryPass: true,
        requiredFilledNotionalMicroUsd: undefined,
      },
    );
    expect(dependencies.evaluateCapability).not.toHaveBeenCalled();

    const unrelated = await inspect(dependencies, "owner_not_graduated");
    expect(unrelated).toMatchObject({
      ready: false,
      access_mode: null,
      reason_codes: ["private_account_required"],
    });
    expect(dependencies.getGraduation).toHaveBeenCalledTimes(1);
  });

  it("fails closed for missing exact-release graduation or active trading allowance", async () => {
    const noGraduation = readyDependencies({ getGraduation: vi.fn(async () => null) });
    await expect(inspect(noGraduation)).resolves.toMatchObject({
      ready: false,
      graduation_ready: false,
      denial: { ok: false, error: "funded_account_proof_required", status: 409 },
    });

    const noAllowance = readyDependencies({
      entitlement: vi.fn(async () => ({
        ok: false as const,
        error: "private_agent_trading_entitlement_required",
        status: 402,
        reason_codes: ["private_agent_trading_entitlement_required"],
      })),
    });
    await expect(inspect(noAllowance)).resolves.toMatchObject({
      ready: false,
      entitlement_ready: false,
      denial: { ok: false, error: "private_agent_trading_entitlement_required", status: 402 },
    });
  });

  it("never authorizes a testnet sealed vault for mainnet opening orders", async () => {
    const dependencies = readyDependencies();
    vi.mocked(dependencies.getVault).mockResolvedValue(vaultRecord(
      `ghola/hyperliquid-execution-vault-v1|account:${ACCOUNT}|recipient:recipient_test|network:testnet`,
    ));
    await expect(inspect(dependencies)).resolves.toMatchObject({
      ready: false,
      denial: { error: "hyperliquid_mainnet_vault_required", status: 409 },
    });
    expect(dependencies.probeWorker).not.toHaveBeenCalled();
    expect(dependencies.entitlement).not.toHaveBeenCalled();
  });

  it("never authorizes a vault whose AAD belongs to a different account", async () => {
    const dependencies = readyDependencies();
    vi.mocked(dependencies.getVault).mockResolvedValue(vaultRecord(
      "ghola/hyperliquid-execution-vault-v1|account:account_other|recipient:recipient_test|network:mainnet",
    ));

    await expect(inspect(dependencies)).resolves.toMatchObject({
      ready: false,
      denial: { error: "hyperliquid_mainnet_vault_required", status: 409 },
    });
    expect(dependencies.probeWorker).not.toHaveBeenCalled();
    expect(dependencies.entitlement).not.toHaveBeenCalled();
  });

  it("never trusts a vault record stored under a different account", async () => {
    const dependencies = readyDependencies();
    vi.mocked(dependencies.getVault).mockResolvedValue({
      ...vaultRecord(
        `ghola/hyperliquid-execution-vault-v1|account:${ACCOUNT}|recipient:recipient_test|network:mainnet`,
      ),
      account_commitment: "account_other",
    });

    await expect(inspect(dependencies)).resolves.toMatchObject({
      ready: false,
      denial: { error: "sealed_hyperliquid_vault_required", status: 409 },
    });
    expect(dependencies.probeWorker).not.toHaveBeenCalled();
    expect(dependencies.entitlement).not.toHaveBeenCalled();
  });

  it("requires an automatic API-wallet authorization with more than five minutes remaining", async () => {
    const legacy = readyDependencies({
      getVault: vi.fn(async () => vaultRecord(
        `ghola/hyperliquid-execution-vault-v1|account:${ACCOUNT}|recipient:recipient_test|network:mainnet`,
      )),
    });
    await expect(inspect(legacy)).resolves.toMatchObject({
      ready: false,
      denial: { error: "hyperliquid_agent_authorization_required", status: 409 },
    });
    expect(legacy.probeWorker).not.toHaveBeenCalled();

    const dependencies = readyDependencies();
    const venueCommitment = `hyperliquid_venue_account_${"a".repeat(48)}`;
    const agentCommitment = `hyperliquid_agent_wallet_${"b".repeat(48)}`;
    const automatic = vaultRecord(
      `ghola/hyperliquid-execution-vault-v2|account:${ACCOUNT}|recipient:recipient_test|network:mainnet|venue-account:${venueCommitment}|agent-wallet:${agentCommitment}`,
    );
    automatic.vault.authorization = {
      version: 1,
      source: "phantom_approve_agent_v1",
      network: "mainnet",
      agent_name: "ghola-mainnet",
      venue_account_commitment: venueCommitment,
      agent_wallet_commitment: agentCommitment,
      valid_until: new Date(Date.now() + 5 * 60 * 1_000).toISOString(),
      approve_nonce: Date.now(),
      verified_at: new Date().toISOString(),
      worker_verification_commitment: `hyperliquid_agent_onboarding_verification_${"c".repeat(48)}`,
      worker_verified_at: new Date().toISOString(),
      worker_contract_version: RELEASE.contract_version,
      worker_git_sha: SHA,
      worker_image_digest: DIGEST,
      worker_config_fingerprint: RELEASE.config_fingerprint,
    };
    vi.mocked(dependencies.getVault).mockResolvedValue(automatic);

    await expect(inspect(dependencies)).resolves.toMatchObject({
      ready: false,
      denial: { error: "hyperliquid_agent_authorization_required", status: 409 },
    });
    expect(dependencies.probeWorker).not.toHaveBeenCalled();
  });

  it("never turns killed, drifted, or under-capable canaries into opening authority", async () => {
    const killed = readyDependencies({ getLaunch: vi.fn(async () => launch("killed")) });
    await expect(inspect(killed)).resolves.toMatchObject({
      ready: false,
      denial: { error: "live_trading_gate_closed", status: 503 },
      reason_codes: expect.arrayContaining(["live_trading_killed"]),
    });

    const drifted = readyDependencies({
      getLaunch: vi.fn(async () => ({ ...launch("canary"), worker_image_digest: `sha256:${"c".repeat(64)}` })),
    });
    await expect(inspect(drifted)).resolves.toMatchObject({
      ready: false,
      reason_codes: expect.arrayContaining(["launch_release_binding_mismatch"]),
    });

    const missingCapability = readyDependencies({
      probeWorker: vi.fn(async () => worker(false, ["worker_capability_missing:reduce_only"])),
    });
    await expect(inspect(missingCapability)).resolves.toMatchObject({
      ready: false,
      reason_codes: expect.arrayContaining(["worker_capability_missing:reduce_only"]),
    });
  });

  it("preserves the public path and still requires promoted capability evidence", async () => {
    const publicReady = readyDependencies({
      getLaunch: vi.fn(async () => launch("public")),
      getVault: vi.fn(async () => vaultRecord(
        `ghola/hyperliquid-execution-vault-v1|account:${ACCOUNT}|recipient:recipient_test|network:mainnet`,
      )),
    });
    await expect(inspect(publicReady)).resolves.toMatchObject({ ready: true, access_mode: "public" });
    expect(publicReady.evaluateCapability).toHaveBeenCalledOnce();

    const publicUnproven = readyDependencies({
      getLaunch: vi.fn(async () => launch("public")),
      evaluateCapability: vi.fn(async () => ({
        id: "limit_order" as const,
        state: "verifying" as const,
        visible: false,
        consecutive_mainnet_proofs: 2,
        required_mainnet_proofs: 3,
        last_proven_at: null,
        reason_codes: ["capability_mainnet_proofs_incomplete"],
      })),
    });
    await expect(inspect(publicUnproven)).resolves.toMatchObject({
      ready: false,
      reason_codes: expect.arrayContaining(["capability_mainnet_proofs_incomplete"]),
    });
  });
});

describe("server-side investor entitlement", () => {
  it("enforces expiry, compute, active-agent, notional, and no-overage floors", async () => {
    await expect(entitlement(activeBilling())).resolves.toEqual({ ok: true });
    await expect(entitlement(activeBilling({ access_state: undefined }))).resolves.toMatchObject({
      ok: false,
      error: "access_state_required",
      status: 402,
    });
    await expect(entitlement(activeBilling({
      access_state: "expired",
      tier: "free",
      access_source: "free",
      expires_at: null,
      last_access_expires_at: new Date(Date.now() - 60_000).toISOString(),
    }))).resolves.toMatchObject({ ok: false, error: "access_expired", status: 402 });
    await expect(entitlement(activeBilling({
      private_agent_compute: { ...activeBilling().private_agent_compute!, remaining_seconds: 599 },
    }))).resolves.toMatchObject({ ok: false, error: "compute_allowance_exhausted", status: 402 });
    await expect(entitlement(activeBilling({
      private_agent_compute: { ...activeBilling().private_agent_compute!, active_agent_count: 1 },
    }))).resolves.toMatchObject({ ok: false, error: "active_agent_limit_reached", status: 402 });
    await expect(entitlement(activeBilling({
      private_agent_trading: {
        ...activeBilling().private_agent_trading!,
        remaining_included_notional_micro_usd: 21_999_999,
      },
    }))).resolves.toMatchObject({ ok: false, error: "trading_allowance_exhausted", status: 402 });
    await expect(entitlement(activeBilling({
      private_agent_trading: { ...activeBilling().private_agent_trading!, overage_fee_bps: 3 },
    }))).resolves.toMatchObject({ ok: false, error: "complimentary_overage_enabled", status: 402 });
    await expect(entitlement(activeBilling({
      private_agent_compute: { ...activeBilling().private_agent_compute!, remaining_seconds: undefined },
    }))).resolves.toMatchObject({ ok: false, error: "compute_allowance_required", status: 402 });
    await expect(entitlement(activeBilling({
      private_agent_compute: { ...activeBilling().private_agent_compute!, active_agent_limit: 0 },
    }))).resolves.toMatchObject({ ok: false, error: "compute_allowance_required", status: 402 });
    await expect(entitlement(activeBilling({
      private_agent_trading: {
        ...activeBilling().private_agent_trading!,
        remaining_included_notional_micro_usd: undefined,
      },
    }))).resolves.toMatchObject({ ok: false, error: "trading_allowance_required", status: 402 });
    await expect(entitlement(activeBilling({
      private_agent_trading: {
        ...activeBilling().private_agent_trading!,
        cap_reached: true,
        live_trading_allowed: true,
      },
    }))).resolves.toMatchObject({ ok: false, error: "trading_allowance_exhausted", status: 402 });
    await expect(entitlement(activeBilling({
      private_agent_trading: {
        ...activeBilling().private_agent_trading!,
        period_end: new Date(Date.now()).toISOString(),
      },
    }))).resolves.toMatchObject({ ok: false, error: "billing_period_invalid", status: 402 });
  });

  it("requires an email-bound pass in canary but preserves paid public access", async () => {
    const paid = activeBilling({
      access_source: "stripe",
      expires_at: null,
      last_access_expires_at: null,
      private_agent_trading: {
        ...activeBilling().private_agent_trading!,
        remaining_included_notional_micro_usd: 0,
        overage_fee_bps: 3,
      },
    });
    await expect(entitlement(paid, {
      requireComplimentaryPass: true,
    })).resolves.toMatchObject({ ok: false, error: "investor_invite_required", status: 402 });
    await expect(entitlement(paid, {
      requiredFilledNotionalMicroUsd: 0,
    })).resolves.toEqual({ ok: true });
  });
});

function inspect(dependencies: LiveTradingOpeningAccessDependencies, owner = OWNER) {
  return inspectLiveTradingOpeningAccess({
    owner_commitment: owner,
    web_session_token: "session-token",
    required_capabilities: ["limit_order"],
    env: ENV,
    fetchImpl: vi.fn() as unknown as typeof fetch,
    dependencies,
  });
}

function entitlement(
  body: Record<string, unknown>,
  requirements: Parameters<typeof paidLiveTradingEntitlement>[3] = {},
) {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })) as unknown as typeof fetch;
  return paidLiveTradingEntitlement("session-token", fetchImpl, {
    NEXT_PUBLIC_THUMPER_API_URL: "https://billing.example",
  }, requirements);
}

function activeBilling(overrides: Record<string, unknown> = {}) {
  const past = new Date(Date.now() - 60 * 60 * 1_000).toISOString();
  const future = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
  return {
    tier: "starter",
    access_source: "complimentary_pass",
    access_state: "active",
    expires_at: future,
    last_access_expires_at: future,
    stripe_customer_id: null,
    limits: {
      calls_per_month: 20,
      emails_per_month: 30,
      private_compute_seconds: 72_000,
      active_private_agents: 1,
    },
    private_agent_compute: {
      included_seconds: 72_000,
      reserved_seconds: 0,
      used_seconds: 0,
      remaining_seconds: 3_600,
      active_agent_limit: 1,
      active_agent_count: 0,
      period_start: past,
      period_end: future,
      metering_unit: "agent_second",
    },
    private_agent_trading: {
      included_notional_micro_usd: 100_000_000,
      filled_notional_micro_usd: 0,
      remaining_included_notional_micro_usd: 100_000_000,
      overage_notional_micro_usd: 0,
      overage_fee_bps: 0,
      accrued_fee_micro_usd: 0,
      queued_fee_cents: 0,
      invoiced_fee_cents: 0,
      monthly_fee_cap_micro_usd: 0,
      cap_reached: false,
      live_trading_allowed: true,
      period_start: past,
      period_end: future,
      metering_unit: "filled_notional_micro_usd",
      billing_state: "current",
    },
    ...overrides,
  };
}

function readyDependencies(
  overrides: Partial<Record<keyof LiveTradingOpeningAccessDependencies, unknown>> = {},
) {
  return {
    currentRelease: vi.fn(() => RELEASE),
    getAccount: vi.fn(async (owner: string) => owner === OWNER ? { account_commitment: ACCOUNT } : null),
    getVault: vi.fn(async () => automaticVaultRecord()),
    getEligibility: vi.fn(async () => ({
      owner_commitment: OWNER,
      status: "verified",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      credential: {
        credential_type: "self_attested_eligible_user",
        eligibility_basis: "self_attested_non_us",
        eligible_non_us: true,
        terms_version: "2026-08-14",
        risk_disclosure_version: "2026-08-14",
        accepted_at: new Date().toISOString(),
      },
    })),
    getGraduation: vi.fn(async () => graduation()),
    getLaunch: vi.fn(async () => launch("canary")),
    evaluateCapability: vi.fn(async () => ({
      id: "limit_order" as const,
      state: "live" as const,
      visible: true,
      consecutive_mainnet_proofs: 3,
      required_mainnet_proofs: 3,
      last_proven_at: new Date().toISOString(),
      reason_codes: [],
    })),
    probeWorker: vi.fn(async () => worker(true)),
    entitlement: vi.fn(async () => ({ ok: true as const })),
    ...overrides,
  } as unknown as LiveTradingOpeningAccessDependencies;
}

function encryptedBundle(aad: string) {
  return {
    version: 1 as const,
    alg: "hpke-x25519-aes256gcm" as const,
    ciphertext: "ciphertext_test",
    ciphertext_commitment: "ciphertext_commitment_test",
    recipient: "recipient_test",
    recipient_commitment: "recipient_commitment_test",
    aad,
    aad_commitment: "aad_commitment_test",
    encapsulated_key_commitment: "encapsulated_key_commitment_test",
  };
}

function executionVault(aad: string): GholaHyperliquidExecutionVault {
  const now = new Date().toISOString();
  return {
    version: 1 as const,
    platform_class: "hyperliquid_style_market" as const,
    account_commitment: ACCOUNT,
    vault_commitment: VAULT,
    encrypted_vault_commitment: "encrypted_vault_commitment_test",
    recipient_commitment: "recipient_commitment_test",
    policy_commitment: "policy_commitment_test",
    encrypted_execution_vault: encryptedBundle(aad),
    supported_operations: ["read", "limit_order", "cancel", "reconcile"],
    blocked_operations: ["withdraw", "vault_transfer", "leverage_escalation"],
    status: "sealed" as const,
    created_at: now,
    updated_at: now,
  };
}

function vaultRecord(aad: string): PrivateHyperliquidVaultRecordV1 {
  const vault = executionVault(aad);
  return {
    version: 1,
    owner_commitment: OWNER,
    account_commitment: ACCOUNT,
    vault_commitment: VAULT,
    encrypted_vault_commitment: vault.encrypted_vault_commitment,
    recipient_commitment: vault.recipient_commitment,
    policy_commitment: vault.policy_commitment,
    status: "sealed",
    vault,
    created_at: vault.created_at,
    updated_at: vault.updated_at,
  };
}

function automaticVaultRecord(): PrivateHyperliquidVaultRecordV1 {
  const venueCommitment = `hyperliquid_venue_account_${"a".repeat(48)}`;
  const agentCommitment = `hyperliquid_agent_wallet_${"b".repeat(48)}`;
  const record = vaultRecord(
    `ghola/hyperliquid-execution-vault-v2|account:${ACCOUNT}|recipient:recipient_test|network:mainnet|venue-account:${venueCommitment}|agent-wallet:${agentCommitment}`,
  );
  record.vault.authorization = {
    version: 1,
    source: "phantom_approve_agent_v1",
    network: "mainnet",
    agent_name: "ghola-mainnet",
    venue_account_commitment: venueCommitment,
    agent_wallet_commitment: agentCommitment,
    valid_until: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
    approve_nonce: Date.now(),
    verified_at: new Date().toISOString(),
    worker_verification_commitment: `hyperliquid_agent_onboarding_verification_${"c".repeat(48)}`,
    worker_verified_at: new Date().toISOString(),
    worker_contract_version: RELEASE.contract_version,
    worker_git_sha: SHA,
    worker_image_digest: DIGEST,
    worker_config_fingerprint: RELEASE.config_fingerprint,
  };
  return record;
}

function launch(state: "canary" | "public" | "killed") {
  const now = new Date().toISOString();
  return {
    version: 2 as const,
    state,
    contract_version: 2 as const,
    web_git_sha: SHA,
    worker_git_sha: SHA,
    worker_image_digest: DIGEST,
    config_fingerprint: RELEASE.config_fingerprint,
    public_capabilities: ["limit_order", "cancel", "reduce_only"] as const,
    caps: canonicalLiveTradingCaps(),
    evidence_commitment: "launch_evidence_canary_test",
    updated_by: "test-operator",
    created_at: now,
    updated_at: now,
  };
}

function graduation() {
  const now = new Date().toISOString();
  return {
    version: 3 as const,
    contract_version: 2 as const,
    graduation_id: "graduation_canary_test",
    owner_commitment: OWNER,
    account_commitment: ACCOUNT,
    vault_commitment: VAULT,
    web_git_sha: SHA,
    worker_git_sha: SHA,
    worker_image_digest: DIGEST,
    config_fingerprint: RELEASE.config_fingerprint,
    proof_evidence_commitment: "proof_canary_test",
    proof_notional_usd: 11,
    status: "active" as const,
    completed_at: now,
    revoked_at: null,
    created_at: now,
    updated_at: now,
  };
}

function worker(ready: boolean, reasonCodes: string[] = []) {
  return {
    ready,
    endpoint_configured: true,
    contract_version: 2,
    worker_git_sha: SHA,
    worker_image_digest: DIGEST,
    config_fingerprint: RELEASE.config_fingerprint,
    capabilities: ["limit_order", "cancel", "reduce_only"] as const,
    reason_codes: reasonCodes,
    checked_at: new Date().toISOString(),
  };
}
