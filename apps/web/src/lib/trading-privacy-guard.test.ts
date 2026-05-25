import { describe, expect, it } from "vitest";
import { compileTradingStrategy, usdToMicro } from "./trading-strategy";
import {
  evaluateTradeProposal,
  type TradeProposalV1,
} from "./trading-privacy-guard";

const OWNER = "did:key:z6Mki11111111111111111111111111111111111111111111";

function policy() {
  const result = compileTradingStrategy("DCA $25 into ETH every Friday", OWNER, {
    now: new Date("2026-05-24T00:00:00.000Z"),
  });
  if (!result.ok) throw new Error("compile failed");
  return result.policy;
}

function proposal(overrides: Partial<TradeProposalV1> = {}): TradeProposalV1 {
  const p = policy();
  return {
    version: 1,
    proposal_id: "proposal-1",
    strategy_id: p.strategy_id,
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
    ...overrides,
  };
}

describe("trading privacy guard", () => {
  it("allows a valid shielded private swap proposal", () => {
    const p = policy();
    const result = evaluateTradeProposal(p, proposal({ strategy_id: p.strategy_id }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.visible_leakage).toBe("none_expected_shielded_execution");
  });

  it("denies public AMM execution", () => {
    const p = policy();
    const result = evaluateTradeProposal(
      p,
      proposal({ strategy_id: p.strategy_id, public_amm: true }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("public_amm_denied");
  });

  it("denies unshielding and public destinations", () => {
    const p = policy();
    const unshield = evaluateTradeProposal(
      p,
      proposal({ strategy_id: p.strategy_id, unshield: true }),
    );
    const destination = evaluateTradeProposal(
      p,
      proposal({
        strategy_id: p.strategy_id,
        destination_address: "0xknown",
      }),
    );

    expect(unshield.ok).toBe(false);
    expect(destination.ok).toBe(false);
  });

  it("denies weird exact amounts outside approved buckets", () => {
    const p = policy();
    const widened = {
      ...p,
      max_trade_micro_usdc: usdToMicro(50),
      daily_cap_micro_usdc: usdToMicro(50),
    };
    const result = evaluateTradeProposal(
      widened,
      proposal({ strategy_id: p.strategy_id, amount_micro_usdc: usdToMicro(26) }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("amount_not_bucketed");
  });

  it("denies too-fast execution timing", () => {
    const p = policy();
    const result = evaluateTradeProposal(
      p,
      proposal({
        strategy_id: p.strategy_id,
        created_at: "2026-05-24T00:01:00.000Z",
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("delay_window_not_met");
  });
});
