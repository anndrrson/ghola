import { describe, expect, it } from "vitest";
import { compileTradingStrategy, usdToMicro } from "./trading-strategy";
import {
  containsPrivateExecutionPlaintextLeak,
  privateExecutionFeeQuote,
  signPrivateExecutionReceipt,
  simulatePrivateExecution,
  verifyPrivateExecutionReceiptSignature,
  type PrivateExecutionReceiptV1,
} from "./private-execution";
import type { TradeProposalV1 } from "./trading-privacy-guard";

const OWNER = "did:key:z6Mki11111111111111111111111111111111111111111111";

function fixture() {
  const result = compileTradingStrategy("DCA $25 into ETH every Friday", OWNER, {
    now: new Date("2026-05-24T00:00:00.000Z"),
  });
  if (!result.ok) throw new Error("compile failed");
  const proposal: TradeProposalV1 = {
    version: 1,
    proposal_id: "proposal-1",
    strategy_id: result.policy.strategy_id,
    created_at: "2026-05-24T00:10:00.000Z",
    trigger_seen_at: "2026-05-24T00:00:00.000Z",
    venue: "railgun_private_swap",
    public_amm: false,
    unshield: false,
    destination_address: null,
    destination_label: null,
    known_public_wallet: false,
    base_asset: "ETH",
    quote_asset: "USDC",
    side: "buy",
    amount_micro_usdc: usdToMicro(25),
    slippage_bps: 30,
    calldata_kind: "railgun_private_swap",
    execution_mode: "prepare_only",
    user_confirmed: true,
  };
  return { policy: result.policy, proposal };
}

describe("private execution primitives", () => {
  it("quotes execution fees with bps and minimum fee", () => {
    expect(
      privateExecutionFeeQuote({
        amountMicroUsdc: usdToMicro(25),
        feeRecipient: "railgun:fee",
      }).fee_micro_usdc,
    ).toBe(50_000);
    expect(
      privateExecutionFeeQuote({
        amountMicroUsdc: usdToMicro(1000),
        feeRecipient: "railgun:fee",
      }).fee_micro_usdc,
    ).toBe(1_000_000);
  });

  it("simulates a valid private execution with no public fallback", () => {
    const { policy, proposal } = fixture();
    const result = simulatePrivateExecution({
      policy,
      proposal,
      feeRecipient: "railgun:fee",
    });

    expect(result.ok).toBe(true);
    expect(result.exposure_report.public_fallback_allowed).toBe(false);
    expect(result.exposure_report.expected_public_leakage).toBe(
      "none_expected_shielded_execution",
    );
    expect(result.fee_quote?.fee_recipient).toBe("railgun:fee");
  });

  it("blocks public AMM exposure before execution", () => {
    const { policy, proposal } = fixture();
    const result = simulatePrivateExecution({
      policy,
      proposal: { ...proposal, public_amm: true },
      feeRecipient: "railgun:fee",
    });

    expect(result.ok).toBe(false);
    expect(result.exposure_report.expected_public_leakage).toBe(
      "blocked_before_execution",
    );
    expect(result.fee_quote).toBeUndefined();
  });

  it("detects plaintext financial context recursively", () => {
    expect(
      containsPrivateExecutionPlaintextLeak({
        encrypted_intent_bundle: { ciphertext: "abc" },
        nested: [{ portfolio: { sol: 10 } }],
      }),
    ).toBe(true);
  });

  it("signs and rejects tampered receipts", () => {
    const unsigned = {
      version: 1 as const,
      receipt_id: "pex_1",
      intent_id: "intent_1",
      agent_id: "agent_1",
      policy_hash: "policy",
      proposal_hash: "proposal",
      rail: "railgun_private_swap" as const,
      amount_micro_usdc: usdToMicro(25),
      fee_quote: privateExecutionFeeQuote({
        amountMicroUsdc: usdToMicro(25),
        feeRecipient: "railgun:fee",
      }),
      provider_id: "mock_attested",
      executed_at: "2026-05-25T00:00:00.000Z",
      tx_ref: "shielded:intent_1",
      public_fallback_used: false as const,
    };
    const receipt: PrivateExecutionReceiptV1 = {
      ...unsigned,
      signature: signPrivateExecutionReceipt(unsigned, "secret"),
    };

    expect(verifyPrivateExecutionReceiptSignature(receipt, "secret")).toBe(true);
    expect(
      verifyPrivateExecutionReceiptSignature(
        { ...receipt, fee_quote: { ...receipt.fee_quote, fee_micro_usdc: 1 } },
        "secret",
      ),
    ).toBe(false);
  });
});
