import { afterEach, describe, expect, it, vi } from "vitest";
import {
  privateExecutionFeeQuote,
  signPrivateExecutionReceipt,
  type PrivateExecutionReceiptV1,
} from "@/lib/private-execution";
import { POST } from "./route";

function request(body: unknown) {
  return new Request("https://ghola.test/v1/private-intents/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function receipt(): PrivateExecutionReceiptV1 {
  const unsigned = {
    version: 1 as const,
    receipt_id: "pex_1",
    intent_id: "intent_1",
    agent_id: "agent_1",
    policy_hash: "policy",
    proposal_hash: "proposal",
    rail: "railgun_private_swap" as const,
    amount_micro_usdc: 25_000_000,
    fee_quote: privateExecutionFeeQuote({
      amountMicroUsdc: 25_000_000,
      feeRecipient: "railgun:fee",
    }),
    provider_id: "mock_attested",
    executed_at: "2026-05-25T00:00:00.000Z",
    tx_ref: "shielded:intent_1",
    public_fallback_used: false as const,
  };
  return {
    ...unsigned,
    signature: signPrivateExecutionReceipt(unsigned, "secret"),
  };
}

describe("private intent receipt verification route", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts valid signed receipts", async () => {
    vi.stubEnv("GHOLA_PRIVATE_EXECUTION_RECEIPT_SECRET", "secret");

    const res = await POST(request({ receipt: receipt() }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("rejects tampered fee receipts", async () => {
    vi.stubEnv("GHOLA_PRIVATE_EXECUTION_RECEIPT_SECRET", "secret");
    const tampered = receipt();
    tampered.fee_quote.fee_micro_usdc = 1;

    const res = await POST(request({ receipt: tampered }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
  });
});
