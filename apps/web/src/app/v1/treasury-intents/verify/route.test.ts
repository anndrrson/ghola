import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildTreasuryApprovalHash,
  buildTreasuryExecutionReceipt,
  type TreasuryExecutionReceiptV1,
} from "@/lib/treasury-execution";
import { POST } from "./route";

const OWNER = "did:key:z6MkiTreasury1111111111111111111111111111111111";
const APPROVAL_EXPIRES_AT = "2999-01-01T00:00:00.000Z";
const usd = (value: number) => value * 1_000_000;

function request(body: unknown) {
  return new Request("https://ghola.test/v1/treasury-intents/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function receipt(): TreasuryExecutionReceiptV1 {
  const approvalHash = buildTreasuryApprovalHash({
    ownerDid: OWNER,
    policyHash: "policy_hash",
    proposalHash: "proposal_hash",
    amountMicroUsd: usd(250_000),
    rails: ["bank_cash", "treasury_bills"],
    expiresAt: APPROVAL_EXPIRES_AT,
  });
  return buildTreasuryExecutionReceipt({
    request: {
      version: 1,
      intent_id: "intent_treasury_1",
      owner_did: OWNER,
      policy_hash: "policy_hash",
      proposal_hash: "proposal_hash",
      approval_hash: approvalHash,
      approval_expires_at: APPROVAL_EXPIRES_AT,
      amount_micro_usd: usd(250_000),
      rails: ["bank_cash", "treasury_bills"],
      encrypted_context_bundle: {
        alg: "sealed-provider-v1",
        ciphertext: "sealed",
        recipient: "provider",
        aad: "treasury-intent-v1",
      },
    },
    agentId: "agent_treasury",
    providerId: "mock_treasury_partner",
    signingSecret: "secret",
    now: new Date("2026-05-25T00:00:00.000Z"),
  });
}

describe("treasury receipt verification route", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts valid signed treasury receipts", async () => {
    vi.stubEnv("GHOLA_TREASURY_RECEIPT_SECRET", "secret");

    const res = await POST(request({ receipt: receipt() }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("rejects tampered treasury receipts", async () => {
    vi.stubEnv("GHOLA_TREASURY_RECEIPT_SECRET", "secret");
    const tampered = receipt();

    const res = await POST(
      request({
        receipt: {
          ...tampered,
          amount_micro_usd: usd(1),
        },
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
  });
});
