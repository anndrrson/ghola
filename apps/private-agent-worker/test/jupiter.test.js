import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  jupiterPlatformFeeAccountReadiness,
  submitJupiterSwapExecution,
  verifyJupiterSwapNoSubmit,
} from "../src/venues/jupiter.js";
import { Keypair } from "@solana/web3.js";

const OLD_ENV = { ...process.env };
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PHANTOM_OWNER = "Fbw73e5YfhivsTeFud97CFBZc5bZ2PbdDVgcgfYRSgwJ";
const FEE_ACCOUNT = "GqUaEYZbAQ4r4JmXPfFRSK3x1nGhf5AUFqzmrwb8mHx8";
const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

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

  it("adds configured Jupiter platform fees to no-submit order requests", async () => {
    process.env.PRIVATE_AGENT_JUPITER_PLATFORM_FEE_BPS = "12";
    process.env.PRIVATE_AGENT_JUPITER_FEE_ACCOUNT = FEE_ACCOUNT;
    let requestedUrl = "";

    const result = await verifyJupiterSwapNoSubmit({
      credential: {
        authority: "authority",
        swapBaseUrl: "https://jupiter.example/swap/v2",
      },
      clientOrderId: "jupiter_fee_quote",
      instruction: {
        version: 1,
        venue_id: "jupiter",
        operation_class: "swap",
        order: {
          input_mint: SOL_MINT,
          output_mint: USDC_MINT,
          amount: "1000000",
          quote_size: "25",
          max_slippage_bps: "50",
          routing_mode: "router",
        },
      },
      fetchImpl: async (url) => {
        if (String(url) === "https://api.mainnet-beta.solana.com") {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            result: {
              value: {
                owner: SPL_TOKEN_PROGRAM,
                data: {
                  parsed: {
                    info: {
                      mint: USDC_MINT,
                    },
                  },
                },
              },
            },
            id: "ghola-jupiter-fee-account",
          }), { status: 200 });
        }
        requestedUrl = String(url);
        return new Response(JSON.stringify({
          swapInstruction: {
            programId: "11111111111111111111111111111111",
            accounts: [],
            data: "",
          },
          requestId: "jupiter-request-fee",
        }), { status: 200 });
      },
    });

    const params = new URL(requestedUrl).searchParams;
    assert.equal(params.get("platformFeeBps"), "12");
    assert.equal(params.get("feeAccount"), FEE_ACCOUNT);
    assert.equal(result.final_proof.integrator_fee_bps, 12);
    assert.match(result.final_proof.fee_account_commitment, /^jupiter_fee_account_/);
  });

  it("derives a Jupiter fee token account from the configured Phantom owner", async () => {
    process.env.PRIVATE_AGENT_JUPITER_PLATFORM_FEE_BPS = "12";
    process.env.PRIVATE_AGENT_JUPITER_FEE_OWNER = PHANTOM_OWNER;
    process.env.PRIVATE_AGENT_JUPITER_FEE_MINT = USDC_MINT;
    let requestedUrl = "";

    const result = await verifyJupiterSwapNoSubmit({
      credential: {
        authority: "authority",
        swapBaseUrl: "https://jupiter.example/swap/v2",
      },
      clientOrderId: "jupiter_fee_owner_quote",
      instruction: {
        version: 1,
        venue_id: "jupiter",
        operation_class: "swap",
        order: {
          input_mint: SOL_MINT,
          output_mint: USDC_MINT,
          amount: "1000000",
          quote_size: "25",
          max_slippage_bps: "50",
          routing_mode: "router",
        },
      },
      fetchImpl: async (url) => {
        if (String(url) === "https://api.mainnet-beta.solana.com") {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            result: {
              value: {
                owner: SPL_TOKEN_PROGRAM,
                data: {
                  parsed: {
                    info: {
                      mint: USDC_MINT,
                    },
                  },
                },
              },
            },
            id: "ghola-jupiter-fee-account",
          }), { status: 200 });
        }
        requestedUrl = String(url);
        return new Response(JSON.stringify({
          swapInstruction: {
            programId: "11111111111111111111111111111111",
            accounts: [],
            data: "",
          },
          requestId: "jupiter-request-fee-owner",
        }), { status: 200 });
      },
    });

    const params = new URL(requestedUrl).searchParams;
    assert.equal(params.get("platformFeeBps"), "12");
    assert.equal(params.get("feeAccount"), FEE_ACCOUNT);
    assert.equal(result.final_proof.integrator_fee_bps, 12);
    assert.match(result.final_proof.fee_account_commitment, /^jupiter_fee_account_/);
    assert.match(result.final_proof.fee_owner_commitment, /^jupiter_fee_owner_/);
    assert.equal(result.final_proof.fee_account_setup_mode, "associated_token_account_idempotent");
  });

  it("preflights a missing derived Jupiter fee token account as setup-ready when the payer has SOL", async () => {
    process.env.PRIVATE_AGENT_JUPITER_PLATFORM_FEE_BPS = "12";
    process.env.PRIVATE_AGENT_JUPITER_FEE_OWNER = PHANTOM_OWNER;
    process.env.PRIVATE_AGENT_JUPITER_FEE_MINT = USDC_MINT;
    const credential = { keypair: Keypair.generate() };

    const readiness = await jupiterPlatformFeeAccountReadiness({
      credential,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body || "{}"));
        if (body.method === "getAccountInfo") {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            result: { value: null },
            id: body.id,
          }), { status: 200 });
        }
        if (body.method === "getMinimumBalanceForRentExemption") {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            result: 2_039_280,
            id: body.id,
          }), { status: 200 });
        }
        if (body.method === "getBalance") {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            result: { value: 10_000_000 },
            id: body.id,
          }), { status: 200 });
        }
        throw new Error(`unexpected RPC method ${body.method}`);
      },
    });

    assert.equal(readiness.status, "setup_ready");
    assert.equal(readiness.ready, true);
    assert.equal(readiness.setup_required, true);
    assert.deepEqual(readiness.reason_codes, []);
    assert.match(readiness.payer_commitment, /^jupiter_fee_account_setup_payer_/);
  });

  it("blocks derived Jupiter fee token account setup when the payer lacks SOL", async () => {
    process.env.PRIVATE_AGENT_JUPITER_PLATFORM_FEE_BPS = "12";
    process.env.PRIVATE_AGENT_JUPITER_FEE_OWNER = PHANTOM_OWNER;
    process.env.PRIVATE_AGENT_JUPITER_FEE_MINT = USDC_MINT;
    const credential = { keypair: Keypair.generate() };

    const readiness = await jupiterPlatformFeeAccountReadiness({
      credential,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body || "{}"));
        if (body.method === "getAccountInfo") {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            result: { value: null },
            id: body.id,
          }), { status: 200 });
        }
        if (body.method === "getMinimumBalanceForRentExemption") {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            result: 2_039_280,
            id: body.id,
          }), { status: 200 });
        }
        if (body.method === "getBalance") {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            result: { value: 1_000 },
            id: body.id,
          }), { status: 200 });
        }
        throw new Error(`unexpected RPC method ${body.method}`);
      },
    });

    assert.equal(readiness.status, "needs_funds");
    assert.equal(readiness.ready, false);
    assert.deepEqual(readiness.reason_codes, ["jupiter_fee_account_setup_payer_needs_sol"]);
  });

  it("creates a derived Jupiter fee token account before the first live router swap", async () => {
    process.env.PRIVATE_AGENT_JUPITER_PLATFORM_FEE_BPS = "12";
    process.env.PRIVATE_AGENT_JUPITER_FEE_OWNER = PHANTOM_OWNER;
    process.env.PRIVATE_AGENT_JUPITER_FEE_MINT = USDC_MINT;
    const keypair = Keypair.generate();
    const rpcMethods = [];
    const jupiterCalls = [];
    let feeAccountCreated = false;

    const result = await submitJupiterSwapExecution({
      credential: {
        authority: keypair.publicKey.toBase58(),
        keypair,
        swapBaseUrl: "https://jupiter.example/swap/v2",
        txBaseUrl: "https://jupiter.example/tx/v1",
      },
      clientOrderId: "jupiter_fee_owner_live",
      instruction: {
        version: 1,
        venue_id: "jupiter",
        operation_class: "swap",
        order: {
          input_mint: SOL_MINT,
          output_mint: USDC_MINT,
          amount: "1000000",
          quote_size: "25",
          max_slippage_bps: "50",
          routing_mode: "router",
        },
      },
      fetchImpl: async (url, init) => {
        if (String(url) === "https://api.mainnet-beta.solana.com") {
          const body = JSON.parse(String(init?.body || "{}"));
          rpcMethods.push(body.method);
          if (body.method === "getAccountInfo") {
            return new Response(JSON.stringify({
              jsonrpc: "2.0",
              result: {
                value: feeAccountCreated
                  ? {
                      owner: SPL_TOKEN_PROGRAM,
                      data: {
                        parsed: {
                          info: {
                            mint: USDC_MINT,
                          },
                        },
                      },
                    }
                  : null,
              },
              id: body.id,
            }), { status: 200 });
          }
          if (body.method === "getLatestBlockhash") {
            return new Response(JSON.stringify({
              jsonrpc: "2.0",
              result: {
                value: {
                  blockhash: "11111111111111111111111111111111",
                  lastValidBlockHeight: 1,
                },
              },
              id: body.id,
            }), { status: 200 });
          }
          if (body.method === "sendTransaction") {
            assert.equal(typeof body.params[0], "string");
            feeAccountCreated = true;
            return new Response(JSON.stringify({
              jsonrpc: "2.0",
              result: "jupiter_fee_setup_signature",
              id: body.id,
            }), { status: 200 });
          }
        }
        jupiterCalls.push(String(url));
        if (String(url).startsWith("https://jupiter.example/swap/v2/build")) {
          return new Response(JSON.stringify({
            blockhash: "11111111111111111111111111111111",
            swapInstruction: {
              programId: "11111111111111111111111111111111",
              accounts: [],
              data: "",
            },
          }), { status: 200 });
        }
        if (String(url) === "https://jupiter.example/tx/v1/submit") {
          return new Response(JSON.stringify({
            signature: "jupiter_swap_signature",
          }), { status: 200 });
        }
        throw new Error(`unexpected fetch ${String(url)}`);
      },
    });

    assert.deepEqual(rpcMethods, [
      "getAccountInfo",
      "getLatestBlockhash",
      "sendTransaction",
      "getAccountInfo",
    ]);
    assert.equal(new URL(jupiterCalls[0]).searchParams.get("feeAccount"), FEE_ACCOUNT);
    assert.equal(result.status, "submitted");
    assert.match(result.final_proof.fee_account_setup_signature_commitment, /^jupiter_fee_account_setup_signature_/);
    assert.match(result.provider_ref_seed.fee_account_setup_signature_commitment, /^jupiter_fee_account_setup_signature_/);
  });

  it("fails closed when the configured Jupiter fee account is not initialized", async () => {
    process.env.PRIVATE_AGENT_JUPITER_PLATFORM_FEE_BPS = "12";
    process.env.PRIVATE_AGENT_JUPITER_FEE_ACCOUNT = FEE_ACCOUNT;

    await assert.rejects(
      () => verifyJupiterSwapNoSubmit({
        credential: {
          authority: "authority",
          swapBaseUrl: "https://jupiter.example/swap/v2",
        },
        clientOrderId: "jupiter_fee_account_missing",
        instruction: {
          version: 1,
          venue_id: "jupiter",
          operation_class: "swap",
          order: {
            input_mint: SOL_MINT,
            output_mint: USDC_MINT,
            amount: "1000000",
            quote_size: "25",
            max_slippage_bps: "50",
            routing_mode: "router",
          },
        },
        fetchImpl: async (url) => {
          if (String(url) === "https://api.mainnet-beta.solana.com") {
            return new Response(JSON.stringify({
              jsonrpc: "2.0",
              result: { value: null },
              id: "ghola-jupiter-fee-account",
            }), { status: 200 });
          }
          throw new Error("jupiter build should not be called");
        },
      }),
      /fee account is not initialized/,
    );
  });

  it("fails closed when platform fee bps is set without a fee account", async () => {
    process.env.PRIVATE_AGENT_JUPITER_PLATFORM_FEE_BPS = "12";
    delete process.env.PRIVATE_AGENT_JUPITER_FEE_ACCOUNT;

    await assert.rejects(
      () => verifyJupiterSwapNoSubmit({
        credential: {
          authority: "authority",
          swapBaseUrl: "https://jupiter.example/swap/v2",
        },
        clientOrderId: "jupiter_fee_missing_account",
        instruction: {
          version: 1,
          venue_id: "jupiter",
          operation_class: "swap",
          order: {
            input_mint: SOL_MINT,
            output_mint: USDC_MINT,
            amount: "1000000",
            quote_size: "25",
            max_slippage_bps: "50",
            routing_mode: "meta_aggregator",
          },
        },
        fetchImpl: async () => {
          throw new Error("fetch should not be called");
        },
      }),
      /fee account/,
    );
  });
});
