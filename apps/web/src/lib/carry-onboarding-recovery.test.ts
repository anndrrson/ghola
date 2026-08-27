import { beforeEach, describe, expect, it } from "vitest";
import { keccak256 } from "viem";
import { buildAsterV3AgentOnboardingContract } from "./aster-agent-onboarding";
import { buildLighterChangePubKeyIntent } from "./lighter-agent-association";
import {
  clearCarryOnboardingRecovery,
  readCarryOnboardingRecovery,
  readCarryOnboardingRecoveryForUser,
  updateCarryOnboardingRecovery,
  updateCarryOnboardingRecoveryForUser,
  writeCarryOnboardingRecovery,
  type PendingAsterOnboarding,
  type PendingLighterOnboarding,
} from "./carry-onboarding-recovery";

const NOW = 1_800_000_000_000;
const ACCOUNT = "account_commitment_0001";
const USER_SCOPE = "ab".repeat(32);

beforeEach(() => localStorage.clear());

describe("Carry onboarding recovery", () => {
  it("restores the exact signed Lighter preparation after a reload", () => {
    const lighter = lighterPending();
    writeCarryOnboardingRecovery(localStorage, ACCOUNT, { lighter }, NOW);

    expect(readCarryOnboardingRecovery(localStorage, ACCOUNT, NOW + 1_000)?.lighter)
      .toEqual(lighter);
  });

  it("restores a prepared Lighter key before owner approval", () => {
    const lighter = { preparation: lighterPending().preparation };
    writeCarryOnboardingRecovery(localStorage, ACCOUNT, { lighter }, NOW);

    expect(readCarryOnboardingRecovery(localStorage, ACCOUNT, NOW + 1_000)?.lighter)
      .toEqual(lighter);
  });

  it("restores an externally broadcast Lighter transaction by hash only", () => {
    const lighter = {
      preparation: lighterPending().preparation,
      authorization: {
        external_broadcast: true as const,
        transaction_hash: `0x${"88".repeat(32)}` as const,
      },
    };
    writeCarryOnboardingRecovery(localStorage, ACCOUNT, { lighter }, NOW);

    expect(readCarryOnboardingRecovery(localStorage, ACCOUNT, NOW + 1_000)?.lighter)
      .toEqual(lighter);
  });

  it("keeps only sealed Aster material and its public authorization proof", () => {
    const aster = asterPending();
    writeCarryOnboardingRecovery(localStorage, ACCOUNT, { aster }, NOW);
    const raw = Array.from({ length: localStorage.length }, (_, index) =>
      localStorage.getItem(localStorage.key(index) || "") || "",
    ).join("");

    expect(raw).toContain("sealed-ciphertext");
    expect(raw).not.toContain("api_wallet_private_key");
    expect(readCarryOnboardingRecovery(localStorage, ACCOUNT, NOW)?.aster).toEqual(aster);
  });

  it("restores an unsigned Aster preparation without creating another signer", () => {
    const unsigned = { preparation: asterPending().preparation };
    updateCarryOnboardingRecoveryForUser(localStorage, USER_SCOPE, ACCOUNT, { aster: unsigned }, NOW);

    expect(readCarryOnboardingRecoveryForUser(localStorage, USER_SCOPE, NOW + 1_000)?.aster)
      .toEqual(unsigned);
  });

  it("does not restore another Ghola user's pending venue setup", () => {
    updateCarryOnboardingRecoveryForUser(localStorage, USER_SCOPE, ACCOUNT, {
      aster: { preparation: asterPending().preparation },
    }, NOW);

    expect(readCarryOnboardingRecoveryForUser(localStorage, "cd".repeat(32), NOW)).toBeNull();
  });

  it("quarantines malformed, cross-account, and stale recovery records", () => {
    const lighter = lighterPending();
    writeCarryOnboardingRecovery(localStorage, ACCOUNT, { lighter }, NOW);
    expect(readCarryOnboardingRecovery(localStorage, "account_commitment_0002", NOW)).toBeNull();
    expect(readCarryOnboardingRecovery(localStorage, ACCOUNT, NOW + 32 * 24 * 60 * 60 * 1_000)).toBeNull();
    writeCarryOnboardingRecovery(localStorage, ACCOUNT, { lighter }, NOW);
    clearCarryOnboardingRecovery(localStorage, ACCOUNT);
    expect(readCarryOnboardingRecovery(localStorage, ACCOUNT, NOW)).toBeNull();
  });

  it("rejects tampered account bindings and signed Lighter transaction hashes", () => {
    const lighter = lighterPending();
    if (!lighter.authorization || lighter.authorization.external_broadcast === true) throw new Error("test fixture invalid");
    const authorization = lighter.authorization;
    expect(() => writeCarryOnboardingRecovery(localStorage, ACCOUNT, {
      lighter: {
        ...lighter,
        preparation: { ...lighter.preparation, account_commitment: "account_commitment_0002" },
      },
    }, NOW)).toThrow("carry_onboarding_recovery_invalid");
    expect(() => writeCarryOnboardingRecovery(localStorage, ACCOUNT, {
      lighter: {
        ...lighter,
        authorization: { ...authorization, transaction_hash: `0x${"99".repeat(32)}` },
      },
    }, NOW)).toThrow("carry_onboarding_recovery_invalid");
  });

  it("clears one finished venue without losing the other pending venue", () => {
    writeCarryOnboardingRecovery(localStorage, ACCOUNT, {
      aster: asterPending(),
      lighter: lighterPending(),
    }, NOW);
    updateCarryOnboardingRecovery(localStorage, ACCOUNT, { aster: null }, NOW + 1);
    const recovered = readCarryOnboardingRecovery(localStorage, ACCOUNT, NOW + 1);
    expect(recovered?.aster).toBeUndefined();
    expect(recovered?.lighter).toEqual(lighterPending());
  });

  it("restores and clears a venue-account activation barrier", () => {
    const requirement = {
      owner_address: `0x${"77".repeat(20)}` as const,
      reason: "venue_account_not_found" as const,
    };
    updateCarryOnboardingRecoveryForUser(localStorage, USER_SCOPE, ACCOUNT, {
      lighterActivation: requirement,
    }, NOW);
    expect(readCarryOnboardingRecoveryForUser(localStorage, USER_SCOPE, NOW + 1)?.lighter_activation)
      .toEqual(requirement);
    updateCarryOnboardingRecoveryForUser(localStorage, USER_SCOPE, ACCOUNT, {
      lighterActivation: null,
    }, NOW + 2);
    expect(readCarryOnboardingRecoveryForUser(localStorage, USER_SCOPE, NOW + 2)).toBeNull();
  });
});

function lighterPending(): PendingLighterOnboarding {
  const intent = buildLighterChangePubKeyIntent({
    ownerAddress: `0x${"12".repeat(20)}`,
    accountIndex: 123,
    apiKeyIndex: 2,
    publicKey: `01${"00".repeat(39)}`,
  });
  const rawTransaction = `0x02${"34".repeat(96)}` as const;
  return {
    preparation: {
      version: 1,
      preparation_id: `lighter_prepare_${"11".repeat(32)}`,
      owner_commitment: "owner_commitment_0001",
      account_commitment: ACCOUNT,
      venue_id: "lighter",
      credential_provisioning_mode: "programmatic_generated",
      owner_approval_required: true,
      owner_association: { method: "ethereum_change_pub_key", status: "transaction_prepared", ethereum_gas_required: true },
      transaction_plan: {
        ...intent,
        nonce: "0x1",
        gas: "0x5208",
        max_fee_per_gas: "0x3b9aca00",
        max_priority_fee_per_gas: "0x3b9aca00",
        simulation: {
          performed: true,
          succeeded: true,
          chain_id_verified: true,
          exact_sender_verified: true,
          exact_contract_verified: true,
        },
      },
      encrypted_execution_vault: { ciphertext: "sealed-ciphertext" },
      attested_signer: {},
      authority_boundary: {},
      setup: { may_place_trade: false, transaction_signed: false, transaction_broadcast: false, credential_ready: false },
    },
    authorization: {
      raw_transaction: rawTransaction,
      transaction_hash: keccak256(rawTransaction),
    },
  };
}

function asterPending(): PendingAsterOnboarding {
  const expiresAtMs = NOW + 30 * 24 * 60 * 60 * 1_000;
  const contract = buildAsterV3AgentOnboardingContract({
    ownerAddress: `0x${"44".repeat(20)}`,
    agentName: "ghola-perps",
    attestedSigner: {
      publicAddress: `0x${"55".repeat(20)}`,
      provider: "phala",
      workerId: "worker-1",
      attestationSha256: `sha256:${"66".repeat(32)}`,
    },
    nonceMicros: NOW * 1_000,
    nowMs: NOW,
    expiresAtMs,
  });
  return {
    preparation: {
      version: 1,
      preparation_id: `aster_prepare_${"22".repeat(32)}`,
      account_commitment: ACCOUNT,
      venue_id: "aster",
      credential_provisioning_mode: "programmatic_generated",
      owner_approval_required: true,
      authorization_expires_at: new Date(expiresAtMs).toISOString(),
      contract,
      encrypted_execution_vault: { ciphertext: "sealed-ciphertext" },
      permissions: {},
      setup: { may_place_trade: false, transaction_broadcast: false, credential_registered: false },
    },
    signature: `0x${"33".repeat(65)}`,
  } as never;
}
