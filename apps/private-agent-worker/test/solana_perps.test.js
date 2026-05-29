import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import {
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
});
