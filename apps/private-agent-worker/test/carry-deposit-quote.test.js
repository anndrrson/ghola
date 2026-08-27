import assert from "node:assert/strict";
import test from "node:test";
import { createCarryDepositQuoteReader } from "../src/execution/carry-deposit-quote.js";

const NOW = 1_800_000_000_000;

test("verifies Hyperliquid and Lighter Arbitrum deposit routes without submitting", async () => {
  const readQuote = createCarryDepositQuoteReader(dependencies());
  const hyperliquid = await readQuote(request("hyperliquid", "USDC"));
  assert.equal(hyperliquid.destination, "0x2df1c51e09aecf9cacb7bc98cb1742757f163df7");
  assert.equal(hyperliquid.minimum_transfer_micro_usdc, 5_000_000);
  assert.equal(hyperliquid.maximum_transfer_micro_usdc, 250_000_000);
  assert.equal(hyperliquid.transaction_broadcast, false);

  const lighter = await readQuote(request("lighter", "USDC"));
  assert.equal(lighter.destination, "lighter_arbitrum_cctp_intent");
  assert.equal(lighter.minimum_transfer_micro_usdc, 5_000_000);
  assert.equal(lighter.fund_movement_authorized, false);
});

test("binds Aster's live Arbitrum asset contract and minimum deposit", async () => {
  const readQuote = createCarryDepositQuoteReader(dependencies({ asterMinimum: "3.5000001" }));
  const quote = await readQuote(request("aster", "USDT"));
  assert.equal(quote.destination, "0x9e36cb86a159d479ced94fa05036f235ac40e1d5");
  assert.equal(quote.asset_contract_address, "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9");
  assert.equal(quote.minimum_transfer_micro_usdc, 3_500_001);
  assert.equal(quote.fee_upper_bound_micro_usdc, 450_000);
});

test("fails closed for missing live support, stale policy, or target drift", async () => {
  const noBridge = dependencies({ bridgeCode: "0x" });
  await assert.rejects(
    () => createCarryDepositQuoteReader(noBridge)(request("hyperliquid", "USDC")),
    /carry_deposit_hyperliquid_bridge_unavailable/,
  );

  const stale = dependencies();
  stale.deposit_policies.lighter.expires_at_ms = NOW;
  await assert.rejects(
    () => createCarryDepositQuoteReader(stale)(request("lighter", "USDC")),
    /carry_deposit_policy_stale/,
  );

  const drift = dependencies();
  drift.deposit_policies.aster.destination = "0x0000000000000000000000000000000000000001";
  await assert.rejects(
    () => createCarryDepositQuoteReader(drift)(request("aster", "USDT")),
    /carry_deposit_policy_binding_invalid/,
  );

  const expensiveGas = dependencies({ gasPrice: "0x77359400" });
  await assert.rejects(
    () => createCarryDepositQuoteReader(expensiveGas)(request("lighter", "USDC")),
    /carry_deposit_fee_above_policy/,
  );
});

function dependencies({
  asterMinimum = "0",
  bridgeCode = "0x60016001",
  gasPrice = "0x3b9aca00",
} = {}) {
  return {
    now: () => NOW,
    deposit_policies: {
      hyperliquid: policy(
        "hyperliquid",
        "USDC",
        "0x2df1c51e09aecf9cacb7bc98cb1742757f163df7",
      ),
      lighter: policy("lighter", "USDC", "lighter_arbitrum_cctp_intent"),
      aster: policy("aster", "USDT", "0x9e36cb86a159d479ced94fa05036f235ac40e1d5"),
    },
    fetchImpl: async (url, options) => {
      if (String(url).includes("arbitrum.io")) {
        assert.equal(options.method, "POST");
        const body = JSON.parse(options.body);
        assert.ok(["eth_getCode", "eth_gasPrice"].includes(body.method));
        return {
          ok: true,
          json: async () => ({
            jsonrpc: "2.0",
            id: body.id,
            result: body.method === "eth_getCode" ? bridgeCode : gasPrice,
          }),
        };
      }
      if (String(url).includes("zklighter")) {
        return {
          ok: true,
          json: async () => ({ code: 200, networks: [{ name: "Arbitrum One", chain_id: "42161" }] }),
        };
      }
      if (String(url).includes("ticker/price")) {
        return {
          ok: true,
          json: async () => ({ symbol: "ETHUSDT", price: "2500", time: NOW }),
        };
      }
      if (String(url).includes("asterdex")) {
        return {
          ok: true,
          json: async () => ({
            code: "000000",
            success: true,
            data: [{
              name: "USDT",
              contractAddress: "0xFD086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
              decimals: 6,
              network: "EVM",
              chainId: 42_161,
              depositType: "normal",
              minDeposit: asterMinimum,
            }],
          }),
        };
      }
      throw new Error("unexpected_url");
    },
  };
}

function policy(venueId, asset, destination) {
  return {
    version: 1,
    venue_id: venueId,
    collateral_asset: asset,
    destination,
    verified: true,
    read_only: true,
    owner_approval_required: true,
    fund_movement_authorized: false,
    transaction_broadcast: false,
    observed_at_ms: NOW - 1_000,
    expires_at_ms: NOW + 60_000,
    minimum_transfer_micro_usdc: 1_000_000,
    maximum_transfer_micro_usdc: 250_000_000,
    fee_ceiling_micro_usdc: 500_000,
    gas_units_ceiling: 150_000,
    gas_price_buffer_bps: 2_000,
    latency_ceiling_ms: 360_000,
  };
}

function request(venueId, asset) {
  return {
    venue_id: venueId,
    destination_collateral_asset: asset,
    destination_account_state_commitment: `carry:account-state:${venueId}:0001`,
    checked_at_ms: NOW,
  };
}
