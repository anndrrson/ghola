import { describe, expect, it, vi } from "vitest";
import type { HyperliquidAgentAuthorizationRequest } from "./hyperliquid-agent-wallet";
import {
  HyperliquidAgentAuthorizationError,
  type VerifiedHyperliquidAgentAuthorization,
} from "./hyperliquid-agent-wallet.server";
import {
  verifyLegacyHyperliquidAgentRevokedWithWorker,
  verifyHyperliquidAgentVaultWithWorker,
  type HyperliquidAgentWalletWorkerDependencies,
} from "./hyperliquid-agent-wallet-worker.server";
import { hyperliquidVaultAssociatedData } from "./hyperliquid-vault-seal";
import { gholaCommitment } from "./private-account";

const NOW = 1_780_000_000_000;
const MASTER = `0x${"11".repeat(20)}` as `0x${string}`;
const AGENT = `0x${"22".repeat(20)}` as `0x${string}`;
const ACCOUNT = "private_account_worker_verification_test";
const RECIPIENT = "attested:worker-test";
const SHA = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const CONFIG = `live_trading_config_${"c".repeat(48)}`;
const VERIFIED = `hyperliquid_agent_onboarding_verification_${"d".repeat(48)}`;
const LEGACY_VERIFIED = `hyperliquid_agent_legacy_removal_verification_${"e".repeat(48)}`;

const legacyVault = {
  alg: "sealed-provider-v1",
  ciphertext: "sealed-legacy-ciphertext",
  recipient: RECIPIENT,
  aad: `ghola/hyperliquid-execution-vault-v1|account:${ACCOUNT}|recipient:${RECIPIENT}|network:mainnet`,
};

function request(): HyperliquidAgentAuthorizationRequest {
  return {
    version: 1,
    action: {
      type: "approveAgent",
      hyperliquidChain: "Mainnet",
      signatureChainId: "0x66eee",
      agentAddress: AGENT,
      agentName: `ghola-mainnet valid_until ${NOW + 24 * 60 * 60_000}`,
      nonce: NOW,
    },
    signature: {
      r: `0x${"33".repeat(32)}`,
      s: `0x${"44".repeat(32)}`,
      v: 27,
    },
    nonce: NOW,
    encrypted_execution_vault: {
      alg: "sealed-provider-v1",
      ciphertext: "sealed-ciphertext",
      recipient: RECIPIENT,
      aad: hyperliquidVaultAssociatedData({
        accountCommitment: ACCOUNT,
        recipientId: RECIPIENT,
        network: "mainnet",
        venueAccountAddress: MASTER,
        agentWalletAddress: AGENT,
      }),
    },
  };
}

const authorization: VerifiedHyperliquidAgentAuthorization = {
  account_address: MASTER,
  agent_address: AGENT,
  agent_base_name: "ghola-mainnet",
  valid_until_ms: NOW + 24 * 60 * 60_000,
  approve_nonce: NOW,
  recovered_existing_authorization: false,
};

function dependencyFixture(options: {
  response?: (body: Record<string, unknown>) => Response;
} = {}) {
  const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const expected = body.expected_authorization as Record<string, unknown>;
    return options.response?.(body) ?? Response.json({
      version: 1,
      proof_kind: "hyperliquid_agent_wallet_onboarding_verification_v1",
      status: "verified",
      network: "mainnet",
      account_commitment: ACCOUNT,
      vault_bundle_commitment: body.vault_bundle_commitment,
      recipient_commitment: gholaCommitment("sealed_recipient", RECIPIENT),
      venue_account_commitment: expected.venue_account_commitment,
      agent_wallet_commitment: expected.agent_wallet_commitment,
      agent_base_name: "ghola-mainnet",
      valid_until_ms: authorization.valid_until_ms,
      decrypted: true,
      derived_agent_address_verified: true,
      venue_authorization_verified: true,
      no_submit: true,
      checked_at: new Date(NOW).toISOString(),
      verification_commitment: VERIFIED,
      worker_release: {
        contract_version: 2,
        worker_git_sha: SHA,
        worker_image_digest: DIGEST,
        config_fingerprint: CONFIG,
      },
    });
  });
  const dependencies = {
    fetchImpl,
    env: {} as Record<string, string | undefined>,
    currentRelease: () => ({
      contract_version: 2,
      web_git_sha: SHA,
      worker_git_sha: SHA,
      worker_image_digest: DIGEST,
      config_fingerprint: CONFIG,
      valid: true,
      reason_codes: [],
    }),
    probeWorker: vi.fn(async () => ({
      ready: true,
      endpoint_configured: true,
      contract_version: 2,
      worker_git_sha: SHA,
      worker_image_digest: DIGEST,
      config_fingerprint: CONFIG,
      capabilities: ["limit_order" as const],
      reason_codes: [],
      checked_at: new Date(NOW).toISOString(),
    })),
    transportAllowed: () => true,
    workerConfig: () => ({ url: new URL("https://worker.invalid"), token: "test", authConfigured: true }),
    authorizationHeader: () => "Bearer test",
  } satisfies HyperliquidAgentWalletWorkerDependencies;
  return { dependencies, fetchImpl };
}

async function rejected(run: Promise<unknown>) {
  try {
    await run;
    throw new Error("expected rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(HyperliquidAgentAuthorizationError);
    return error as HyperliquidAgentAuthorizationError;
  }
}

describe("Hyperliquid agent-wallet worker verification", () => {
  it("requires an exact no-submit, release-pinned worker proof before acceptance", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const fixture = dependencyFixture();
    const result = await verifyHyperliquidAgentVaultWithWorker({
      request: request(),
      accountCommitment: ACCOUNT,
      authorization,
      dependencies: fixture.dependencies,
    });

    expect(result).toEqual({
      verification_commitment: VERIFIED,
      checked_at: new Date(NOW).toISOString(),
      worker_contract_version: 2,
      worker_git_sha: SHA,
      worker_image_digest: DIGEST,
      config_fingerprint: CONFIG,
    });
    const [, init] = fixture.fetchImpl.mock.calls[0]!;
    expect(new Headers(init?.headers)).toMatchObject(expect.any(Headers));
    expect(new Headers(init?.headers).get("x-ghola-no-submit-verify")).toBe("true");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      operation_class: "agent_wallet_onboarding_verify",
      encrypted_execution_vault: request().encrypted_execution_vault,
    });
  });

  it("requires every configured canary capability before reporting the vault ready", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const fixture = dependencyFixture();
    fixture.dependencies.env.GHOLA_LIVE_TRADING_PUBLIC_CAPABILITIES =
      "limit_order,cancel,reduce_only,stop_loss,take_profit";
    await verifyHyperliquidAgentVaultWithWorker({
      request: request(),
      accountCommitment: ACCOUNT,
      authorization,
      dependencies: fixture.dependencies,
    });
    expect(fixture.dependencies.probeWorker).toHaveBeenCalledWith(expect.objectContaining({
      requiredCapabilities: ["limit_order", "cancel", "reduce_only", "stop_loss", "take_profit"],
    }));
  });

  it("rejects a mismatched AAD before readiness or worker calls", async () => {
    const fixture = dependencyFixture();
    const mismatched = request();
    mismatched.encrypted_execution_vault.aad = mismatched.encrypted_execution_vault.aad.replace(
      /agent-wallet:[^|]+/,
      `agent-wallet:hyperliquid_agent_wallet_${"0".repeat(48)}`,
    );
    const error = await rejected(verifyHyperliquidAgentVaultWithWorker({
      request: mismatched,
      accountCommitment: ACCOUNT,
      authorization,
      dependencies: fixture.dependencies,
    }));
    expect(error).toMatchObject({ code: "hyperliquid_agent_vault_binding_mismatch", status: 400 });
    expect(fixture.dependencies.probeWorker).not.toHaveBeenCalled();
    expect(fixture.fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    "hyperliquid_agent_vault_unreadable",
    "hyperliquid_agent_vault_recipient_mismatch",
    "hyperliquid_agent_vault_identity_mismatch",
  ])("preserves deterministic worker failure %s", async (code) => {
    const fixture = dependencyFixture({
      response: () => Response.json({ error_code: code }, { status: 409 }),
    });
    const error = await rejected(verifyHyperliquidAgentVaultWithWorker({
      request: request(),
      accountCommitment: ACCOUNT,
      authorization,
      dependencies: fixture.dependencies,
    }));
    expect(error).toMatchObject({ code, status: 409 });
  });

  it("treats malformed or recipient-unbound success as retry-safe unknown", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const fixture = dependencyFixture({
      response: (body) => Response.json({
        version: 1,
        proof_kind: "hyperliquid_agent_wallet_onboarding_verification_v1",
        status: "verified",
        account_commitment: ACCOUNT,
        vault_bundle_commitment: body.vault_bundle_commitment,
        recipient_commitment: "sealed_recipient_wrong",
      }),
    });
    const error = await rejected(verifyHyperliquidAgentVaultWithWorker({
      request: request(),
      accountCommitment: ACCOUNT,
      authorization,
      dependencies: fixture.dependencies,
    }));
    expect(error).toMatchObject({
      code: "hyperliquid_agent_vault_worker_verification_unknown",
      status: 503,
    });
  });
});

describe("Hyperliquid legacy-agent removal worker verification", () => {
  it("accepts only an exact release-pinned, no-submit absence proof", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const fixture = dependencyFixture({
      response: (body) => Response.json({
        version: 1,
        proof_kind: "hyperliquid_legacy_agent_revocation_verification_v1",
        status: "revoked",
        network: "mainnet",
        account_commitment: ACCOUNT,
        vault_bundle_commitment: body.vault_bundle_commitment,
        recipient_commitment: gholaCommitment("sealed_recipient", RECIPIENT),
        venue_account_commitment: `hyperliquid_venue_account_${"1".repeat(48)}`,
        agent_wallet_commitment: `hyperliquid_agent_wallet_${"2".repeat(48)}`,
        decrypted: true,
        derived_agent_address_verified: true,
        venue_authorization_absent: true,
        no_submit: true,
        checked_at: new Date(NOW).toISOString(),
        verification_commitment: LEGACY_VERIFIED,
        worker_release: {
          contract_version: 2,
          worker_git_sha: SHA,
          worker_image_digest: DIGEST,
          config_fingerprint: CONFIG,
        },
      }),
    });
    await expect(verifyLegacyHyperliquidAgentRevokedWithWorker({
      accountCommitment: ACCOUNT,
      encryptedExecutionVault: legacyVault,
      dependencies: fixture.dependencies,
    })).resolves.toEqual({
      verification_commitment: LEGACY_VERIFIED,
      checked_at: new Date(NOW).toISOString(),
    });
    const [, init] = fixture.fetchImpl.mock.calls[0]!;
    expect(new Headers(init?.headers).get("x-ghola-no-submit-verify")).toBe("true");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      operation_class: "agent_wallet_legacy_revocation_verify",
      encrypted_execution_vault: legacyVault,
    });
  });

  it("preserves authoritative still-authorized and unknown results", async () => {
    for (const [status, code] of [
      [409, "legacy_hyperliquid_agent_still_authorized"],
      [503, "hyperliquid_agent_authorization_state_unknown"],
    ] as const) {
      const fixture = dependencyFixture({
        response: () => Response.json({ error_code: code }, { status }),
      });
      const error = await rejected(verifyLegacyHyperliquidAgentRevokedWithWorker({
        accountCommitment: ACCOUNT,
        encryptedExecutionVault: legacyVault,
        dependencies: fixture.dependencies,
      }));
      expect(error).toMatchObject({ code, status });
    }
  });

  it("rejects non-legacy or cross-account ciphertext before calling the worker", async () => {
    const fixture = dependencyFixture();
    const error = await rejected(verifyLegacyHyperliquidAgentRevokedWithWorker({
      accountCommitment: "account_other",
      encryptedExecutionVault: legacyVault,
      dependencies: fixture.dependencies,
    }));
    expect(error).toMatchObject({ code: "hyperliquid_agent_vault_identity_mismatch", status: 409 });
    expect(fixture.fetchImpl).not.toHaveBeenCalled();
  });
});
