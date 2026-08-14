import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { createHash } from "node:crypto";
import {
  backpackOrderRequest,
  readBackpackAccountSnapshot,
  readBackpackTopOfBook,
  reconcileBackpackExecution,
  solanaPerpsCredentialFromVault,
  submitSolanaPerpsExecution,
  verifySolanaPerpsNoSubmit,
} from "../src/venues/solana_perps.js";

const OLD_ENV = { ...process.env };

describe("solana perps live connector", () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV };
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "false";
    process.env.PRIVATE_AGENT_SOLANA_PERPS_LIVE_MODE = "sdk_runner";
    process.env.PRIVATE_AGENT_SOLANA_PERPS_ALLOW_MAINNET = "true";
    process.env.PRIVATE_AGENT_SOLANA_PERPS_LIVE_MAX_NOTIONAL_USD = "5";
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it("executes the Phoenix SDK runner behind tiny-fill live gates", async () => {
    const keypair = Keypair.generate();
    const credential = solanaPerpsCredentialFromVault({
      version: 1,
      kind: "ghola_solana_perps_execution_vault",
      venue_id: "phoenix",
      network: "mainnet",
      authority: keypair.publicKey.toBase58(),
      wallet_private_key: Array.from(keypair.secretKey),
      api_url: "https://perp-api.phoenix.trade",
      rpc_url: "https://api.mainnet-beta.solana.com",
    });

    const result = await submitSolanaPerpsExecution({
      credential,
      venueId: "phoenix",
      executionMode: "user_stealth",
      clientOrderId: "phoenix_client_order_test",
      instruction: {
        version: 1,
        venue_id: "phoenix",
        operation_class: "perp_limit_order",
        order: {
          market: "SOL-PERP",
          side: "buy",
          base_size: "0.01",
          limit_price: "100",
          tif: "Ioc",
          live_order_mode: "tiny_fill",
        },
      },
      runner: async (payload) => {
        assert.equal(payload.credential.authority, keypair.publicKey.toBase58());
        assert.equal(payload.instruction.order.market, "SOL-PERP");
        assert.equal(payload.venueId, "phoenix");
        return { status: "submitted", signature: "phoenix_signature_test" };
      },
    });

    assert.equal(result.status, "submitted");
    assert.equal(result.provider_ref_seed.transaction_signature, "phoenix_signature_test");
    assert.equal(JSON.stringify(result).includes("wallet_private_key"), false);
  });

  it("blocks live Solana perps orders above the tiny-fill notional cap", async () => {
    const keypair = Keypair.generate();
    const credential = solanaPerpsCredentialFromVault({
      version: 1,
      kind: "ghola_solana_perps_execution_vault",
      venue_id: "phoenix",
      network: "mainnet",
      authority: keypair.publicKey.toBase58(),
      wallet_private_key: Array.from(keypair.secretKey),
    });

    await assert.rejects(
      () => submitSolanaPerpsExecution({
        credential,
        venueId: "phoenix",
        executionMode: "user_stealth",
        clientOrderId: "phoenix_client_order_over_cap",
        instruction: {
          version: 1,
          venue_id: "phoenix",
          operation_class: "perp_limit_order",
          order: {
            market: "SOL-PERP",
            side: "buy",
            base_size: "1",
            limit_price: "100",
            tif: "Ioc",
            live_order_mode: "tiny_fill",
          },
        },
        runner: async () => {
          throw new Error("runner should not be called");
        },
      }),
      /live notional cap/,
    );
  });

  it("blocks live Solana perps orders above the slippage cap", async () => {
    process.env.PRIVATE_AGENT_SOLANA_PERPS_MAX_SLIPPAGE_BPS = "25";
    const keypair = Keypair.generate();
    const credential = solanaPerpsCredentialFromVault({
      version: 1,
      kind: "ghola_solana_perps_execution_vault",
      venue_id: "phoenix",
      network: "mainnet",
      authority: keypair.publicKey.toBase58(),
      wallet_private_key: Array.from(keypair.secretKey),
    });

    await assert.rejects(
      () => submitSolanaPerpsExecution({
        credential,
        venueId: "phoenix",
        executionMode: "user_stealth",
        clientOrderId: "phoenix_client_order_slippage",
        instruction: {
          version: 1,
          venue_id: "phoenix",
          operation_class: "perp_limit_order",
          order: {
            market: "SOL-PERP",
            side: "buy",
            quote_size: "5",
            limit_price: "100",
            max_slippage_bps: "50",
            tif: "Ioc",
            live_order_mode: "tiny_fill",
          },
        },
        runner: async () => {
          throw new Error("runner should not be called");
        },
      }),
      /slippage/,
    );
  });

  it("classifies insufficient Solana perps funds separately from venue rejection", async () => {
    const keypair = Keypair.generate();
    const credential = solanaPerpsCredentialFromVault({
      version: 1,
      kind: "ghola_solana_perps_execution_vault",
      venue_id: "phoenix",
      network: "mainnet",
      authority: keypair.publicKey.toBase58(),
      wallet_private_key: Array.from(keypair.secretKey),
    });

    await assert.rejects(
      () => submitSolanaPerpsExecution({
        credential,
        venueId: "phoenix",
        executionMode: "user_stealth",
        clientOrderId: "phoenix_client_order_no_funds",
        instruction: {
          version: 1,
          venue_id: "phoenix",
          operation_class: "perp_limit_order",
          order: {
            market: "SOL-PERP",
            side: "buy",
            quote_size: "5",
            limit_price: "100",
            tif: "Ioc",
            live_order_mode: "tiny_fill",
          },
        },
        runner: async () => {
          throw new Error("insufficient lamports for transaction");
        },
      }),
      (error) => error.code === "needs_funds" && error.status === 402,
    );
  });

  it("verifies Phoenix readiness without broadcasting a transaction", async () => {
    const keypair = Keypair.generate();
    const credential = solanaPerpsCredentialFromVault({
      version: 1,
      kind: "ghola_solana_perps_execution_vault",
      venue_id: "phoenix",
      network: "mainnet",
      authority: keypair.publicKey.toBase58(),
      wallet_private_key: Array.from(keypair.secretKey),
      api_url: "https://perp-api.phoenix.trade",
      rpc_url: "https://api.mainnet-beta.solana.com",
    });
    let broadcasted = false;

    const result = await verifySolanaPerpsNoSubmit({
      credential,
      venueId: "phoenix",
      executionMode: "user_stealth",
      clientOrderId: "phoenix_no_submit_test",
      instruction: {
        version: 1,
        venue_id: "phoenix",
        operation_class: "perp_limit_order",
        order: {
          market: "SOL",
          side: "buy",
          quote_size: "5",
          limit_price: "250",
          tif: "Ioc",
          live_order_mode: "tiny_fill",
        },
      },
      checker: async (payload) => {
        assert.equal(payload.credential.authority, keypair.publicKey.toBase58());
        assert.equal(payload.instruction.order.market, "SOL");
        return {
          rpc_checked: true,
          phoenix_checked: true,
          order_packet_checked: true,
        };
      },
    });

    assert.equal(broadcasted, false);
    assert.equal(result.status, "verified_no_funds");
    assert.equal(result.checks.transaction_broadcast, false);
    assert.equal(result.checks.order_packet_built, true);
    assert.equal(JSON.stringify(result).includes("wallet_private_key"), false);
  });

  it("reconciles an IOC Backpack order by deterministic uint32 client id", async () => {
    process.env.PRIVATE_AGENT_BACKPACK_LIVE_MODE = "tiny_live";
    process.env.PRIVATE_AGENT_LIVE_MAX_ORDER_NOTIONAL_USD = "11";
    const clientOrderId = "cross_venue_backpack_leg_123";
    const clientId = Number.parseInt(
      createHash("sha256").update(clientOrderId).digest("hex").slice(0, 8),
      16,
    );
    assert.ok(clientId <= 0xffff_ffff);
    const credential = {
      venueId: "backpack",
      network: "mainnet",
      apiKey: "test-api-key",
      privateSeed: new Uint8Array(32).fill(7),
      apiUrl: "https://api.backpack.exchange",
      allowedSymbols: ["SOL_USDC_PERP"],
      maxOrderNotionalUsd: 11,
      dailyNotionalCapUsd: 25,
      postOnlyMarketMaking: false,
    };
    const fetchImpl = async (url) => {
      const pathname = new URL(url).pathname;
      const body = pathname.endsWith("/history/orders")
        ? [{ id: "order-7", clientId, symbol: "SOL_USDC_PERP", status: "Filled", executedQuantity: "0.05", executedQuoteQuantity: "10.1" }]
        : [{ orderId: "order-7", clientId, symbol: "SOL_USDC_PERP", quantity: "0.05", price: "202", quoteQuantity: "10.1" }];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    };
    const result = await reconcileBackpackExecution({
      credential,
      clientOrderId,
      instruction: {
        operation_class: "perp_limit_order",
        order: { market: "SOL_USDC_PERP", side: "sell", quote_size: "10.1", limit_price: "202", tif: "Ioc", live_order_mode: "tiny_fill" },
      },
      fetchImpl,
    });
    assert.equal(result.terminal, true);
    assert.equal(result.status, "filled");
    assert.equal(result.filled_notional_micro_usdc, 10_100_000);
    assert.equal(result.filled_base_size, "0.05");
    assert.equal(result.venue_order_reference, "order_id:order-7");
    assert.equal(result.final_proof.final_fill_proven, true);
  });

  it("preserves reduce-only on a live Backpack exit", async () => {
    process.env.PRIVATE_AGENT_BACKPACK_LIVE_MODE = "tiny_live";
    process.env.PRIVATE_AGENT_LIVE_MAX_ORDER_NOTIONAL_USD = "11";
    const credential = backpackCredential();
    let observedOrder = null;
    await submitSolanaPerpsExecution({
      credential,
      venueId: "backpack",
      executionMode: "ghola_pooled",
      clientOrderId: "backpack_reduce_only_exit",
      instruction: {
        version: 1,
        venue_id: "backpack",
        operation_class: "perp_limit_order",
        order: {
          market: "SOL_USDC_PERP",
          side: "buy",
          base_size: "0.14",
          limit_price: "76",
          tif: "Ioc",
          live_order_mode: "tiny_fill",
          reduce_only: true,
          max_slippage_bps: "25",
        },
      },
      runner: async ({ instruction, clientOrderId }) => {
        observedOrder = { ...instruction.order, clientOrderId };
        return { status: "submitted", provider_order_id: "bp-close-1" };
      },
    });
    assert.equal(observedOrder.reduce_only, true);
    const request = backpackOrderRequest({
      market: "SOL_USDC_PERP",
      side: "buy",
      order_type: "market",
      base_size: "0.14",
      tif: "Ioc",
      reduce_only: true,
    }, "backpack_reduce_only_exit");
    assert.deepEqual({ ...request, clientId: 0 }, {
      symbol: "SOL_USDC_PERP",
      side: "Bid",
      orderType: "Market",
      quantity: "0.14",
      postOnly: false,
      reduceOnly: true,
      timeInForce: "IOC",
      selfTradePrevention: "RejectTaker",
      clientId: 0,
    });
    assert.equal(Number.isSafeInteger(request.clientId), true);
  });

  it("reads exact Backpack funds, positions, open orders, and public book", async () => {
    const credential = backpackCredential();
    const requests = [];
    const fetchImpl = async (url) => {
      const parsed = new URL(url);
      requests.push(parsed.pathname);
      let body;
      if (parsed.pathname === "/api/v1/account") body = { liquidating: false };
      else if (parsed.pathname === "/api/v1/capital/collateral") body = { netEquityAvailable: "23.75" };
      else if (parsed.pathname === "/api/v1/position") body = [{ symbol: "SOL_USDC_PERP", netQuantity: "-0.14" }];
      else if (parsed.pathname === "/api/v1/orders") body = [{ symbol: "SOL_USDC_PERP", id: "resting-1" }];
      else body = { bids: [["75.70", "2"], ["75.69", "3"]], asks: [["75.72", "2"], ["75.73", "3"]] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    };
    const account = await readBackpackAccountSnapshot({ credential, fetchImpl });
    const book = await readBackpackTopOfBook({ credential, fetchImpl });
    assert.deepEqual(account, {
      version: 1,
      venue_id: "backpack",
      network: "mainnet",
      symbol: "SOL_USDC_PERP",
      status: "ready_to_trade",
      position_size: "-0.14",
      open_order_count: 1,
      net_equity_available: "23.75",
      checked_at: account.checked_at,
    });
    assert.deepEqual(book, { bid: 75.7, ask: 75.72, checked_at: book.checked_at });
    assert.deepEqual(requests.sort(), [
      "/api/v1/account",
      "/api/v1/capital/collateral",
      "/api/v1/depth",
      "/api/v1/orders",
      "/api/v1/position",
    ]);
  });
});

function backpackCredential() {
  return {
    venueId: "backpack",
    network: "mainnet",
    apiKey: "test-api-key",
    privateSeed: new Uint8Array(32).fill(7),
    apiUrl: "https://api.backpack.exchange",
    allowedSymbols: ["SOL_USDC_PERP"],
    maxOrderNotionalUsd: 11,
    dailyNotionalCapUsd: 25,
    postOnlyMarketMaking: false,
  };
}
