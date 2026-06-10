import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { submitJupiterSwapExecution } from "../src/venues/jupiter.js";

const OLD_ENV = { ...process.env };
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

describe("jupiter live adapter policy", () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
    process.env.PRIVATE_AGENT_JUPITER_LIVE_MODE = "full";
    process.env.PRIVATE_AGENT_JUPITER_API_KEY = "test-jupiter-key";
    process.env.PRIVATE_AGENT_JUPITER_ALLOWED_INPUT_MINTS = SOL_MINT;
    process.env.PRIVATE_AGENT_JUPITER_ALLOWED_OUTPUT_MINTS = USDC_MINT;
    process.env.PRIVATE_AGENT_JUPITER_MAX_SLIPPAGE_BPS = "100";
    process.env.PRIVATE_AGENT_JUPITER_LIVE_MAX_NOTIONAL_USD = "1000";
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it("blocks swaps above the live notional cap before building a transaction", async () => {
    await assert.rejects(
      () => submitJupiterSwapExecution({
        credential: { authority: "authority" },
        clientOrderId: "jupiter_over_cap",
        instruction: {
          version: 1,
          venue_id: "jupiter",
          operation_class: "swap",
          order: {
            input_mint: SOL_MINT,
            output_mint: USDC_MINT,
            amount: "1000000",
            quote_size: "1001",
            max_slippage_bps: "50",
            routing_mode: "meta_aggregator",
          },
        },
        fetchImpl: async () => {
          throw new Error("fetch should not be called");
        },
      }),
      /notional cap/,
    );
  });
});
