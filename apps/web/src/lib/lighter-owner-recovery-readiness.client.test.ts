import { describe, expect, it, vi } from "vitest";
import {
  buildLighterOwnerRecoveryIntent,
  lighterOwnerRecoveryPlanCommitment,
  lighterOwnerRecoveryReadinessMessage,
} from "./lighter-owner-recovery";
import { verifyLighterOwnerRecoveryReadiness } from "./lighter-owner-recovery-readiness.client";

const NOW = Date.parse("2026-08-31T18:00:00.000Z");
const OWNER = "0x1111111111111111111111111111111111111111";
const ACCOUNT_INDEX = 123;
const SIGNATURE = `0x${"11".repeat(65)}` as `0x${string}`;

describe("Lighter owner recovery readiness client", () => {
  it("runs exactly two phases around the exact Turnkey owner message", async () => {
    const first = phaseOne();
    const second = phaseTwo();
    const requestPhase = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const signLighterRecoveryReadiness = vi.fn(async () => signingProof());

    await expect(verifyLighterOwnerRecoveryReadiness({
      ownerAddress: OWNER,
      signLighterRecoveryReadiness,
      requestPhase,
      nowMs: NOW,
    })).resolves.toMatchObject({
      status: "post_account_recovery_ready",
      owner_address: OWNER,
      account_index: ACCOUNT_INDEX,
      ready: true,
      funding_precondition_satisfied: false,
      initial_funding_safety_proven: false,
      funding_authorized: false,
      checks: {
        owner_signer_verified: true,
        lighter_balance_verified: false,
        withdrawal_execution_verified: false,
      },
      safety: {
        transaction_signed: false,
        transaction_broadcast: false,
        funds_moved: false,
      },
    });
    expect(requestPhase).toHaveBeenNthCalledWith(1, {
      version: 1,
      owner_address: OWNER,
    });
    expect(signLighterRecoveryReadiness).toHaveBeenCalledWith(first.challenge);
    expect(requestPhase).toHaveBeenNthCalledWith(2, {
      version: 1,
      owner_address: OWNER,
      account_index: ACCOUNT_INDEX,
      challenge_token: first.challenge.challenge_token,
      owner_signature: SIGNATURE,
    });
    expect(requestPhase).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["message", (value: ReturnType<typeof phaseOne>) => ({
      ...value,
      challenge: { ...value.challenge, message: `${value.challenge.message}\nBroadcast: yes` },
    })],
    ["funds-moved flag", (value: ReturnType<typeof phaseOne>) => ({
      ...value,
      safety: { ...value.safety, funds_moved: true },
    })],
    ["balance claim", (value: ReturnType<typeof phaseOne>) => ({
      ...value,
      checks: { ...value.checks, lighter_balance_verified: true },
    })],
    ["initial-funding claim", (value: ReturnType<typeof phaseOne>) => ({
      ...value,
      funding_precondition_satisfied: true,
    })],
  ])("does not sign a phase-one proof with a changed %s", async (_label, mutate) => {
    const requestPhase = vi.fn(async () => mutate(phaseOne()));
    const signLighterRecoveryReadiness = vi.fn(async () => signingProof());

    await expect(verifyLighterOwnerRecoveryReadiness({
      ownerAddress: OWNER,
      signLighterRecoveryReadiness,
      requestPhase,
      nowMs: NOW,
    })).rejects.toThrow("readiness proof is invalid");
    expect(signLighterRecoveryReadiness).not.toHaveBeenCalled();
    expect(requestPhase).toHaveBeenCalledTimes(1);
  });

  it("does not start phase two when the signer claims a transaction was signed", async () => {
    const requestPhase = vi.fn(async () => phaseOne());

    await expect(verifyLighterOwnerRecoveryReadiness({
      ownerAddress: OWNER,
      signLighterRecoveryReadiness: async () => ({
        ...signingProof(),
        transaction_signed: true as never,
      }),
      requestPhase,
      nowMs: NOW,
    })).rejects.toThrow("readiness proof is invalid");
    expect(requestPhase).toHaveBeenCalledTimes(1);
  });

  it("rejects a changed phase-two proof without retrying", async () => {
    const requestPhase = vi.fn()
      .mockResolvedValueOnce(phaseOne())
      .mockResolvedValueOnce({
        ...phaseTwo(),
        safety: { ...phaseTwo().safety, transaction_broadcast: true },
      });

    await expect(verifyLighterOwnerRecoveryReadiness({
      ownerAddress: OWNER,
      signLighterRecoveryReadiness: async () => signingProof(),
      requestPhase,
      nowMs: NOW,
    })).rejects.toThrow("readiness proof is invalid");
    expect(requestPhase).toHaveBeenCalledTimes(2);
  });
});

function phaseOne() {
  const base = common(false);
  return {
    ...base,
    status: "owner_signature_required",
    headline: "Confirm owner recovery readiness",
    summary: "All no-submit recovery checks passed.",
    next_step: "Sign the exact readiness message with the Ghola Turnkey owner.",
    ready: false,
    recovery_readiness_proven: false,
    post_account_recovery_ready: false,
    blocking_reasons: ["turnkey_owner_signature_required"],
    challenge: authorization(),
  };
}

function phaseTwo() {
  return {
    ...common(true),
    status: "post_account_recovery_ready",
    headline: "Post-account recovery capability is ready",
    summary: "Verified without submitting anything.",
    next_step: "Treat this only as post-account recovery capability.",
    ready: true,
    recovery_readiness_proven: true,
    post_account_recovery_ready: true,
    blocking_reasons: [],
  };
}

function common(ownerSignerVerified: boolean) {
  const plan = buildLighterOwnerRecoveryIntent({ ownerAddress: OWNER, accountIndex: ACCOUNT_INDEX });
  return {
    version: 1,
    venue_id: "lighter",
    network: "mainnet",
    operation: "owner_recovery_readiness",
    proof_scope: "post_account_recovery_capability_not_initial_funding_or_withdrawal_availability",
    applicability: {
      stage: "post_lighter_account_activation",
      brand_new_account_supported: false,
      pre_uda_funding_gate: false,
      initial_funding_safety_proven: false,
    },
    recovery_plan: {
      ...plan,
      plan_commitment: lighterOwnerRecoveryPlanCommitment(plan),
      simulation: {
        performed: true,
        succeeded: true,
        exact_sender_verified: true,
        exact_contract_verified: true,
        exact_calldata_verified: true,
        proves_contract_acceptance_only: true,
        proves_l2_balance: false,
        proves_withdrawal_execution: false,
      },
    },
    checks: {
      authenticated_session: true,
      owner_signer_verified: ownerSignerVerified,
      owner_account_binding_verified: true,
      contract_identity_verified: true,
      asset_identity_verified: true,
      exact_calldata_simulated: true,
      gas_ready: true,
      zero_redirect_verified: true,
      lighter_balance_verified: false,
      withdrawal_execution_verified: false,
    },
    owner_signer: {
      method: "turnkey_eip191_owner_proof",
      owner_address: OWNER,
      verified: ownerSignerVerified,
      transaction_signed: false,
    },
    gas: {
      ready: true,
      nonce: "0x7",
      gas: "0x5208",
      max_fee_per_gas: "0x3b9aca00",
      max_priority_fee_per_gas: "0x1",
      owner_balance_wei: "1000000000000000000",
      required_wei: "21000000000000",
    },
    withdrawal_delay_seconds: 1125,
    pending_base_amount: "0",
    safety: {
      no_submit: true,
      transaction_signed: false,
      transaction_broadcast: false,
      claim_available: false,
      withdrawal_authorized: false,
      withdrawal_execution_proven: false,
      funds_moved: false,
      redirect_possible: false,
    },
    funding_precondition_satisfied: false,
    initial_funding_safety_proven: false,
    funding_authorized: false,
  };
}

function authorization() {
  const plan = buildLighterOwnerRecoveryIntent({ ownerAddress: OWNER, accountIndex: ACCOUNT_INDEX });
  const payload = {
    version: 1 as const,
    audience: "ghola_lighter_owner_recovery_readiness" as const,
    owner_commitment: `owner_${"ab".repeat(24)}`,
    owner_address: OWNER as `0x${string}`,
    account_index: ACCOUNT_INDEX,
    plan_commitment: lighterOwnerRecoveryPlanCommitment(plan),
    nonce: "cd".repeat(32),
    issued_at_ms: NOW,
    expires_at_ms: NOW + 120_000,
  };
  return {
    challenge_token: `${"a".repeat(100)}.${"b".repeat(43)}`,
    message: lighterOwnerRecoveryReadinessMessage(payload),
    payload,
  };
}

function signingProof() {
  return {
    signature: SIGNATURE,
    owner_address: OWNER as `0x${string}`,
    signing_method: "turnkey_eip191_owner_proof" as const,
    transaction_signed: false as const,
    transaction_broadcast: false as const,
  };
}
