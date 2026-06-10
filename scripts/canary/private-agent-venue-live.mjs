#!/usr/bin/env node
import { createHash, createHmac, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
loadEnvFile(process.env.GHOLA_PRIVATE_AGENT_STAGING_ENV || `${ROOT}/.dev/private-agent-staging.env`);

const {
  bytesToBase64,
  didKeyFromVerifying,
  hexToBytes,
  sealForTest,
} = await import(pathToFileURL(`${ROOT}/apps/private-agent-worker/src/crypto/envelope.js`).href);

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const senderPublic = new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
const senderDid = didKeyFromVerifying(senderPublic);

const workerUrl = env("PRIVATE_AGENT_WORKER_URL") ||
  env("GHOLA_PRIVATE_AGENT_EXECUTION_URL") ||
  env("PHALA_AGENT_ENDPOINT");
const token = env("PRIVATE_AGENT_EXECUTION_TOKEN") ||
  env("GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN");
const workerCapabilitySecret = env("PRIVATE_AGENT_WORKER_CAPABILITY_SECRET") ||
  env("GHOLA_WORKER_CAPABILITY_SECRET");
const venue = env("GHOLA_CANARY_VENUE", "hyperliquid");
const live = boolEnv("GHOLA_RUN_LIVE_VENUE_CANARY");
const submitOrder = boolEnv("GHOLA_CANARY_SUBMIT_ORDER");
const riskAck = boolEnv("GHOLA_CANARY_ACK_TINY_ORDER_RISK");
const canaryLiveMode = env("GHOLA_CANARY_LIVE_MODE", "full_ticket");
const canaryId = `canary_${Date.now()}_${Math.random().toString(16).slice(2)}`;
const DUMMY_COINBASE_PRIVATE_KEY = [
  "-----BEGIN EC PRIVATE KEY-----",
  "MHcCAQEEIGvY6aoo2dGd5dbwG7Hz3Tj8MwbD0QuR4APs8dP8s91BoAoGCCqGSM49",
  "AwEHoUQDQgAEUxJ3vyaSbfNuLS9wEVxAIUlA7PAwHFrs4zSj34tpf8jEABERLQzt",
  "Bmg+ObHTkW0HnqRyx5m8lxbvqD8AqXjp3w==",
  "-----END EC PRIVATE KEY-----",
].join("\n");
const JUPITER_SOL_MINT = "So11111111111111111111111111111111111111112";
const JUPITER_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

if (!workerUrl) fail("PRIVATE_AGENT_WORKER_URL or GHOLA_PRIVATE_AGENT_EXECUTION_URL is required");
if (!token && !workerCapabilitySecret) {
  fail("PRIVATE_AGENT_EXECUTION_TOKEN, GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN, PRIVATE_AGENT_WORKER_CAPABILITY_SECRET, or GHOLA_WORKER_CAPABILITY_SECRET is required");
}
if (submitOrder && !riskAck) {
  fail("set GHOLA_CANARY_ACK_TINY_ORDER_RISK=1 before submitting a live canary order");
}
if (canaryLiveMode !== "full_ticket" && canaryLiveMode !== "tiny_fill") {
  fail("GHOLA_CANARY_LIVE_MODE must be full_ticket or tiny_fill");
}

if (!live) {
  console.log("[venue-canary] local dry-run credential mode; worker should have PRIVATE_AGENT_VENUE_DRY_RUN=true");
}

const recipient = await getRecipient();
console.log(`[venue-canary] worker=${trimUrl(workerUrl)} recipient=${recipient.recipient_id}`);

let canaryReport = null;
if (venue === "hyperliquid") {
  canaryReport = await runHyperliquid();
} else if (venue === "hyperliquid_managed_testnet") {
  canaryReport = await runHyperliquid({ executionMode: "managed_testnet" });
} else if (venue === "hyperliquid_pooled") {
  canaryReport = await runHyperliquid({ executionMode: "ghola_pooled" });
} else if (venue === "phoenix") {
  canaryReport = await runPhoenix();
} else if (venue === "phoenix_pooled") {
  canaryReport = await runPhoenix({ executionMode: "ghola_pooled" });
} else if (venue === "coinbase_byo") {
  canaryReport = await runCoinbaseByo();
} else if (venue === "coinbase_omnibus") {
  canaryReport = await runCoinbaseOmnibus();
} else if (venue === "jupiter") {
  canaryReport = await runJupiter();
} else if (venue === "jupiter_pooled") {
  canaryReport = await runJupiter({ executionMode: "ghola_pooled" });
} else {
  fail(`unsupported GHOLA_CANARY_VENUE: ${venue}`);
}

if (canaryReport) {
  await postCanaryReport(canaryReport);
} else if (boolEnv("GHOLA_CANARY_REPORT_REQUIRED")) {
  fail("canary report was required but this run did not submit a full-ticket live canary");
}

console.log(`[venue-canary] ${venue} canary passed`);

async function runHyperliquid({ executionMode = env("GHOLA_CANARY_HYPERLIQUID_EXECUTION_MODE", "byo_api_key") } = {}) {
  const pooled = executionMode === "ghola_pooled";
  const managed = executionMode === "managed_testnet";
  const usesManagedAllocation = pooled || managed;
  const network = env("GHOLA_CANARY_HYPERLIQUID_NETWORK", pooled ? "mainnet" : "testnet");
  const accountAddress = !usesManagedAllocation && live
    ? required("GHOLA_CANARY_HYPERLIQUID_ACCOUNT_ADDRESS")
    : "0x0000000000000000000000000000000000000001";
  const apiWalletPrivateKey = !usesManagedAllocation && live
    ? required("GHOLA_CANARY_HYPERLIQUID_API_WALLET_PRIVATE_KEY")
    : "0x1111111111111111111111111111111111111111111111111111111111111111";
  const market = env("GHOLA_CANARY_HYPERLIQUID_MARKET", "BTC").toUpperCase();
  const side = env("GHOLA_CANARY_HYPERLIQUID_SIDE", "buy").toLowerCase();
  const quoteSize = env("GHOLA_CANARY_HYPERLIQUID_QUOTE_SIZE", "5");
  const limitPrice = env("GHOLA_CANARY_HYPERLIQUID_LIMIT_PRICE");
  const maxSlippageBps = env("GHOLA_CANARY_HYPERLIQUID_MAX_SLIPPAGE_BPS", "50");
  if (submitOrder && canaryLiveMode === "tiny_fill") {
    assertTinyFillCanarySize(quoteSize);
  } else if (submitOrder) {
    assertFullTicketCanarySize(quoteSize, "GHOLA_CANARY_HYPERLIQUID_QUOTE_SIZE");
  }
  const accountCommitment = commitment("hyperliquid_account", { canaryId, network });
  const vaultCommitment = commitment("hyperliquid_vault", { accountCommitment, network });
  const policyCommitment = commitment("hyperliquid_policy", { canaryId, market });
  const eligibilityCommitment = commitment("hyperliquid_eligibility", { canaryId, network });
  const sessionPolicy = {
    market_allowlist: [market],
    max_notional_bucket: env("GHOLA_CANARY_MAX_NOTIONAL_BUCKET", "25"),
    max_daily_notional_bucket: env("GHOLA_CANARY_DAILY_CAP_USD", "5000"),
    max_order_count: 10,
    kill_switch: false,
  };
  let encryptedVault = null;
  let allocationCommitment = "";
  if (usesManagedAllocation) {
    const allocation = await expect(
      managed ? "hyperliquid managed testnet allocation" : "hyperliquid pooled allocation",
      "/hyperliquid/managed/allocations",
      201,
      {
      version: 1,
      execution_mode: managed ? "managed_testnet" : "ghola_pooled",
      network,
      account_commitment: accountCommitment,
      policy_commitment: policyCommitment,
      eligibility_commitment: eligibilityCommitment,
      session_policy: sessionPolicy,
      },
    );
    allocationCommitment = allocation.allocation_commitment;
    if (!allocationCommitment) fail("hyperliquid managed allocation did not return allocation_commitment");
  } else {
    encryptedVault = await sealedBundle({
      version: 1,
      kind: "ghola_hyperliquid_execution_vault",
      network,
      hyperliquid_account_address: accountAddress,
      api_wallet_private_key: apiWalletPrivateKey,
      allowed_operations: ["read", "limit_order", "cancel", "reconcile"],
      blocked_operations: ["withdraw", "vault_transfer", "leverage_escalation"],
    }, [
      "ghola/hyperliquid-execution-vault-v1",
      `account:${accountCommitment}`,
      `recipient:${recipient.recipient_id}`,
      `network:${network}`,
    ].join("|"));
  }

  await expect("hyperliquid session", "/hyperliquid/sessions", 201, stripUndefined({
    version: 1,
    execution_mode: usesManagedAllocation ? executionMode : "byo_api_key",
    account_commitment: accountCommitment,
    vault_commitment: usesManagedAllocation ? undefined : vaultCommitment,
    managed_allocation_commitment: usesManagedAllocation ? allocationCommitment : undefined,
    policy_commitment: policyCommitment,
    encrypted_execution_vault: usesManagedAllocation ? undefined : encryptedVault,
    session_policy: sessionPolicy,
  }));

  let orderResult = null;
  if (submitOrder) {
    const orderWork = commitment("work_order", { canaryId, venue, op: "order" });
    const order = canaryLiveMode === "tiny_fill"
      ? {
        market,
        side,
        quote_size: quoteSize,
        max_slippage_bps: maxSlippageBps,
        live_order_mode: "tiny_fill",
        tif: "Ioc",
      }
      : stripUndefined({
        market,
        side,
        quote_size: quoteSize,
        order_type: env("GHOLA_CANARY_HYPERLIQUID_ORDER_TYPE", "market"),
        limit_price: limitPrice || undefined,
        max_slippage_bps: maxSlippageBps,
        tif: "Ioc",
      });
    orderResult = await expect(
      canaryLiveMode === "tiny_fill" ? "hyperliquid tiny-fill IOC order" : "hyperliquid full-ticket order",
      "/hyperliquid/orders",
      202,
      stripUndefined({
        version: 1,
        execution_mode: usesManagedAllocation ? executionMode : "byo_api_key",
        work_order_commitment: orderWork,
        vault_commitment: usesManagedAllocation ? undefined : vaultCommitment,
        managed_allocation_commitment: usesManagedAllocation ? allocationCommitment : undefined,
        policy_commitment: policyCommitment,
        operation_class: "limit_order",
        encrypted_execution_vault: usesManagedAllocation ? undefined : encryptedVault,
        encrypted_execution_instruction_bundle: await instructionBundle({
          workOrderCommitment: orderWork,
          venueId: "hyperliquid",
          operationClass: "limit_order",
          order,
        }),
        session_policy: sessionPolicy,
      }),
    );
  } else if (managed) {
    const verifyWork = commitment("work_order", { canaryId, venue, op: "verify" });
    await expect("hyperliquid managed testnet no-submit verification", "/hyperliquid/verify", 200, {
      version: 1,
      execution_mode: "managed_testnet",
      work_order_commitment: verifyWork,
      managed_allocation_commitment: allocationCommitment,
      policy_commitment: policyCommitment,
      operation_class: "limit_order",
      encrypted_execution_instruction_bundle: await instructionBundle({
        workOrderCommitment: verifyWork,
        venueId: "hyperliquid",
        operationClass: "limit_order",
        order: {
          market,
          side,
          quote_size: quoteSize,
          max_slippage_bps: maxSlippageBps,
          live_order_mode: "tiny_fill",
          tif: "Ioc",
        },
      }),
      session_policy: sessionPolicy,
    }, {
      "x-ghola-no-submit-verify": "true",
    });
  }

  const reconcileWork = commitment("work_order", { canaryId, venue, op: "reconcile" });
  const reconcileResult = await expect("hyperliquid reconcile", "/hyperliquid/reconcile", 200, stripUndefined({
    version: 1,
    execution_mode: usesManagedAllocation ? executionMode : "byo_api_key",
    work_order_commitment: reconcileWork,
    vault_commitment: usesManagedAllocation ? undefined : vaultCommitment,
    managed_allocation_commitment: usesManagedAllocation ? allocationCommitment : undefined,
    policy_commitment: policyCommitment,
    encrypted_execution_vault: usesManagedAllocation ? undefined : encryptedVault,
    encrypted_execution_instruction_bundle: await instructionBundle({
      workOrderCommitment: reconcileWork,
      venueId: "hyperliquid",
      operationClass: "reconcile",
      reconcile: { market },
    }),
    session_policy: sessionPolicy,
  }));
  if (!submitOrder || canaryLiveMode !== "full_ticket") return null;
  return buildCanaryReport({
    venueId: "hyperliquid",
    network,
    orderResult,
    reconcileResult,
    orderNotionalUsd: Number(quoteSize),
    maxSlippageBps: Number(maxSlippageBps),
  });
}

async function runPhoenix({ executionMode = env("GHOLA_CANARY_PHOENIX_EXECUTION_MODE", "user_stealth") } = {}) {
  const pooled = executionMode === "ghola_pooled";
  const authorityPrivateKey = !pooled && live
    ? required("GHOLA_CANARY_PHOENIX_AUTHORITY_PRIVATE_KEY")
    : "11111111111111111111111111111111";
  const market = env("GHOLA_CANARY_PHOENIX_MARKET", "SOL").toUpperCase();
  const side = env("GHOLA_CANARY_PHOENIX_SIDE", "buy").toLowerCase();
  const quoteSize = env("GHOLA_CANARY_PHOENIX_QUOTE_SIZE", "5");
  const limitPrice = env("GHOLA_CANARY_PHOENIX_LIMIT_PRICE", "250");
  const maxSlippageBps = env("GHOLA_CANARY_PHOENIX_MAX_SLIPPAGE_BPS", "50");
  const accountCommitment = commitment("phoenix_account", { canaryId, market });
  const vaultCommitment = commitment("phoenix_vault", { accountCommitment, market });
  const allocationCommitment = commitment("phoenix_pooled_allocation", { canaryId, market });
  const policyCommitment = commitment("phoenix_policy", { canaryId, market });
  const sessionPolicy = {
    market_allowlist: [market],
    max_notional_bucket: env("GHOLA_CANARY_MAX_NOTIONAL_BUCKET", "25"),
    max_daily_notional_bucket: env("GHOLA_CANARY_DAILY_CAP_USD", "5000"),
    max_order_count: 10,
    kill_switch: false,
  };
  if (submitOrder && canaryLiveMode === "tiny_fill") {
    assertTinyFillCanarySize(quoteSize, "GHOLA_CANARY_PHOENIX_QUOTE_SIZE");
  } else if (submitOrder) {
    assertFullTicketCanarySize(quoteSize, "GHOLA_CANARY_PHOENIX_QUOTE_SIZE");
  }
  const encryptedVault = pooled ? null : await sealedBundle({
      version: 1,
      kind: "ghola_solana_perps_execution_vault",
      venue_id: "phoenix",
      network: "mainnet",
      execution_mode: "user_stealth",
      wallet_private_key: authorityPrivateKey,
      rpc_url: env("GHOLA_CANARY_SOLANA_RPC_URL") || env("PRIVATE_AGENT_SOLANA_RPC_URL") || null,
      api_url: env("GHOLA_CANARY_PHOENIX_API_URL") || null,
      trader_pda_index: Number.parseInt(env("GHOLA_CANARY_PHOENIX_TRADER_PDA_INDEX", "0"), 10),
      trader_subaccount_index: Number.parseInt(env("GHOLA_CANARY_PHOENIX_TRADER_SUBACCOUNT_INDEX", "0"), 10),
      allowed_operations: ["read", "perp_limit_order", "cancel", "fills", "reconcile"],
      blocked_operations: ["withdraw", "vault_transfer", "leverage_escalation", "staking", "raw_custody_transfer"],
    }, [
      "ghola/solana-perps-execution-vault-v1",
      `account:${accountCommitment}`,
      `recipient:${recipient.recipient_id}`,
      "mode:user_stealth",
      "network:mainnet",
      "venue:phoenix",
    ].join("|"));

  const orderWork = commitment("work_order", { canaryId, venue, op: "perp_limit_order" });
  const order = canaryLiveMode === "tiny_fill"
    ? {
      market,
      side,
      quote_size: quoteSize,
      limit_price: limitPrice,
      max_slippage_bps: maxSlippageBps,
      live_order_mode: "tiny_fill",
      tif: "Ioc",
    }
    : {
      market,
      side,
      quote_size: quoteSize,
      limit_price: limitPrice,
      max_slippage_bps: maxSlippageBps,
      order_type: "limit",
      tif: "Ioc",
    };
  const orderBody = stripUndefined({
      version: 1,
      venue_id: "phoenix",
      platform_class: "solana_perps_market",
      execution_mode: pooled ? "ghola_pooled" : "user_stealth",
      work_order_commitment: orderWork,
      vault_commitment: pooled ? undefined : vaultCommitment,
      allocation_commitment: pooled ? allocationCommitment : undefined,
      policy_commitment: policyCommitment,
      operation_class: "perp_limit_order",
      encrypted_execution_vault: pooled ? undefined : encryptedVault,
      encrypted_execution_instruction_bundle: await instructionBundle({
        workOrderCommitment: orderWork,
        venueId: "phoenix",
        operationClass: "perp_limit_order",
        order,
      }),
      session_policy: sessionPolicy,
    });
  const orderResult = submitOrder
    ? await expect(
      canaryLiveMode === "tiny_fill" ? "phoenix tiny-fill IOC order" : "phoenix full-ticket order",
      "/venues/solana-perps/orders",
      202,
      orderBody,
    )
    : await expect(
      "phoenix no-submit pooled verification",
      "/venues/solana-perps/verify",
      200,
      orderBody,
      {
        "x-ghola-no-submit-verify": "true",
      },
    );

  const reconcileWork = commitment("work_order", { canaryId, venue, op: "reconcile" });
  const reconcileResult = await expect("phoenix reconcile", "/venues/solana-perps/reconcile", 200, stripUndefined({
    version: 1,
    venue_id: "phoenix",
    platform_class: "solana_perps_market",
    execution_mode: pooled ? "ghola_pooled" : "user_stealth",
    work_order_commitment: reconcileWork,
    vault_commitment: pooled ? undefined : vaultCommitment,
    allocation_commitment: pooled ? allocationCommitment : undefined,
    policy_commitment: policyCommitment,
    encrypted_execution_vault: pooled ? undefined : encryptedVault,
    encrypted_execution_instruction_bundle: await instructionBundle({
      workOrderCommitment: reconcileWork,
      venueId: "phoenix",
      operationClass: "reconcile",
      reconcile: { market },
    }),
    session_policy: sessionPolicy,
  }));
  if (!submitOrder) {
    return buildCapitalFreeCanaryReport({
      venueId: "phoenix",
      network: "mainnet",
      orderResult,
      reconcileResult,
      orderNotionalUsd: Number(quoteSize),
      maxSlippageBps: Number(maxSlippageBps),
    });
  }
  if (canaryLiveMode !== "full_ticket") return null;
  return buildCanaryReport({
    venueId: "phoenix",
    network: "mainnet",
    orderResult,
    reconcileResult,
    orderNotionalUsd: Number(quoteSize),
    maxSlippageBps: Number(maxSlippageBps),
  });
}

async function runCoinbaseByo() {
  const network = env("GHOLA_CANARY_COINBASE_NETWORK", "sandbox");
  const apiKeyName = live
    ? required("GHOLA_CANARY_COINBASE_API_KEY_NAME")
    : "organizations/dry-run/apiKeys/dry-run";
  const apiPrivateKeyPem = live ? coinbasePrivateKeyPem() : DUMMY_COINBASE_PRIVATE_KEY;
  const productId = env("GHOLA_CANARY_COINBASE_PRODUCT_ID", "BTC-USD").toUpperCase();
  const side = env("GHOLA_CANARY_COINBASE_SIDE", "buy").toLowerCase();
  const baseSize = env("GHOLA_CANARY_COINBASE_BASE_SIZE", "0.001");
  const limitPrice = env("GHOLA_CANARY_COINBASE_LIMIT_PRICE", "10000");
  const accountCommitment = commitment("coinbase_account", { canaryId, network, mode: "byo" });
  const vaultCommitment = commitment("coinbase_vault", { accountCommitment, network });
  const policyCommitment = commitment("coinbase_policy", { canaryId, productId });
  const sessionPolicy = coinbaseSessionPolicy(productId);
  const encryptedVault = await sealedBundle({
    version: 1,
    kind: "ghola_coinbase_advanced_execution_vault",
    network,
    base_url: env("GHOLA_CANARY_COINBASE_BASE_URL", coinbaseBaseUrl(network)),
    execution_mode: "byo_api_key",
    api_key_name: apiKeyName,
    api_private_key_pem: apiPrivateKeyPem,
    portfolio_id: env("GHOLA_CANARY_COINBASE_PORTFOLIO_ID") || null,
    allowed_operations: ["read", "preview_order", "spot_limit_order", "spot_market_order", "cancel", "fills", "reconcile"],
    blocked_operations: ["withdraw", "vault_transfer", "leverage_escalation"],
  }, [
    "ghola/coinbase-advanced-execution-vault-v1",
    `account:${accountCommitment}`,
    `recipient:${recipient.recipient_id}`,
    "mode:byo_api_key",
    `network:${network}`,
  ].join("|"));

  await expect("coinbase byo session", "/venues/coinbase/sessions", 201, {
    version: 1,
    venue_id: "coinbase_advanced",
    platform_class: "coinbase_style_provider",
    execution_mode: "byo_api_key",
    account_commitment: accountCommitment,
    vault_commitment: vaultCommitment,
    policy_commitment: policyCommitment,
    encrypted_execution_vault: encryptedVault,
    session_policy: sessionPolicy,
  });

  return runCoinbaseOrderFlow({
    executionMode: "byo_api_key",
    network,
    productId,
    side,
    baseSize,
    limitPrice,
    vaultCommitment,
    policyCommitment,
    encryptedVault,
    sessionPolicy,
  });
}

async function runCoinbaseOmnibus() {
  const productId = env("GHOLA_CANARY_COINBASE_PRODUCT_ID", "BTC-USD").toUpperCase();
  const side = env("GHOLA_CANARY_COINBASE_SIDE", "buy").toLowerCase();
  const baseSize = env("GHOLA_CANARY_COINBASE_BASE_SIZE", "0.001");
  const limitPrice = env("GHOLA_CANARY_COINBASE_LIMIT_PRICE", "10000");
  const accountCommitment = commitment("coinbase_omnibus_account", { canaryId });
  const policyCommitment = commitment("coinbase_omnibus_policy", { canaryId, productId });
  const omnibusAllocation = {
    allocation_commitment: commitment("omnibus_allocation", { canaryId }),
    pool_commitment: commitment("omnibus_pool", { canaryId }),
    partner_commitment: commitment("omnibus_partner", { canaryId }),
    subledger_account_commitment: commitment("omnibus_subledger", { canaryId }),
    settlement_funding_commitment: commitment("funding_import", { canaryId }),
    status: "allocated",
  };
  const sessionPolicy = coinbaseSessionPolicy(productId);

  await expect("coinbase omnibus allocation", "/omnibus/allocations", 201, {
    version: 1,
    omnibus_allocation: omnibusAllocation,
  });
  await expect("coinbase omnibus session", "/venues/coinbase/sessions", 201, {
    version: 1,
    venue_id: "coinbase_advanced",
    platform_class: "coinbase_style_provider",
    execution_mode: "partner_omnibus",
    account_commitment: accountCommitment,
    policy_commitment: policyCommitment,
    omnibus_allocation: omnibusAllocation,
    session_policy: sessionPolicy,
  });

  return runCoinbaseOrderFlow({
    executionMode: "partner_omnibus",
    network: env("GHOLA_CANARY_COINBASE_NETWORK", "mainnet"),
    productId,
    side,
    baseSize,
    limitPrice,
    policyCommitment,
    omnibusAllocation,
    sessionPolicy,
  });
}

async function runJupiter({ executionMode = env("GHOLA_CANARY_JUPITER_EXECUTION_MODE", "user_stealth") } = {}) {
  const pooled = executionMode === "ghola_pooled";
  const authorityPrivateKey = !pooled && live
    ? required("GHOLA_CANARY_JUPITER_AUTHORITY_PRIVATE_KEY")
    : "1111111111111111111111111111111111111111111111111111111111111111";
  const inputMint = env("GHOLA_CANARY_JUPITER_INPUT_MINT", JUPITER_SOL_MINT);
  const outputMint = env("GHOLA_CANARY_JUPITER_OUTPUT_MINT", JUPITER_USDC_MINT);
  const amount = env("GHOLA_CANARY_JUPITER_AMOUNT", "1000");
  const quoteSize = env("GHOLA_CANARY_JUPITER_QUOTE_SIZE", "5");
  const maxSlippageBps = env("GHOLA_CANARY_JUPITER_MAX_SLIPPAGE_BPS", "50");
  const routingMode = env("GHOLA_CANARY_JUPITER_ROUTING_MODE", "meta_aggregator");
  const accountCommitment = commitment("jupiter_account", { canaryId, inputMint, outputMint });
  const vaultCommitment = commitment("jupiter_vault", { accountCommitment });
  const allocationCommitment = commitment("jupiter_pooled_allocation", { canaryId, inputMint, outputMint });
  const policyCommitment = commitment("jupiter_policy", { canaryId, inputMint, outputMint });
  const sessionPolicy = {
    market_allowlist: [`${inputMint.slice(0, 6)}/${outputMint.slice(0, 6)}`],
    max_notional_bucket: env("GHOLA_CANARY_MAX_NOTIONAL_BUCKET", "25"),
    max_daily_notional_bucket: env("GHOLA_CANARY_DAILY_CAP_USD", "5000"),
    max_order_count: 10,
    kill_switch: false,
  };
  const encryptedVault = pooled ? null : await sealedBundle({
      version: 1,
      kind: "ghola_solana_swap_execution_vault",
      venue_id: "jupiter",
      network: "mainnet",
      execution_mode: "user_stealth",
      wallet_private_key: authorityPrivateKey,
      allowed_operations: ["read", "preview_order", "swap", "reconcile"],
      blocked_operations: ["withdraw", "vault_transfer", "leverage_escalation", "staking", "raw_custody_transfer"],
    }, [
      "ghola/solana-swap-execution-vault-v1",
      `account:${accountCommitment}`,
      `recipient:${recipient.recipient_id}`,
      "mode:user_stealth",
      "network:mainnet",
      "venue:jupiter",
    ].join("|"));

  const orderWork = commitment("work_order", { canaryId, venue, op: submitOrder ? "swap" : "verify" });
  const orderBody = stripUndefined({
    version: 1,
    venue_id: "jupiter",
    platform_class: "solana_swap_aggregator",
    execution_mode: pooled ? "ghola_pooled" : "user_stealth",
    work_order_commitment: orderWork,
    vault_commitment: pooled ? undefined : vaultCommitment,
    allocation_commitment: pooled ? allocationCommitment : undefined,
    policy_commitment: policyCommitment,
    operation_class: "swap",
    encrypted_execution_vault: pooled ? undefined : encryptedVault,
    encrypted_execution_instruction_bundle: await instructionBundle({
      workOrderCommitment: orderWork,
      venueId: "jupiter",
      operationClass: "swap",
      order: {
        input_mint: inputMint,
        output_mint: outputMint,
        amount,
        quote_size: quoteSize,
        max_slippage_bps: maxSlippageBps,
        routing_mode: routingMode,
      },
    }),
    session_policy: sessionPolicy,
  });

  let orderResult = null;
  if (submitOrder) {
    assertFullTicketCanarySize(quoteSize, "GHOLA_CANARY_JUPITER_QUOTE_SIZE");
    orderResult = await expect("jupiter live swap", "/venues/solana-swap/orders", 202, orderBody);
  } else {
    orderResult = await expect("jupiter no-submit swap", "/venues/solana-swap/verify", 200, orderBody, {
      "x-ghola-no-submit-verify": "true",
    });
  }

  const reconcileWork = commitment("work_order", { canaryId, venue, op: "reconcile" });
  const reconcileResult = await expect("jupiter reconcile", "/venues/solana-swap/reconcile", 200, stripUndefined({
    version: 1,
    venue_id: "jupiter",
    platform_class: "solana_swap_aggregator",
    execution_mode: pooled ? "ghola_pooled" : "user_stealth",
    work_order_commitment: reconcileWork,
    vault_commitment: pooled ? undefined : vaultCommitment,
    allocation_commitment: pooled ? allocationCommitment : undefined,
    policy_commitment: policyCommitment,
    encrypted_execution_vault: pooled ? undefined : encryptedVault,
    encrypted_execution_instruction_bundle: await instructionBundle({
      workOrderCommitment: reconcileWork,
      venueId: "jupiter",
      operationClass: "reconcile",
      reconcile: { input_mint: inputMint, output_mint: outputMint },
    }),
    session_policy: sessionPolicy,
  }));
  if (!submitOrder) {
    return buildCapitalFreeCanaryReport({
      venueId: "jupiter",
      network: "mainnet",
      orderResult,
      reconcileResult,
      orderNotionalUsd: Number(quoteSize),
      maxSlippageBps: Number(maxSlippageBps),
    });
  }
  return buildCanaryReport({
    venueId: "jupiter",
    network: "mainnet",
    orderResult,
    reconcileResult,
    orderNotionalUsd: Number(quoteSize),
    maxSlippageBps: Number(maxSlippageBps),
  });
}

async function runCoinbaseOrderFlow(input) {
  const orderOperation = submitOrder ? "spot_limit_order" : "preview_order";
  const orderWork = commitment("work_order", { canaryId, venue, op: orderOperation });
  const orderResult = await expect(`coinbase ${orderOperation}`, "/venues/coinbase/orders", 202, {
    version: 1,
    venue_id: "coinbase_advanced",
    platform_class: "coinbase_style_provider",
    execution_mode: input.executionMode,
    work_order_commitment: orderWork,
    vault_commitment: input.vaultCommitment,
    policy_commitment: input.policyCommitment,
    operation_class: orderOperation,
    encrypted_execution_vault: input.encryptedVault,
    encrypted_execution_instruction_bundle: await instructionBundle({
      workOrderCommitment: orderWork,
      venueId: "coinbase_advanced",
      operationClass: orderOperation,
      order: {
        product_id: input.productId,
        side: input.side,
        base_size: input.baseSize,
        limit_price: input.limitPrice,
        tif: env("GHOLA_CANARY_COINBASE_TIF", "gtc"),
      },
    }),
    omnibus_allocation: input.omnibusAllocation,
    session_policy: input.sessionPolicy,
  });

  if (submitOrder) {
    const cancelWork = commitment("work_order", { canaryId, venue, op: "cancel" });
    await expect("coinbase cancel", "/venues/coinbase/orders", 202, {
      version: 1,
      venue_id: "coinbase_advanced",
      platform_class: "coinbase_style_provider",
      execution_mode: input.executionMode,
      work_order_commitment: cancelWork,
      vault_commitment: input.vaultCommitment,
      policy_commitment: input.policyCommitment,
      operation_class: "cancel",
      encrypted_execution_vault: input.encryptedVault,
      encrypted_execution_instruction_bundle: await instructionBundle({
        workOrderCommitment: cancelWork,
        venueId: "coinbase_advanced",
        operationClass: "cancel",
        cancel: {
          product_id: input.productId,
          target_work_order_commitment: orderWork,
        },
      }),
      omnibus_allocation: input.omnibusAllocation,
      session_policy: input.sessionPolicy,
    });
  }

  const reconcileWork = commitment("work_order", { canaryId, venue, op: "reconcile" });
  const reconcileResult = await expect("coinbase reconcile", "/venues/coinbase/reconcile", 200, {
    version: 1,
    venue_id: "coinbase_advanced",
    platform_class: "coinbase_style_provider",
    execution_mode: input.executionMode,
    work_order_commitment: reconcileWork,
    vault_commitment: input.vaultCommitment,
    policy_commitment: input.policyCommitment,
    encrypted_execution_vault: input.encryptedVault,
    encrypted_execution_instruction_bundle: await instructionBundle({
      workOrderCommitment: reconcileWork,
      venueId: "coinbase_advanced",
      operationClass: "reconcile",
      reconcile: { product_id: input.productId },
    }),
    omnibus_allocation: input.omnibusAllocation,
    session_policy: input.sessionPolicy,
  });
  if (!submitOrder) return null;
  return buildCanaryReport({
    venueId: "coinbase",
    network: input.network,
    orderResult,
    reconcileResult,
    orderNotionalUsd: coinbaseOrderNotionalUsd(input),
    maxSlippageBps: Number(env("GHOLA_CANARY_MAX_SLIPPAGE_BPS", "100")),
  });
}

async function postCanaryReport(report) {
  const url = canaryReportUrl();
  if (!url) {
    console.log("[venue-canary] no GHOLA_CANARY_REPORT_URL or GHOLA_WEB_BASE_URL configured; canary evidence was not posted");
    return;
  }
  const reportToken = env("GHOLA_CANARY_REPORT_TOKEN") || env("GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN");
  if (!reportToken) {
    fail("GHOLA_CANARY_REPORT_TOKEN or GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN is required to post canary evidence");
  }
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${reportToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(stripUndefined(report)),
  }).catch((error) => fail("canary report request failed", String(error)));
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      fail("canary report endpoint returned non-JSON", text.slice(0, 500));
    }
  }
  if (!response.ok) {
    fail(`canary report endpoint returned HTTP ${response.status}`, text);
  }
  console.log(`[venue-canary] report posted venue=${report.venue_id} evidence=${body?.report?.evidence_commitment || "accepted"}`);
}

function buildCanaryReport({
  venueId,
  network,
  orderResult,
  reconcileResult,
  orderNotionalUsd,
  maxSlippageBps,
}) {
  const notional = finitePositive(orderNotionalUsd, "canary order notional");
  const maxOrderNotionalUsd = finitePositive(
    env("GHOLA_CANARY_MAX_ORDER_NOTIONAL_USD") ||
      env("GHOLA_LIVE_TRADING_MAX_ORDER_NOTIONAL_USD") ||
      "1000",
    "canary max order notional",
  );
  const dailyCapUsd = finitePositive(
    env("GHOLA_CANARY_DAILY_CAP_USD") ||
      env("GHOLA_LIVE_TRADING_DAILY_CAP_USD") ||
      "5000",
    "canary daily cap",
  );
  const slippageBps = finitePositive(maxSlippageBps || env("GHOLA_LIVE_TRADING_MAX_SLIPPAGE_BPS", "100"), "canary max slippage");
  if (notional > maxOrderNotionalUsd) {
    fail(`canary order notional ${notional} exceeds report max order cap ${maxOrderNotionalUsd}`);
  }
  if (network !== "mainnet") {
    fail(`full live canary reports require mainnet, got ${network || "unknown"}`);
  }
  return {
    report_id: `${canaryId}_${venueId}`,
    venue_id: venueId,
    network: "mainnet",
    status: "green",
    live_mode: "full_ticket",
    canary_kind: "full_ticket_broadcast",
    broadcast_performed: true,
    reconcile_status: "reconciled",
    order_notional_usd: notional,
    max_order_notional_usd: maxOrderNotionalUsd,
    daily_cap_usd: dailyCapUsd,
    max_slippage_bps: Math.floor(slippageBps),
    receipt_commitment: commitmentFromResult(orderResult) || commitment("canary_receipt", { canaryId, venueId, orderResult }),
    result_commitment: commitmentFromResult(reconcileResult) || commitment("canary_result", { canaryId, venueId, reconcileResult }),
    observed_at: new Date().toISOString(),
  };
}

function buildCapitalFreeCanaryReport({
  venueId,
  network,
  orderResult,
  reconcileResult,
  orderNotionalUsd,
  maxSlippageBps,
}) {
  const notional = finitePositive(orderNotionalUsd, "capital-free proof notional");
  const maxOrderNotionalUsd = finitePositive(
    env("GHOLA_CANARY_MAX_ORDER_NOTIONAL_USD") ||
      env("GHOLA_LIVE_TRADING_MAX_ORDER_NOTIONAL_USD") ||
      "1000",
    "capital-free max order notional",
  );
  const dailyCapUsd = finitePositive(
    env("GHOLA_CANARY_DAILY_CAP_USD") ||
      env("GHOLA_LIVE_TRADING_DAILY_CAP_USD") ||
      "5000",
    "capital-free daily cap",
  );
  const slippageBps = finitePositive(
    maxSlippageBps || env("GHOLA_LIVE_TRADING_MAX_SLIPPAGE_BPS", "100"),
    "capital-free max slippage",
  );
  if (notional > maxOrderNotionalUsd) {
    fail(`capital-free proof notional ${notional} exceeds report max order cap ${maxOrderNotionalUsd}`);
  }
  if (network !== "mainnet") {
    fail(`capital-free no-submit proofs require mainnet, got ${network || "unknown"}`);
  }
  return {
    report_id: `${canaryId}_${venueId}_capital_free`,
    venue_id: venueId,
    network: "mainnet",
    status: "green",
    live_mode: "no_submit",
    canary_kind: "capital_free_no_submit",
    broadcast_performed: false,
    reconcile_status: "reconciled",
    order_notional_usd: notional,
    max_order_notional_usd: maxOrderNotionalUsd,
    daily_cap_usd: dailyCapUsd,
    max_slippage_bps: Math.floor(slippageBps),
    receipt_commitment: commitmentFromResult(orderResult) ||
      commitment("capital_free_canary_receipt", { canaryId, venueId, orderResult }),
    result_commitment: commitmentFromResult(reconcileResult) ||
      commitment("capital_free_canary_result", { canaryId, venueId, reconcileResult }),
    observed_at: new Date().toISOString(),
  };
}

function canaryReportUrl() {
  const direct = env("GHOLA_CANARY_REPORT_URL");
  if (direct) return direct;
  const base = env("GHOLA_WEB_BASE_URL") || env("GHOLA_VERIFY_BASE_URL") || env("NEXT_PUBLIC_APP_URL");
  return base ? `${trimUrl(base)}/v1/private-account/live-trading/canary-report` : "";
}

function commitmentFromResult(result) {
  if (!result || typeof result !== "object") return "";
  return result.receipt_commitment ||
    result.result_commitment ||
    result.provider_ref_commitment ||
    result.execution_commitment ||
    result.work_order_commitment ||
    "";
}

function coinbaseOrderNotionalUsd(input) {
  const quote = Number(input.quoteSize);
  if (Number.isFinite(quote) && quote > 0) return quote;
  const base = Number(input.baseSize);
  const price = Number(input.limitPrice);
  return Number.isFinite(base) && Number.isFinite(price) && base > 0 && price > 0 ? base * price : 0;
}

async function getRecipient() {
  const result = await request("/.well-known/private-agent-recipient");
  if (!result.response.ok) {
    fail(`recipient endpoint returned ${result.response.status}`, result.text);
  }
  if (!result.body?.recipient_id || !result.body?.x25519_pub_hex) {
    fail("recipient endpoint did not publish recipient_id and x25519_pub_hex", result.text);
  }
  return result.body;
}

async function expect(label, path, expectedStatus, body, headers = {}) {
  const requestBody = stripUndefined(body);
  const result = await request(path, {
    method: "POST",
    headers: {
      authorization: authorizationHeader({ path, body: requestBody }),
      "content-type": "application/json",
      "x-ghola-sealed-execution-required": "true",
      ...headers,
    },
    body: JSON.stringify(requestBody),
  });
  if (result.response.status !== expectedStatus) {
    fail(`${label} expected HTTP ${expectedStatus}, got ${result.response.status}`, result.text);
  }
  const status = result.body?.status || result.body?.ready || "ok";
  const resultCommitment = result.body?.result_commitment || result.body?.provider_ref_commitment || "";
  console.log(`[venue-canary] ${label} ok status=${status}${resultCommitment ? ` ref=${resultCommitment}` : ""}`);
  return result.body;
}

function authorizationHeader({ path, body }) {
  if (!workerCapabilitySecret) return `Bearer ${token}`;
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    version: 1,
    issuer: "ghola-venue-canary",
    method: "POST",
    path,
    scope: scopeForPath(path),
    body_hash: bodyHash(body),
    jti: randomUUID(),
    iat: now,
    nbf: now - 5,
    exp: now + 300,
    ...expectedForPath(path, body),
  };
  const payloadB64 = Buffer.from(stableJson(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", workerCapabilitySecret).update(payloadB64).digest("base64url");
  return `Bearer ghcap_v1.${payloadB64}.${signature}`;
}

function scopeForPath(path) {
  if (path.includes("/verify")) return "order:verify";
  if (path.includes("/orders")) return "order:submit";
  if (path.includes("/reconcile")) return "reconcile:read";
  return "session:create";
}

function expectedForPath(path, body) {
  if (path === "/omnibus/allocations") {
    return {
      ...capabilityExpectedFromBody(body.omnibus_allocation || body),
      operation_class: "omnibus_allocation",
    };
  }
  if (path === "/omnibus/reconcile") {
    return {
      ...capabilityExpectedFromBody(body.omnibus_allocation || body),
      operation_class: "reconcile",
    };
  }

  const expected = capabilityExpectedFromBody(body);
  if (path.startsWith("/hyperliquid/")) {
    expected.venue_id = "hyperliquid";
    expected.platform_class = "hyperliquid_style_market";
    if (path === "/hyperliquid/managed/allocations") expected.operation_class = "managed_allocation";
    if (path === "/hyperliquid/reconcile") expected.operation_class = "reconcile";
  } else if (path.startsWith("/venues/coinbase/")) {
    expected.venue_id = "coinbase_advanced";
    expected.platform_class = "coinbase_style_provider";
    if (path === "/venues/coinbase/reconcile") {
      expected.execution_mode = body.execution_mode || "partner_omnibus";
      expected.operation_class = "reconcile";
    }
  } else if (path.startsWith("/venues/solana-perps/")) {
    expected.venue_id = body.venue_id || "phoenix";
    expected.platform_class = "solana_perps_market";
    if (path === "/venues/solana-perps/reconcile") {
      expected.execution_mode = body.execution_mode || "user_stealth";
      expected.operation_class = "reconcile";
    }
  } else if (path.startsWith("/venues/solana-swap/")) {
    expected.venue_id = "jupiter";
    expected.platform_class = "solana_swap_aggregator";
    if (path === "/venues/solana-swap/reconcile") {
      expected.execution_mode = body.execution_mode || "user_stealth";
      expected.operation_class = "reconcile";
    }
  }
  return expected;
}

function capabilityExpectedFromBody(body = {}) {
  return {
    owner_commitment: body.owner_commitment,
    account_commitment: body.account_commitment,
    session_commitment: body.session_commitment,
    autopilot_session_id: body.autopilot_session_id,
    venue_id: body.venue_id,
    platform_class: body.platform_class,
    execution_mode: body.execution_mode,
    operation_class: body.operation_class,
    work_order_commitment: body.work_order_commitment,
    policy_commitment: body.policy_commitment,
    allocation_commitment: body.allocation_commitment,
    vault_commitment: body.vault_commitment,
  };
}

function bodyHash(body) {
  return createHash("sha256").update(stableJson(body)).digest("hex");
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

async function request(path, init = {}) {
  const response = await fetch(`${trimUrl(workerUrl)}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.headers ?? {}),
    },
  }).catch((error) => fail(`request failed: ${path}`, String(error)));
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      fail(`non-JSON response from ${path}`, text.slice(0, 500));
    }
  }
  return { response, body, text };
}

async function sealedBundle(plaintext, aad) {
  const wire = await sealForTest({
    senderDid,
    recipientId: recipient.recipient_id,
    recipientX25519: hexToBytes(recipient.x25519_pub_hex),
    associatedData: aad,
    plaintext,
    signBody: async (digest) => new Uint8Array(sign(null, Buffer.from(digest), privateKey)),
  });
  return {
    alg: "sealed-provider-v1",
    ciphertext: bytesToBase64(wire),
    recipient: recipient.recipient_id,
    aad,
  };
}

async function instructionBundle({
  workOrderCommitment,
  venueId,
  operationClass,
  order,
  cancel,
  reconcile,
}) {
  return sealedBundle(stripUndefined({
    version: 1,
    kind: "ghola_private_execution_instruction",
    venue_id: venueId,
    operation_class: operationClass,
    expires_at: new Date(Date.now() + 120_000).toISOString(),
    order,
    cancel,
    reconcile,
  }), [
    "ghola/private-execution-instruction-v1",
    `work_order:${workOrderCommitment}`,
    `venue:${venueId}`,
    `recipient:${recipient.recipient_id}`,
  ].join("|"));
}

function coinbaseSessionPolicy(productId) {
  return {
    market_allowlist: [productId],
    max_notional_bucket: env("GHOLA_CANARY_MAX_NOTIONAL_BUCKET", "25"),
    max_daily_notional_bucket: env("GHOLA_CANARY_DAILY_CAP_USD", "5000"),
    max_order_count: 10,
    kill_switch: false,
  };
}

function coinbasePrivateKeyPem() {
  const b64 = env("GHOLA_CANARY_COINBASE_API_PRIVATE_KEY_PEM_B64");
  if (b64) return Buffer.from(b64, "base64").toString("utf8");
  const path = env("GHOLA_CANARY_COINBASE_API_PRIVATE_KEY_PEM_PATH");
  if (path) return readFileSync(path, "utf8");
  const raw = env("GHOLA_CANARY_COINBASE_API_PRIVATE_KEY_PEM");
  if (raw) return raw.replace(/\\n/g, "\n");
  fail("GHOLA_CANARY_COINBASE_API_PRIVATE_KEY_PEM_B64 or _PEM_PATH is required");
}

function coinbaseBaseUrl(network) {
  return network === "sandbox"
    ? "https://api-sandbox.coinbase.com/api/v3/brokerage"
    : "https://api.coinbase.com/api/v3/brokerage";
}

function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .map(([key, child]) => [key, stripUndefined(child)]),
  );
}

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = unquoteEnv(rawValue.trim());
  }
}

function unquoteEnv(value) {
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    return value.slice(1, -1).replace(/'\\''/g, "'");
  }
  return value;
}

function commitment(prefix, value) {
  return `${prefix}_${createHash("sha256")
    .update(JSON.stringify(value, Object.keys(value).sort()))
    .digest("hex")
    .slice(0, 48)}`;
}

function env(name, fallback = "") {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function required(name) {
  const value = env(name);
  if (!value) fail(`${name} is required`);
  return value;
}

function boolEnv(name) {
  return env(name).toLowerCase() === "1" || env(name).toLowerCase() === "true";
}

function assertTinyFillCanarySize(value, label = "GHOLA_CANARY_HYPERLIQUID_QUOTE_SIZE") {
  if (!/^\d+(\.\d+)?$/.test(value)) {
    fail(`${label} must be a decimal dollar amount`);
  }
  const size = Number(value);
  if (!Number.isFinite(size) || size <= 0) {
    fail(`${label} must be greater than zero`);
  }
  if (size > 25) {
    fail(`${label} must stay at or below $25 for the live canary`);
  }
}

function assertFullTicketCanarySize(value, label) {
  const size = finitePositive(value, label);
  const maxOrder = finitePositive(
    env("GHOLA_CANARY_MAX_ORDER_NOTIONAL_USD") ||
      env("GHOLA_LIVE_TRADING_MAX_ORDER_NOTIONAL_USD") ||
      "1000",
    "GHOLA_CANARY_MAX_ORDER_NOTIONAL_USD",
  );
  if (size > maxOrder) {
    fail(`${label} must stay at or below $${maxOrder} for the full-ticket live canary`);
  }
  if (size > 1000) {
    fail(`${label} must stay at or below $1000 for the launch canary`);
  }
}

function finitePositive(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    fail(`${label} must be a positive number`);
  }
  return number;
}

function trimUrl(value) {
  return String(value || "").replace(/\/$/, "");
}

function fail(message, detail) {
  console.error(`[venue-canary] ${message}`);
  if (detail) console.error(detail);
  process.exit(1);
}
