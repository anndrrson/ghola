import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  importPrivateModeCanaryEvidence,
  privateModeCanaryStatus,
} from "./private-account-canary";
import { gholaCommitment } from "./private-account";
import {
  resetPrivateAccountStoreForTests,
  type PrivateFundingInstructionRecordV1,
} from "./private-account-store";
import type {
  PrivateShieldedVerifierHealth,
  PrivateShieldedVerifierResult,
} from "./private-account-verifier";

type VerifyInput = {
  instruction: PrivateFundingInstructionRecordV1;
  receipt_id: string;
  now?: Date;
};

function verifierHealth(now = new Date()): PrivateShieldedVerifierHealth {
  return {
    version: 1,
    status: "green",
    mode: "local_test",
    configured: true,
    network: "custom-shielded-v1",
    verifier_commitment: gholaCommitment("verifier", "canary-test"),
    verifier_head_commitment: gholaCommitment("verifier_head", "canary-test"),
    min_confirmations: 3,
    max_stale_ms: 300_000,
    observed_at: now.toISOString(),
    checked_at: now.toISOString(),
    reason: null,
  };
}

function accepted(input: VerifyInput): Promise<{ ok: true; result: PrivateShieldedVerifierResult }> {
  const now = input.now ?? new Date();
  return Promise.resolve({
    ok: true,
    result: {
      version: 1,
      receipt_commitment: gholaCommitment("receipt", input.receipt_id),
      nullifier_commitment: gholaCommitment("nullifier", input.receipt_id),
      destination_commitment: input.instruction.destination_commitment,
      amount_bucket: input.instruction.amount_bucket,
      asset_bucket: input.instruction.asset_bucket,
      network: "custom-shielded-v1",
      confirmation_depth: 3,
      verifier_commitment: gholaCommitment("verifier", "canary-test"),
      verifier_head_commitment: gholaCommitment("verifier_head", "canary-test"),
      observed_at: now.toISOString(),
    },
  });
}

function rejected(input: VerifyInput) {
  return Promise.resolve({
    ok: false as const,
    error: "invalid_shielded_receipt" as const,
    health: verifierHealth(input.now ?? new Date()),
  });
}

describe("private mode canary verification", () => {
  beforeEach(() => {
    process.env.GHOLA_SHIELDED_POOL_MODE = "http";
    process.env.GHOLA_PRIVATE_MODE_PRODUCTION_ENABLED = "true";
  });

  afterEach(async () => {
    await resetPrivateAccountStoreForTests();
    delete process.env.GHOLA_SHIELDED_POOL_MODE;
    delete process.env.GHOLA_PRIVATE_MODE_PRODUCTION_ENABLED;
    delete process.env.GHOLA_PRIVATE_MODE_CANARY_FUNDED_PROGRAM_COMMITMENT;
    delete process.env.GHOLA_PRIVATE_MODE_CANARY_FUNDED_PROGRAM_OBSERVED_AT;
  });

  it("stores a green funded canary from verifier success", async () => {
    const imported = await importPrivateModeCanaryEvidence([
      {
        canary_kind: "funded_program",
        expected_result: "verified",
        receipt_id: "custom_receipt_canary_program",
        destination_commitment: "canary_destination",
        amount_bucket: "25",
        asset_bucket: "stablecoin",
      },
    ], new Date("2026-05-30T12:00:00.000Z"), accepted);

    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.records[0].status).toBe("green");
    expect(imported.records[0].evidence_commitment).toMatch(/^verified_private_mode_canary_/);
  });

  it("stores a green unfunded canary only for the expected verifier rejection", async () => {
    const imported = await importPrivateModeCanaryEvidence([
      {
        canary_kind: "unfunded",
        expected_result: "rejected",
        expected_error: "invalid_shielded_receipt",
        receipt_id: "invalid_receipt_canary",
        destination_commitment: "canary_destination",
        amount_bucket: "25",
        asset_bucket: "stablecoin",
      },
    ], new Date("2026-05-30T12:00:00.000Z"), rejected);

    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.records[0].status).toBe("green");
    expect(imported.records[0].evidence_commitment).toMatch(/^verified_private_mode_negative_canary_/);
  });

  it("stores a red unfunded canary when the verifier unexpectedly accepts it", async () => {
    const imported = await importPrivateModeCanaryEvidence([
      {
        canary_kind: "unfunded",
        expected_result: "rejected",
        expected_error: "invalid_shielded_receipt",
        receipt_id: "custom_receipt_unfunded_should_not_verify",
        destination_commitment: "canary_destination",
        amount_bucket: "25",
        asset_bucket: "stablecoin",
      },
    ], new Date("2026-05-30T12:00:00.000Z"), accepted);

    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.records[0].status).toBe("red");
    expect(imported.records[0].reason).toContain("unexpectedly verified");
  });

  it("rejects raw canary evidence in non-local mode", async () => {
    const imported = await importPrivateModeCanaryEvidence([
      {
        canary_kind: "funded_program",
        evidence_commitment: "raw_commitment",
        observed_at: new Date().toISOString(),
      },
    ]);

    expect(imported.ok).toBe(false);
    if (imported.ok) return;
    expect(imported.details.join(" ")).toContain("raw evidence_commitment is not accepted");
  });

  it("does not use raw env canary shortcuts for production enablement", async () => {
    process.env.GHOLA_PRIVATE_MODE_CANARY_FUNDED_PROGRAM_COMMITMENT = "raw_env_commitment";
    process.env.GHOLA_PRIVATE_MODE_CANARY_FUNDED_PROGRAM_OBSERVED_AT = new Date().toISOString();

    const status = await privateModeCanaryStatus();
    const fundedProgram = status.canaries.find((item) => item.canary_kind === "funded_program");
    expect(fundedProgram?.status).toBe("missing");
    expect(fundedProgram?.evidence_commitment).toBeNull();
  });
});
