import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import bs58 from "bs58";
import {
  AddressLookupTableAccount,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

const DEFAULT_JUPITER_SWAP_BASE_URL = "https://api.jup.ag/swap/v2";
const DEFAULT_JUPITER_TX_BASE_URL = "https://api.jup.ag/tx/v1";
const DEFAULT_SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EP1V8EYmRmxjTNjJcskK";
const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SPL_TOKEN_ACCOUNT_SIZE = 165;
const FEE_ACCOUNT_SETUP_FEE_BUFFER_LAMPORTS = 20_000;

export class JupiterSwapExecutionError extends Error {
  constructor(message, status = 502, code = "connector_submit_failed") {
    super(message);
    this.name = "JupiterSwapExecutionError";
    this.status = status;
    this.code = code;
  }
}

export function jupiterCredentialFromVault(vault) {
  if (!vault || typeof vault !== "object") {
    throw new JupiterSwapExecutionError("jupiter execution vault is invalid", 400, "venue_access_required");
  }
  if (vault.kind !== "ghola_solana_swap_execution_vault") {
    throw new JupiterSwapExecutionError("jupiter execution vault kind is invalid", 400, "venue_access_required");
  }
  const keypair = keypairFromSecret(
    vault.wallet_private_key ||
      vault.authority_private_key ||
      vault.secret_key ||
      vault.private_key,
  );
  const authority = keypair.publicKey.toBase58();
  if (vault.authority && String(vault.authority) !== authority) {
    throw new JupiterSwapExecutionError("jupiter vault authority mismatch", 400, "venue_access_required");
  }
  return {
    venueId: "jupiter",
    network: "mainnet",
    authority,
    keypair,
    swapBaseUrl: stringValue(vault.swap_api_url) ||
      stringValue(vault.api_url) ||
      process.env.PRIVATE_AGENT_JUPITER_SWAP_API_URL ||
      process.env.JUPITER_SWAP_API_URL ||
      DEFAULT_JUPITER_SWAP_BASE_URL,
    txBaseUrl: stringValue(vault.tx_api_url) ||
      process.env.PRIVATE_AGENT_JUPITER_TX_API_URL ||
      process.env.JUPITER_TX_API_URL ||
      DEFAULT_JUPITER_TX_BASE_URL,
  };
}

export function loadPooledJupiterCredential() {
  const raw = process.env.PRIVATE_AGENT_JUPITER_POOLED_VAULT_JSON ||
    process.env.PRIVATE_AGENT_SOLANA_SWAP_POOLED_VAULT_JSON ||
    readOptionalPath(process.env.PRIVATE_AGENT_JUPITER_POOLED_VAULT_PATH) ||
    readOptionalPath(process.env.PRIVATE_AGENT_SOLANA_SWAP_POOLED_VAULT_PATH);
  if (!raw && process.env.PRIVATE_AGENT_VENUE_DRY_RUN === "true") {
    const keypair = Keypair.generate();
    return {
      venueId: "jupiter",
      network: "mainnet",
      authority: keypair.publicKey.toBase58(),
      keypair,
      swapBaseUrl: DEFAULT_JUPITER_SWAP_BASE_URL,
      txBaseUrl: DEFAULT_JUPITER_TX_BASE_URL,
    };
  }
  if (!raw) {
    throw new JupiterSwapExecutionError("pooled Jupiter authority is unavailable", 503, "venue_access_required");
  }
  try {
    const parsed = JSON.parse(raw);
    return jupiterCredentialFromVault({
      kind: "ghola_solana_swap_execution_vault",
      network: "mainnet",
      ...parsed,
    });
  } catch (error) {
    if (error instanceof JupiterSwapExecutionError) throw error;
    throw new JupiterSwapExecutionError("pooled Jupiter authority is invalid JSON", 503, "venue_access_required");
  }
}

export async function submitJupiterSwapExecution({
  credential,
  instruction,
  clientOrderId,
  executionMode = "user_stealth",
  fetchImpl = fetch,
}) {
  const platformFee = jupiterPlatformFeeConfig(process.env, instruction.order);
  if (process.env.PRIVATE_AGENT_VENUE_DRY_RUN === "true") {
    return {
      status: statusForOperation(instruction.operation_class),
      provider_ref_seed: {
        venue: "jupiter",
        client_order_id: clientOrderId,
        execution_mode: executionMode,
        routing_mode: instruction.order?.routing_mode || null,
        platform_fee_bps: platformFee?.feeBps || 0,
        fee_account_commitment: platformFee?.feeAccountCommitment || null,
        dry_run: true,
      },
      result_seed: {
        kind: "jupiter_dry_run",
        routing_mode: instruction.order?.routing_mode || null,
        input_mint_commitment: mintCommitment(instruction.order?.input_mint),
        output_mint_commitment: mintCommitment(instruction.order?.output_mint),
        platform_fee_bps: platformFee?.feeBps || 0,
        fee_account_commitment: platformFee?.feeAccountCommitment || null,
      },
      fills: [],
      final_proof: jupiterFinalProof({
        status: "submitted",
        routingMode: instruction.order?.routing_mode || "meta_aggregator",
        signature: null,
        noSubmit: false,
        platformFee,
      }),
    };
  }

  assertJupiterLiveEnabled(instruction);
  try {
    const result = instruction.order.routing_mode === "router"
      ? await executeRouterSwap({ credential, instruction, fetchImpl })
      : await executeMetaAggregatorSwap({ credential, instruction, fetchImpl });
    return {
      status: result.status === "Success" || result.signature ? "submitted" : "failed",
      provider_ref_seed: {
        venue: "jupiter",
        client_order_id: clientOrderId,
        execution_mode: executionMode,
        routing_mode: instruction.order.routing_mode,
        request_id: result.requestId || null,
        signature: result.signature || null,
        platform_fee_bps: platformFee?.feeBps || 0,
        fee_account_commitment: platformFee?.feeAccountCommitment || null,
        fee_account_setup_signature_commitment: result.feeAccountSetupSignature
          ? commitment("jupiter_fee_account_setup_signature", result.feeAccountSetupSignature)
          : null,
      },
      result_seed: {
        kind: "jupiter_live_result",
        routing_mode: instruction.order.routing_mode,
        status: result.status || null,
        code: result.code ?? null,
        signature: result.signature || null,
        input_result_bucket: decimalBucket(result.inputAmountResult),
        output_result_bucket: decimalBucket(result.outputAmountResult),
        platform_fee_bps: platformFee?.feeBps || 0,
        fee_account_commitment: platformFee?.feeAccountCommitment || null,
        fee_account_setup_signature_commitment: result.feeAccountSetupSignature
          ? commitment("jupiter_fee_account_setup_signature", result.feeAccountSetupSignature)
          : null,
      },
      fills: result.signature ? [{ signature: result.signature, routing_mode: instruction.order.routing_mode }] : [],
      final_proof: jupiterFinalProof({
        status: result.status === "Success" || result.signature ? "submitted" : "failed",
        routingMode: instruction.order.routing_mode,
        signature: result.signature || null,
        requestId: result.requestId || null,
        noSubmit: false,
        platformFee,
        feeAccountSetupSignature: result.feeAccountSetupSignature || null,
      }),
    };
  } catch (error) {
    throw safeJupiterError(error);
  }
}

export async function verifyJupiterSwapNoSubmit({
  credential,
  instruction,
  clientOrderId,
  executionMode = "user_stealth",
  fetchImpl = fetch,
}) {
  const platformFee = jupiterPlatformFeeConfig(process.env, instruction.order);
  if (
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN === "true" ||
    process.env.PRIVATE_AGENT_JUPITER_NO_SUBMIT_LOCAL_CHECKS === "true"
  ) {
    return jupiterNoSubmitResult({
      instruction,
      clientOrderId,
      executionMode,
      orderBuilt: true,
      transactionBuilt: true,
      apiReachable: true,
      platformFee,
    });
  }

  assertJupiterLiveEnabled(instruction);
  try {
    const built = instruction.order.routing_mode === "router"
      ? await fetchJupiterBuild({ credential, instruction, fetchImpl })
      : await fetchJupiterOrder({ credential, instruction, fetchImpl });
    return jupiterNoSubmitResult({
      instruction,
      clientOrderId,
      executionMode,
      orderBuilt: Boolean(built),
      transactionBuilt: Boolean(built.transaction || built.swapInstruction),
      apiReachable: true,
      requestId: built.requestId || null,
      platformFee,
    });
  } catch (error) {
    throw safeJupiterError(error);
  }
}

function jupiterNoSubmitResult({
  instruction,
  clientOrderId,
  executionMode,
  orderBuilt,
  transactionBuilt,
  apiReachable,
  requestId = null,
  platformFee = null,
}) {
  return {
    status: "verified_no_funds",
    provider_ref_seed: {
      venue: "jupiter",
      client_order_id: clientOrderId,
      execution_mode: executionMode,
      routing_mode: instruction.order?.routing_mode || null,
      request_id: requestId,
      platform_fee_bps: platformFee?.feeBps || 0,
      fee_account_commitment: platformFee?.feeAccountCommitment || null,
      no_submit: true,
    },
    result_seed: {
      kind: "jupiter_no_submit_verification",
      routing_mode: instruction.order?.routing_mode || null,
      input_mint_commitment: mintCommitment(instruction.order?.input_mint),
      output_mint_commitment: mintCommitment(instruction.order?.output_mint),
      order_built: orderBuilt,
      transaction_built: transactionBuilt,
      platform_fee_bps: platformFee?.feeBps || 0,
      fee_account_commitment: platformFee?.feeAccountCommitment || null,
    },
    checks: {
      sealed_vault_opened: true,
      sealed_instruction_opened: true,
      authority_derived: true,
      policy_enforced: true,
      live_gate_enforced: true,
      rpc_reachable: false,
      phoenix_sdk_ready: false,
      order_packet_built: false,
      api_wallet_loaded: true,
      hyperliquid_api_reachable: false,
      hyperliquid_sdk_ready: false,
      account_read_checked: false,
      order_request_built: transactionBuilt,
      jupiter_api_reachable: apiReachable,
      jupiter_token_allowlist_passed: true,
      jupiter_order_built: orderBuilt,
      jupiter_transaction_built: transactionBuilt,
      transaction_broadcast: false,
    },
    final_proof: jupiterFinalProof({
      status: "verified_no_funds",
      routingMode: instruction.order?.routing_mode || "meta_aggregator",
      signature: null,
      requestId,
      noSubmit: true,
      platformFee,
    }),
  };
}

async function executeMetaAggregatorSwap({ credential, instruction, fetchImpl }) {
  const order = await fetchJupiterOrder({ credential, instruction, fetchImpl });
  if (!order.transaction || !order.requestId) {
    throw new JupiterSwapExecutionError("jupiter order did not include a signable transaction", 502);
  }
  const signedTransaction = signBase64Transaction(order.transaction, credential.keypair);
  const result = await fetchJson(fetchImpl, `${credential.swapBaseUrl}/execute`, {
    method: "POST",
    headers: jupiterHeaders({ json: true }),
    body: JSON.stringify({
      signedTransaction,
      requestId: order.requestId,
    }),
  });
  return {
    ...result,
    requestId: order.requestId,
  };
}

async function executeRouterSwap({ credential, instruction, fetchImpl }) {
  const feeAccountReadiness = await assertJupiterPlatformFeeAccountReady({
    order: instruction.order,
    fetchImpl,
    credential,
    allowCreate: true,
  });
  const built = await fetchJupiterBuild({
    credential,
    instruction,
    fetchImpl,
    feeAccountPrepared: true,
  });
  const transaction = buildRouterTransaction(built, credential.keypair);
  const signedTransaction = Buffer.from(transaction.serialize()).toString("base64");
  const result = await fetchJson(fetchImpl, `${credential.txBaseUrl}/submit`, {
    method: "POST",
    headers: jupiterHeaders({ json: true }),
    body: JSON.stringify({ signedTransaction }),
  });
  return {
    status: result.signature ? "Success" : "Failed",
    signature: result.signature || null,
    feeAccountSetupSignature: feeAccountReadiness.setupSignature || null,
    code: result.signature ? 0 : -1000,
  };
}

async function fetchJupiterOrder({ credential, instruction, fetchImpl }) {
  const params = jupiterOrderParams(instruction.order, credential.authority);
  const body = await fetchJson(fetchImpl, `${credential.swapBaseUrl}/order?${params.toString()}`, {
    headers: jupiterHeaders(),
  });
  if (body.error || body.errorCode) {
    throw new JupiterSwapExecutionError("jupiter order request failed", 422, "venue_rejected");
  }
  return body;
}

async function fetchJupiterBuild({ credential, instruction, fetchImpl, feeAccountPrepared = false }) {
  if (!feeAccountPrepared) {
    await assertJupiterPlatformFeeAccountReady({
      order: instruction.order,
      fetchImpl,
      allowPlannedSetup: true,
    });
  }
  const params = jupiterOrderParams(instruction.order, credential.authority);
  const body = await fetchJson(fetchImpl, `${credential.swapBaseUrl}/build?${params.toString()}`, {
    headers: jupiterHeaders(),
  });
  if (body.error || body.errorCode) {
    throw new JupiterSwapExecutionError("jupiter build request failed", 422, "venue_rejected");
  }
  return body;
}

function jupiterOrderParams(order, taker) {
  const params = new URLSearchParams({
    inputMint: order.input_mint,
    outputMint: order.output_mint,
    amount: order.amount,
    taker,
  });
  if (order.max_slippage_bps) params.set("slippageBps", order.max_slippage_bps);
  if (order.payer) params.set("payer", order.payer);
  const platformFee = jupiterPlatformFeeConfig(process.env, order);
  if (platformFee) {
    if (order.routing_mode !== "router") {
      throw new JupiterSwapExecutionError("jupiter platform fees require router routing_mode", 400, "venue_rejected");
    }
    params.set("platformFeeBps", String(platformFee.feeBps));
    params.set("feeAccount", platformFee.feeAccount);
  }
  return params;
}

export function jupiterPlatformFeeConfig(env = process.env, order = null) {
  const feeBps = integerEnvFrom(env, [
    "PRIVATE_AGENT_JUPITER_PLATFORM_FEE_BPS",
    "GHOLA_JUPITER_PLATFORM_FEE_BPS",
    "PRIVATE_AGENT_AUTOPILOT_JUPITER_FEE_BPS",
    "GHOLA_AUTOPILOT_JUPITER_FEE_BPS",
  ]);
  if (feeBps <= 0) return null;
  const maxFeeBps = integerEnvFrom(env, [
    "PRIVATE_AGENT_JUPITER_MAX_PLATFORM_FEE_BPS",
    "GHOLA_JUPITER_MAX_PLATFORM_FEE_BPS",
  ], 100);
  if (feeBps > Math.max(1, maxFeeBps)) {
    throw new JupiterSwapExecutionError("jupiter platform fee bps exceeds configured cap", 400, "venue_rejected");
  }
  const configuredFeeAccount = stringEnvFrom(env, [
    "PRIVATE_AGENT_JUPITER_FEE_ACCOUNT",
    "GHOLA_JUPITER_FEE_ACCOUNT",
    "PRIVATE_AGENT_AUTOPILOT_JUPITER_FEE_ACCOUNT",
    "GHOLA_AUTOPILOT_JUPITER_FEE_ACCOUNT",
  ]);
  const feeOwner = stringEnvFrom(env, [
    "PRIVATE_AGENT_JUPITER_FEE_OWNER",
    "GHOLA_JUPITER_FEE_OWNER",
    "PRIVATE_AGENT_AUTOPILOT_JUPITER_FEE_OWNER",
    "GHOLA_AUTOPILOT_JUPITER_FEE_OWNER",
  ]);
  const feeMint = stringEnvFrom(env, [
    "PRIVATE_AGENT_JUPITER_FEE_MINT",
    "GHOLA_JUPITER_FEE_MINT",
    "PRIVATE_AGENT_AUTOPILOT_JUPITER_FEE_MINT",
    "GHOLA_AUTOPILOT_JUPITER_FEE_MINT",
  ]) || stringValue(order?.fee_mint) || stringValue(order?.output_mint) || stringValue(order?.input_mint);
  const feeTokenProgram = stringEnvFrom(env, [
    "PRIVATE_AGENT_JUPITER_FEE_TOKEN_PROGRAM_ID",
    "GHOLA_JUPITER_FEE_TOKEN_PROGRAM_ID",
    "PRIVATE_AGENT_AUTOPILOT_JUPITER_FEE_TOKEN_PROGRAM_ID",
    "GHOLA_AUTOPILOT_JUPITER_FEE_TOKEN_PROGRAM_ID",
  ]) || SPL_TOKEN_PROGRAM_ID;
  let feeAccount = configuredFeeAccount;
  let derivedFeeAccount = "";
  if (feeOwner) {
    try {
      new PublicKey(feeOwner);
    } catch {
      throw new JupiterSwapExecutionError("jupiter fee owner is not a valid public key", 400, "venue_rejected");
    }
    if (!feeMint) {
      throw new JupiterSwapExecutionError("jupiter fee mint is required when deriving the fee account from an owner wallet", 503, "connector_submit_failed");
    }
    try {
      derivedFeeAccount = associatedTokenAddress({
        owner: feeOwner,
        mint: feeMint,
        tokenProgramId: feeTokenProgram,
      }).toBase58();
    } catch {
      throw new JupiterSwapExecutionError("jupiter fee owner, mint, or token program is invalid", 400, "venue_rejected");
    }
    if (!feeAccount) feeAccount = derivedFeeAccount;
  }
  if (!feeAccount) {
    throw new JupiterSwapExecutionError("jupiter fee account or fee owner is required when platform fee bps is configured", 503, "connector_submit_failed");
  }
  try {
    // This is a public SPL token account used by Jupiter for integrator fees.
    new PublicKey(feeAccount);
  } catch {
    throw new JupiterSwapExecutionError("jupiter fee account is not a valid public key", 400, "venue_rejected");
  }
  return {
    version: 1,
    revenue_model: "jupiter_integrator_fee",
    venue_id: "jupiter",
    feeBps,
    feeAccount,
    feeOwner: feeOwner || null,
    feeOwnerCommitment: feeOwner ? commitment("jupiter_fee_owner", feeOwner) : null,
    feeMint: feeMint || null,
    feeMintCommitment: feeMint ? commitment("jupiter_fee_mint", feeMint) : null,
    feeTokenProgram,
    feeAccountDerived: Boolean(derivedFeeAccount && feeAccount === derivedFeeAccount),
    feeAccountCreateMode: derivedFeeAccount && feeAccount === derivedFeeAccount
      ? "associated_token_account_idempotent"
      : null,
    feeAccountCommitment: commitment("jupiter_fee_account", feeAccount),
  };
}

export function jupiterPlatformFeeQuote({ notionalUsd, env = process.env } = {}) {
  const config = jupiterPlatformFeeConfig(env);
  if (!config) return null;
  const notional = Number(notionalUsd);
  const feeUsd = Number.isFinite(notional) && notional > 0
    ? Math.ceil(notional * 1_000_000 * config.feeBps / 10_000) / 1_000_000
    : 0;
  return {
    version: 1,
    revenue_model: config.revenue_model,
    venue_id: "jupiter",
    fee_bps: config.feeBps,
    notional_usd: notional,
    fee_usd: feeUsd,
    fee_recipient: "jupiter_fee_account",
    fee_recipient_commitment: config.feeAccountCommitment,
  };
}

export async function jupiterPlatformFeeAccountReadiness({
  env = process.env,
  fetchImpl = fetch,
  credential = null,
} = {}) {
  const platformFee = jupiterPlatformFeeConfig(env);
  if (!platformFee) {
    return {
      version: 1,
      status: "not_configured",
      ready: true,
      reason_codes: [],
    };
  }
  const base = {
    version: 1,
    revenue_model: platformFee.revenue_model,
    venue_id: "jupiter",
    fee_bps: platformFee.feeBps,
    fee_account_commitment: platformFee.feeAccountCommitment,
    fee_owner_commitment: platformFee.feeOwnerCommitment || null,
    fee_mint_commitment: platformFee.feeMintCommitment || null,
    fee_account_derived: platformFee.feeAccountDerived,
    fee_account_create_mode: platformFee.feeAccountCreateMode,
  };
  if (env.PRIVATE_AGENT_JUPITER_VALIDATE_FEE_ACCOUNT === "false") {
    return {
      ...base,
      status: "validation_skipped",
      ready: true,
      reason_codes: [],
    };
  }
  const rpcUrl = stringEnvFrom(env, [
    "PRIVATE_AGENT_SOLANA_RPC_URL",
    "GHOLA_SOLANA_RPC_URL",
    "SOLANA_RPC_URL",
  ]) || DEFAULT_SOLANA_RPC_URL;
  try {
    const value = await readSolanaAccountInfo({
      fetchImpl,
      rpcUrl,
      address: platformFee.feeAccount,
      id: "ghola-jupiter-fee-account-readiness",
    });
    if (value) {
      validateJupiterFeeAccount({
        value,
        platformFee,
        order: {
          input_mint: platformFee.feeMint,
          output_mint: platformFee.feeMint,
        },
      });
      return {
        ...base,
        status: "ready",
        ready: true,
        reason_codes: [],
        fee_account_initialized: true,
        setup_required: false,
      };
    }
    if (!platformFee.feeAccountCreateMode) {
      return {
        ...base,
        status: "missing",
        ready: false,
        reason_codes: ["jupiter_fee_account_not_initialized"],
        fee_account_initialized: false,
        setup_required: true,
      };
    }
    let payerCredential = credential;
    if (!payerCredential) {
      try {
        payerCredential = loadPooledJupiterCredential();
      } catch {
        return {
          ...base,
          status: "setup_blocked",
          ready: false,
          reason_codes: ["jupiter_fee_account_setup_payer_missing"],
          fee_account_initialized: false,
          setup_required: true,
        };
      }
    }
    const payer = payerCredential?.keypair?.publicKey;
    if (!payer) {
      return {
        ...base,
        status: "setup_blocked",
        ready: false,
        reason_codes: ["jupiter_fee_account_setup_payer_missing"],
        fee_account_initialized: false,
        setup_required: true,
      };
    }
    const [rentResult, balanceResult] = await Promise.all([
      solanaRpc(fetchImpl, rpcUrl, "getMinimumBalanceForRentExemption", [
        SPL_TOKEN_ACCOUNT_SIZE,
        { commitment: "confirmed" },
      ], "ghola-jupiter-fee-account-rent"),
      solanaRpc(fetchImpl, rpcUrl, "getBalance", [
        payer.toBase58(),
        { commitment: "confirmed" },
      ], "ghola-jupiter-fee-account-payer-balance"),
    ]);
    const rentLamports = Number(rentResult || 0);
    const balanceLamports = Number(balanceResult?.value || 0);
    const requiredLamports = Math.max(0, rentLamports) + FEE_ACCOUNT_SETUP_FEE_BUFFER_LAMPORTS;
    if (!Number.isFinite(balanceLamports) || balanceLamports < requiredLamports) {
      return {
        ...base,
        status: "needs_funds",
        ready: false,
        reason_codes: ["jupiter_fee_account_setup_payer_needs_sol"],
        fee_account_initialized: false,
        setup_required: true,
        payer_commitment: commitment("jupiter_fee_account_setup_payer", payer.toBase58()),
        payer_balance_lamports_bucket: lamportsBucket(balanceLamports),
        setup_required_lamports_bucket: lamportsBucket(requiredLamports),
      };
    }
    return {
      ...base,
      status: "setup_ready",
      ready: true,
      reason_codes: [],
      fee_account_initialized: false,
      setup_required: true,
      payer_commitment: commitment("jupiter_fee_account_setup_payer", payer.toBase58()),
      payer_balance_lamports_bucket: lamportsBucket(balanceLamports),
      setup_required_lamports_bucket: lamportsBucket(requiredLamports),
    };
  } catch (error) {
    return {
      ...base,
      status: error?.code === "needs_funds" ? "needs_funds" : "preflight_failed",
      ready: false,
      reason_codes: [
        error?.code === "needs_funds"
          ? "jupiter_fee_account_setup_payer_needs_sol"
          : "jupiter_fee_account_preflight_failed",
      ],
      fee_account_initialized: false,
      setup_required: Boolean(platformFee.feeAccountCreateMode),
      error_code: error?.code || "connector_submit_failed",
    };
  }
}

export async function assertJupiterPlatformFeeAccountReady({
  order,
  fetchImpl = fetch,
  env = process.env,
  credential = null,
  allowCreate = false,
  allowPlannedSetup = false,
} = {}) {
  const platformFee = jupiterPlatformFeeConfig(env, order);
  if (!platformFee) return { ok: true, skipped: true };
  if (env.PRIVATE_AGENT_JUPITER_VALIDATE_FEE_ACCOUNT === "false") {
    return { ok: true, skipped: true };
  }
  const rpcUrl = stringEnvFrom(env, [
    "PRIVATE_AGENT_SOLANA_RPC_URL",
    "GHOLA_SOLANA_RPC_URL",
    "SOLANA_RPC_URL",
  ]) || DEFAULT_SOLANA_RPC_URL;
  let value = await readSolanaAccountInfo({
    fetchImpl,
    rpcUrl,
    address: platformFee.feeAccount,
    id: "ghola-jupiter-fee-account",
  });
  if (!value) {
    if (platformFee.feeAccountCreateMode && allowCreate && credential?.keypair) {
      const setupSignature = await createJupiterFeeAssociatedTokenAccount({
        fetchImpl,
        rpcUrl,
        payer: credential.keypair,
        platformFee,
      });
      value = await waitForSolanaAccountInfo({
        fetchImpl,
        rpcUrl,
        address: platformFee.feeAccount,
        id: "ghola-jupiter-fee-account-created",
      });
      if (!value) {
        throw new JupiterSwapExecutionError("jupiter fee account initialization was submitted but not confirmed", 502, "connector_submit_failed");
      }
      return validateJupiterFeeAccount({
        value,
        platformFee,
        order,
        setupSignature,
      });
    }
    if (platformFee.feeAccountCreateMode && allowPlannedSetup) {
      return {
        ok: true,
        feeAccount: platformFee.feeAccount,
        mint: platformFee.feeMint,
        ownerProgram: platformFee.feeTokenProgram,
        setupRequired: true,
        setupMode: platformFee.feeAccountCreateMode,
      };
    }
    throw new JupiterSwapExecutionError("jupiter fee account is not initialized", 400, "venue_rejected");
  }
  return validateJupiterFeeAccount({
    value,
    platformFee,
    order,
  });
}

function validateJupiterFeeAccount({ value, platformFee, order, setupSignature = null }) {
  if (![SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].includes(String(value.owner || ""))) {
    throw new JupiterSwapExecutionError("jupiter fee account is not an SPL token account", 400, "venue_rejected");
  }
  const mint = value.data?.parsed?.info?.mint;
  if (!mint) {
    throw new JupiterSwapExecutionError("jupiter fee account mint is unavailable", 400, "venue_rejected");
  }
  const allowedMints = new Set([order?.input_mint, order?.output_mint].filter(Boolean));
  if (!allowedMints.has(mint)) {
    throw new JupiterSwapExecutionError("jupiter fee account mint is outside the swap pair", 400, "venue_rejected");
  }
  return {
    ok: true,
    feeAccount: platformFee.feeAccount,
    mint,
    ownerProgram: value.owner,
    setupSignature,
  };
}

async function readSolanaAccountInfo({ fetchImpl, rpcUrl, address, id }) {
  const result = await solanaRpc(fetchImpl, rpcUrl, "getAccountInfo", [
    address,
    { encoding: "jsonParsed" },
  ], id);
  return result?.value || null;
}

async function waitForSolanaAccountInfo({ fetchImpl, rpcUrl, address, id }) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const value = await readSolanaAccountInfo({
      fetchImpl,
      rpcUrl,
      address,
      id: `${id}-${attempt}`,
    });
    if (value) return value;
    if (attempt < 4) await sleep(500);
  }
  return null;
}

async function createJupiterFeeAssociatedTokenAccount({ fetchImpl, rpcUrl, payer, platformFee }) {
  const blockhashResult = await solanaRpc(fetchImpl, rpcUrl, "getLatestBlockhash", [
    { commitment: "confirmed" },
  ], "ghola-jupiter-fee-account-blockhash");
  const recentBlockhash = blockhashResult?.value?.blockhash;
  if (!recentBlockhash) {
    throw new JupiterSwapExecutionError("solana rpc did not return a blockhash for jupiter fee account setup", 502, "connector_submit_failed");
  }
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash,
    instructions: [
      createAssociatedTokenAccountIdempotentInstruction({
        payer: payer.publicKey,
        associatedToken: new PublicKey(platformFee.feeAccount),
        owner: new PublicKey(platformFee.feeOwner),
        mint: new PublicKey(platformFee.feeMint),
        tokenProgramId: new PublicKey(platformFee.feeTokenProgram),
      }),
    ],
  }).compileToV0Message());
  transaction.sign([payer]);
  const signature = await solanaRpc(fetchImpl, rpcUrl, "sendTransaction", [
    Buffer.from(transaction.serialize()).toString("base64"),
    {
      encoding: "base64",
      skipPreflight: false,
      maxRetries: 3,
      preflightCommitment: "confirmed",
    },
  ], "ghola-jupiter-fee-account-create");
  if (!signature || typeof signature !== "string") {
    throw new JupiterSwapExecutionError("solana rpc did not return a jupiter fee account setup signature", 502, "connector_submit_failed");
  }
  return signature;
}

function createAssociatedTokenAccountIdempotentInstruction({
  payer,
  associatedToken,
  owner,
  mint,
  tokenProgramId,
}) {
  return new TransactionInstruction({
    programId: new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedToken, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgramId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

async function solanaRpc(fetchImpl, rpcUrl, method, params, id) {
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.error) {
    const errorText = JSON.stringify(body?.error || {});
    if (/insufficient|not enough|funds|lamports|rent/i.test(errorText)) {
      throw new JupiterSwapExecutionError("jupiter account needs funds for fee account setup", 402, "needs_funds");
    }
    throw new JupiterSwapExecutionError(`solana rpc ${method} failed`, response.status || 502, "connector_submit_failed");
  }
  return body?.result;
}

function associatedTokenAddress({ owner, mint, tokenProgramId = SPL_TOKEN_PROGRAM_ID }) {
  return PublicKey.findProgramAddressSync(
    [
      new PublicKey(owner).toBuffer(),
      new PublicKey(tokenProgramId).toBuffer(),
      new PublicKey(mint).toBuffer(),
    ],
    new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
  )[0];
}

function signBase64Transaction(transaction, keypair) {
  const parsed = VersionedTransaction.deserialize(Buffer.from(transaction, "base64"));
  parsed.sign([keypair]);
  return Buffer.from(parsed.serialize()).toString("base64");
}

function buildRouterTransaction(build, keypair) {
  const instructions = [
    ...(build.computeBudgetInstructions || []),
    ...(build.setupInstructions || []),
    build.swapInstruction,
    ...(build.cleanupInstruction ? [build.cleanupInstruction] : []),
    ...(build.otherInstructions || []),
    ...(build.tipInstruction ? [build.tipInstruction] : []),
  ].filter(Boolean).map(jupiterInstruction);
  if (!instructions.length) {
    throw new JupiterSwapExecutionError("jupiter build did not include swap instructions", 502);
  }
  const recentBlockhash = blockhashString(build.blockhashWithMetadata?.blockhash || build.blockhash);
  if (!recentBlockhash) {
    throw new JupiterSwapExecutionError("jupiter build did not include a blockhash", 502);
  }
  const lookupTables = Object.entries(build.addressesByLookupTableAddress || {})
    .map(([key, addresses]) => lookupTableAccount(key, addresses));
  const message = new TransactionMessage({
    payerKey: keypair.publicKey,
    recentBlockhash,
    instructions,
  }).compileToV0Message(lookupTables);
  const transaction = new VersionedTransaction(message);
  transaction.sign([keypair]);
  return transaction;
}

function jupiterInstruction(instruction) {
  return new TransactionInstruction({
    programId: new PublicKey(String(instruction.programId)),
    keys: (instruction.accounts || []).map((account) => ({
      pubkey: new PublicKey(String(account.pubkey)),
      isSigner: account.isSigner === true,
      isWritable: account.isWritable === true,
    })),
    data: Buffer.from(String(instruction.data || ""), "base64"),
  });
}

function lookupTableAccount(key, addresses) {
  return new AddressLookupTableAccount({
    key: new PublicKey(key),
    state: {
      deactivationSlot: BigInt("0xffffffffffffffff"),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: null,
      addresses: Array.isArray(addresses) ? addresses.map((address) => new PublicKey(String(address))) : [],
    },
  });
}

function assertJupiterLiveEnabled(instruction) {
  if (process.env.PRIVATE_AGENT_JUPITER_LIVE_MODE !== "full") {
    throw new JupiterSwapExecutionError("jupiter live submit is disabled", 503, "connector_submit_failed");
  }
  if (!jupiterApiKey()) {
    throw new JupiterSwapExecutionError("jupiter api key is unavailable", 503, "connector_submit_failed");
  }
  const inputAllowlist = mintAllowlist("PRIVATE_AGENT_JUPITER_ALLOWED_INPUT_MINTS", "GHOLA_JUPITER_ALLOWED_INPUT_MINTS");
  const outputAllowlist = mintAllowlist("PRIVATE_AGENT_JUPITER_ALLOWED_OUTPUT_MINTS", "GHOLA_JUPITER_ALLOWED_OUTPUT_MINTS");
  if (!inputAllowlist.has(instruction.order.input_mint) || !outputAllowlist.has(instruction.order.output_mint)) {
    throw new JupiterSwapExecutionError("jupiter swap mint is outside allowlist", 400, "venue_rejected");
  }
  const slippage = Number.parseInt(instruction.order.max_slippage_bps || "50", 10);
  const maxSlippage = Math.min(
    capBps(
      process.env.PRIVATE_AGENT_JUPITER_MAX_SLIPPAGE_BPS ||
        process.env.GHOLA_JUPITER_MAX_SLIPPAGE_BPS ||
        process.env.GHOLA_LIVE_TRADING_MAX_SLIPPAGE_BPS,
      100,
    ),
    100,
  );
  if (!Number.isInteger(slippage) || slippage < 1 || slippage > maxSlippage) {
    throw new JupiterSwapExecutionError("jupiter slippage is outside policy", 400, "venue_rejected");
  }
  const notional = estimateSwapNotionalUsd(instruction.order);
  const maxNotional = Math.min(
    capUsd(
      process.env.PRIVATE_AGENT_JUPITER_LIVE_MAX_NOTIONAL_USD ||
        process.env.GHOLA_JUPITER_LIVE_MAX_NOTIONAL_USD,
      1_000,
    ),
    capUsd(process.env.PRIVATE_AGENT_LIVE_MAX_ORDER_NOTIONAL_USD || process.env.GHOLA_LIVE_TRADING_MAX_ORDER_NOTIONAL_USD, 1_000),
  );
  if (!Number.isFinite(notional) || notional <= 0) {
    throw new JupiterSwapExecutionError("jupiter swap notional must be positive", 400, "venue_rejected");
  }
  if (notional > maxNotional) {
    throw new JupiterSwapExecutionError("jupiter swap exceeds live notional cap", 400, "venue_rejected");
  }
}

async function fetchJson(fetchImpl, url, init = {}) {
  const response = await fetchImpl(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new JupiterSwapExecutionError("jupiter api request failed", response.status, response.status === 401 ? "venue_access_required" : "connector_submit_failed");
  }
  return body;
}

function jupiterHeaders({ json = false } = {}) {
  return {
    ...(json ? { "content-type": "application/json" } : {}),
    "x-api-key": jupiterApiKey(),
  };
}

function jupiterApiKey() {
  return process.env.PRIVATE_AGENT_JUPITER_API_KEY ||
    process.env.JUPITER_API_KEY ||
    process.env.GHOLA_JUPITER_API_KEY ||
    "";
}

function mintAllowlist(primary, fallback) {
  const configured = process.env[primary] || process.env[fallback] || "";
  const values = configured
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!values.length && process.env.NODE_ENV === "production") {
    throw new JupiterSwapExecutionError("jupiter mint allowlist is not configured", 503, "connector_submit_failed");
  }
  return new Set(values.length ? values : [SOL_MINT, USDC_MINT]);
}

function keypairFromSecret(value) {
  const bytes = secretBytes(value);
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  throw new JupiterSwapExecutionError("jupiter wallet key must be 32-byte seed or 64-byte secret key", 400, "venue_access_required");
}

function secretBytes(value) {
  if (Array.isArray(value)) return Uint8Array.from(value.map((item) => Number(item)));
  const text = stringValue(value);
  if (!text) {
    throw new JupiterSwapExecutionError("jupiter wallet key is missing", 400, "venue_access_required");
  }
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return Uint8Array.from(parsed.map((item) => Number(item)));
    } catch {
      throw new JupiterSwapExecutionError("jupiter wallet key JSON is invalid", 400, "venue_access_required");
    }
  }
  const cleanHex = text.startsWith("0x") ? text.slice(2) : text;
  if (/^[0-9a-fA-F]{64}$/.test(cleanHex) || /^[0-9a-fA-F]{128}$/.test(cleanHex)) {
    return Uint8Array.from(Buffer.from(cleanHex, "hex"));
  }
  try {
    return bs58.decode(text);
  } catch {
    throw new JupiterSwapExecutionError("jupiter wallet key encoding is unsupported", 400, "venue_access_required");
  }
}

function safeJupiterError(error) {
  if (error instanceof JupiterSwapExecutionError) return error;
  const message = String(error?.message || "jupiter swap failed");
  if (/401|403|auth|access|permission|unauthorized/i.test(message)) {
    return new JupiterSwapExecutionError("jupiter venue access was rejected", 400, "venue_access_required");
  }
  if (/insufficient|not enough|funds|lamports|balance|gas/i.test(message)) {
    return new JupiterSwapExecutionError("jupiter account needs funds", 402, "needs_funds");
  }
  if (/slippage|rejected|failed|expired|blockhash/i.test(message)) {
    return new JupiterSwapExecutionError("jupiter swap was rejected", 422, "venue_rejected");
  }
  return new JupiterSwapExecutionError("jupiter swap failed", 502, "connector_submit_failed");
}

function jupiterFinalProof({
  status,
  routingMode,
  signature,
  requestId = null,
  noSubmit,
  platformFee = null,
  feeAccountSetupSignature = null,
}) {
  return {
    version: 1,
    proof_kind: "jupiter_swap_execution_proof_v1",
    status,
    venue_id: "jupiter",
    routing_mode: routingMode,
    integrator_fee_bps: platformFee?.feeBps || 0,
    fee_account_commitment: platformFee?.feeAccountCommitment || null,
    fee_owner_commitment: platformFee?.feeOwnerCommitment || null,
    fee_mint_commitment: platformFee?.feeMintCommitment || null,
    fee_account_setup_mode: platformFee?.feeAccountCreateMode || null,
    fee_account_setup_signature_commitment: feeAccountSetupSignature
      ? commitment("jupiter_fee_account_setup_signature", feeAccountSetupSignature)
      : null,
    broadcast_performed: noSubmit ? false : Boolean(signature),
    final_venue_execution_proven: Boolean(signature),
    final_fill_proven: Boolean(signature),
    signature_commitment: signature ? commitment("jupiter_signature", signature) : null,
    request_commitment: requestId ? commitment("jupiter_request", requestId) : null,
    checked_at: new Date().toISOString(),
  };
}

function statusForOperation(operationClass) {
  if (operationClass === "reconcile") return "reconciled";
  if (operationClass === "read" || operationClass === "preview_order") return "previewed";
  return "submitted";
}

function readOptionalPath(path) {
  if (!path) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new JupiterSwapExecutionError("pooled Jupiter authority file is unreadable", 503, "venue_access_required");
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function blockhashString(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) return bs58.encode(Uint8Array.from(value.map((item) => Number(item))));
  return "";
}

function capBps(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function capUsd(value, fallback) {
  const parsed = Number.parseFloat(String(value || ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function integerEnvFrom(env, names, fallback = 0) {
  for (const name of names) {
    const value = Number.parseInt(String(env[name] ?? ""), 10);
    if (Number.isInteger(value) && value >= 0) return value;
  }
  return fallback;
}

function stringEnvFrom(env, names) {
  for (const name of names) {
    const value = stringValue(env[name]);
    if (value) return value;
  }
  return "";
}

function estimateSwapNotionalUsd(order) {
  const quote = Number.parseFloat(order?.quote_size || "");
  return Number.isFinite(quote) && quote > 0 ? quote : 0;
}

function decimalBucket(value) {
  const number = Number.parseFloat(String(value || "0"));
  if (!Number.isFinite(number) || number <= 0) return "0";
  if (number < 1) return "<1";
  if (number < 5) return "1-5";
  if (number < 25) return "5-25";
  if (number < 100) return "25-100";
  return "100+";
}

function lamportsBucket(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return "0";
  if (number < 100_000) return "<0.0001_SOL";
  if (number < 1_000_000) return "0.0001-0.001_SOL";
  if (number < 10_000_000) return "0.001-0.01_SOL";
  if (number < 100_000_000) return "0.01-0.1_SOL";
  return ">=0.1_SOL";
}

function mintCommitment(value) {
  return value ? commitment("jupiter_mint", String(value)) : null;
}

function commitment(prefix, value) {
  return `${prefix}_${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 48)}`;
}

function stringValue(value) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}
