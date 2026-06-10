import { describe, expect, it, vi, afterEach } from "vitest";
import { compileTradingStrategy, usdToMicro } from "@/lib/trading-strategy";
import type { TradeProposalV1 } from "@/lib/trading-privacy-guard";
import { POST } from "./route";

const OWNER = "did:key:z6Mki11111111111111111111111111111111111111111111";

function request(body: unknown) {
  return new Request("https://ghola.test/v1/private-intents/simulate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

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

describe("private intent simulation route", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns fee quote and no expected public leakage for valid private proposal", async () => {
    vi.stubEnv("GHOLA_PRIVATE_EXECUTION_FEE_RECIPIENT", "railgun:fee");
    const { policy, proposal } = fixture();

    const res = await POST(request({ version: 1, policy, proposal }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.fee_quote.fee_recipient).toBe("railgun:fee");
    expect(body.exposure_report.public_fallback_allowed).toBe(false);
  });

  it("blocks public proposals before execution", async () => {
    const { policy, proposal } = fixture();

    const res = await POST(
      request({ version: 1, policy, proposal: { ...proposal, unshield: true } }),
    );
    const body = await res.json();

    expect(body.ok).toBe(false);
    expect(body.exposure_report.blocked_reason).toBe("unshield_denied");
  });
});
