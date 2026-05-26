import { afterEach, describe, expect, it, vi } from "vitest";
import {
  privateExecutionFeeQuote,
  signPrivateExecutionReceipt,
  type PrivateExecutionReceiptV1,
} from "@/lib/private-execution";
import {
  recordPrivateExecutionReceipt,
  resetPrivateExecutionStoreForTests,
} from "@/lib/private-execution-store";
import { GET } from "./route";

function request(apiKey = "sk_agent") {
  return new Request("https://ghola.test/v1/private-intents/usage", {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
  });
}

function receipt(): PrivateExecutionReceiptV1 {
  const unsigned = {
    version: 1 as const,
    receipt_id: "pex_usage",
    intent_id: "intent_usage",
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
    tx_ref: "shielded:intent_usage",
    public_fallback_used: false as const,
  };
  return {
    ...unsigned,
    signature: signPrivateExecutionReceipt(unsigned, "secret"),
  };
}

describe("private execution usage route", () => {
  afterEach(async () => {
    await resetPrivateExecutionStoreForTests();
    vi.unstubAllEnvs();
  });

  it("summarizes persisted receipts for the authenticated agent", async () => {
    vi.stubEnv(
      "GHOLA_AGENT_API_KEYS",
      JSON.stringify({ sk_agent: { agent_id: "agent_1", label: "Agent One" } }),
    );
    await recordPrivateExecutionReceipt({
      receipt: receipt(),
      agent: { agent_id: "agent_1", label: "Agent One" },
    });

    const res = await GET(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.execution_count).toBe(1);
    expect(body.total_volume_micro_usdc).toBe(25_000_000);
    expect(body.total_fee_micro_usdc).toBe(50_000);
    expect(body.latest_receipts[0].receipt_id).toBe("pex_usage");
  });

  it("requires an agent API key", async () => {
    const res = await GET(request(""));
    expect(res.status).toBe(401);
  });
});
