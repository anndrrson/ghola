import { createHash } from "node:crypto";
import { openSealedBundle } from "../crypto/envelope.js";
import {
  bucketToUsd,
  enforceInstructionPolicy,
  estimateOrderNotionalUsd,
  normalizeInstruction,
} from "./policy.js";
import {
  assertCoinbaseKeyPermissions,
  coinbaseCredentialFromVault,
  loadPartnerCoinbaseCredential,
  submitCoinbaseExecution,
  verifyCoinbaseNoSubmit,
} from "../venues/coinbase.js";
import {
  createHyperliquidAccountStateStream,
  hyperliquidManagedAccountRefs,
  hyperliquidCredentialFromVault,
  loadManagedHyperliquidCredential,
  readHyperliquidAccountSnapshot,
  submitHyperliquidExecution,
  verifyHyperliquidNoSubmit,
} from "../venues/hyperliquid.js";
import {
  loadPooledSolanaPerpsCredential,
  normalizeSolanaPerpsVenueId,
  solanaPerpsCredentialFromVault,
  submitSolanaPerpsExecution,
  verifySolanaPerpsNoSubmit,
} from "../venues/solana_perps.js";
import {
  jupiterCredentialFromVault,
  loadPooledJupiterCredential,
  submitJupiterSwapExecution,
  verifyJupiterSwapNoSubmit as verifyJupiterSwapNoSubmitAdapter,
} from "../venues/jupiter.js";

export class PrivateExecutionError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "PrivateExecutionError";
    this.status = status;
  }
}

const AUTOPILOT_INTERNAL_INSTRUCTION = Symbol("ghola.autopilot.internal_instruction");

export function commitment(prefix, value) {
  return `${prefix}_${sha256Hex(canonicalJson(value)).slice(0, 48)}`;
}

export async function storePrivateAgentSession({ body, recipient, state, provider }) {
  const opened = await openSealedBundle(body.encrypted_strategy_bundle, recipient, {
    aadPrefix: "ghola-private-agent-session-v1",
    expectedKind: "ghola_private_agent_strategy",
  });
  const policy = opened.json.policy && typeof opened.json.policy === "object"
    ? sanitizeStrategyPolicy(opened.json.policy)
    : null;
  const session = {
    session_commitment: commitment("private_agent_session", {
      strategy_id: body.strategy_id,
      policy_hash: body.policy_hash,
      recipient: body.encrypted_strategy_bundle.recipient,
    }),
    provider,
    venue_id: null,
    strategy_id: body.strategy_id,
    policy_hash: body.policy_hash,
    strategy_policy: policy,
    created_at: new Date().toISOString(),
  };
  await state.putSession(session);
  return session;
}

export async function storeHyperliquidSession({ body, recipient, state, provider }) {
  const executionMode = hyperliquidExecutionMode(body);
  if (executionMode === "byo_api_key") {
    await openSealedBundle(body.encrypted_execution_vault, recipient, {
      aadPrefix: "ghola/hyperliquid-execution-vault-v1",
      expectedKind: "ghola_hyperliquid_execution_vault",
    });
  } else if (body.managed_allocation?.allocation_commitment) {
    await state.putHyperliquidManagedAllocation(body.managed_allocation);
  } else {
    const allocationCommitment = body.managed_allocation?.allocation_commitment ||
      body.managed_allocation_commitment ||
      body.allocation_commitment;
    if (!await state.getHyperliquidManagedAllocation(allocationCommitment)) {
      throw new PrivateExecutionError("hyperliquid managed allocation is unavailable", 404);
    }
  }
  let strategyPolicy = null;
  if (body.encrypted_strategy_bundle) {
    const openedStrategy = await openSealedBundle(body.encrypted_strategy_bundle, recipient, {
      expectedKind: "ghola_private_agent_strategy",
    });
    strategyPolicy = sanitizeStrategyPolicy(openedStrategy.json.policy);
  }
  const sessionPolicy = publicSessionPolicy(body.session_policy, body.policy_commitment);
  const session = {
    session_commitment: commitment("hyperliquid_session", {
      account_commitment: body.account_commitment,
      execution_mode: executionMode,
      vault_commitment: body.vault_commitment || null,
      allocation_commitment: body.managed_allocation?.allocation_commitment ||
        body.managed_allocation_commitment ||
        body.allocation_commitment ||
        null,
      policy_commitment: body.policy_commitment,
    }),
    provider,
    venue_id: "hyperliquid",
    execution_mode: executionMode,
    account_commitment: body.account_commitment,
    vault_commitment: body.vault_commitment || null,
    allocation_commitment: body.managed_allocation?.allocation_commitment ||
      body.managed_allocation_commitment ||
      body.allocation_commitment ||
      null,
    policy_commitment: body.policy_commitment,
    session_policy: sessionPolicy,
    strategy_policy: strategyPolicy,
    created_at: new Date().toISOString(),
  };
  await state.putSession(session);
  return session;
}

export async function createHyperliquidManagedAllocation({ body, state }) {
  const executionMode = body.execution_mode === "hyperliquid_native_vault"
    ? "hyperliquid_native_vault"
    : body.execution_mode === "ghola_pooled" ? "ghola_pooled" : "managed_testnet";
  const network = executionMode === "managed_testnet" ? "testnet" : "mainnet";
  const refs = hyperliquidManagedAccountRefs()
    .filter((ref) =>
      ref.network === network &&
      (
        executionMode !== "hyperliquid_native_vault" ||
        ref.execution_mode === "hyperliquid_native_vault" ||
        ref.execution_mode === "ghola_pooled"
      )
    );
  if (executionMode === "hyperliquid_native_vault" && !isEvmAddress(body.vault_address)) {
    throw new PrivateExecutionError("hyperliquid native vault address is required", 400);
  }
  const nativeDepositReady = body.deposit_status === "confirmed" ||
    body.deposit_status === "withdraw_locked" ||
    body.deposit_status === "withdrawable";
  if (process.env.PRIVATE_AGENT_VENUE_DRY_RUN !== "true" && refs.length === 0) {
    throw new PrivateExecutionError(
      executionMode === "hyperliquid_native_vault"
        ? "hyperliquid native vault agent pool is unavailable"
        : executionMode === "ghola_pooled"
        ? "hyperliquid pooled mainnet account pool is unavailable"
        : "hyperliquid managed testnet pool is unavailable",
      503,
    );
  }
  const selected = refs.length > 0
    ? refs[managedCredentialIndex(body.account_commitment, refs.length)]
    : {
        credential_ref: commitment("hyperliquid_managed_credential", {
          account_commitment: body.account_commitment,
          execution_mode: executionMode,
          network,
          dry_run: true,
        }),
        network,
        market_allowlist: [],
      };
  if (selected.network !== network) {
    throw new PrivateExecutionError("hyperliquid allocation network is unavailable", 400);
  }
  const policy = publicSessionPolicy(body.session_policy, body.policy_commitment);
  const poolCommitment = commitment("hyperliquid_managed_pool", {
    execution_mode: executionMode,
    network,
    credential_count: refs.length,
  });
  const poolShareCommitment = commitment("hyperliquid_pool_share", {
    account_commitment: body.account_commitment,
    pool_commitment: poolCommitment,
    eligibility_commitment: body.eligibility_commitment || null,
    vault_address: body.vault_address || null,
  });
  const allocation = {
    version: 1,
    venue_id: "hyperliquid",
    platform_class: "hyperliquid_style_market",
    execution_mode: executionMode,
    network,
    status: executionMode === "hyperliquid_native_vault" && !nativeDepositReady
      ? "pending_funding"
      : "allocated",
    account_commitment: body.account_commitment,
    allocation_commitment: commitment("hyperliquid_managed_allocation", {
      account_commitment: body.account_commitment,
      policy_commitment: body.policy_commitment,
      credential_ref: selected.credential_ref,
      execution_mode: executionMode,
      network,
      eligibility_commitment: body.eligibility_commitment || null,
    }),
    policy_commitment: body.policy_commitment,
    pool_commitment: poolCommitment,
    pool_share_commitment: poolShareCommitment,
    subledger_account_commitment: commitment("hyperliquid_managed_subledger", {
      account_commitment: body.account_commitment,
      network,
      pool_share_commitment: poolShareCommitment,
    }),
    vault_address: body.vault_address || selected.vault_address || null,
    vault_controller_address: body.vault_controller_address || selected.vault_controller_address || null,
    agent_wallet_commitment: body.agent_wallet_commitment || selected.agent_wallet_commitment || null,
    deposit_evidence_commitment: body.deposit_evidence_commitment || null,
    deposit_status: executionMode === "hyperliquid_native_vault"
      ? nativeDepositReady ? body.deposit_status : "pending"
      : undefined,
    funding_routes: executionMode === "hyperliquid_native_vault"
      ? Array.isArray(body.funding_routes) ? body.funding_routes : ["hyperliquid_direct", "ghola_balance_bridge"]
      : undefined,
    eligibility_commitment: body.eligibility_commitment || null,
    funding_evidence_commitment: body.funding_evidence_commitment || null,
    credential_ref: selected.credential_ref,
    session_policy: policy,
    allowed_operations: ["read", "limit_order", "cancel", "reconcile"],
    blocked_operations: ["withdraw", "vault_transfer", "leverage_escalation", "staking"],
    visibility_summary: {
      main_wallet_exposed: false,
      ghola_operator_sees: "commitment_and_ciphertext_only",
      hyperliquid_sees: executionMode === "hyperliquid_native_vault"
        ? "vault_address_and_order_activity"
        : "execution_account_and_order_activity",
      public_chain_sees: executionMode === "hyperliquid_native_vault"
        ? "hyperliquid_vault_deposit_and_order_activity"
        : executionMode === "ghola_pooled"
        ? "private_funding_evidence_required"
        : "no_public_wallet_settlement",
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await state.putHyperliquidManagedAllocation(allocation);
  return publicHyperliquidManagedAllocation(allocation);
}

export async function storeCoinbaseSession({ body, recipient, state, provider }) {
  if (body.execution_mode === "byo_api_key") {
    await openSealedBundle(body.encrypted_execution_vault, recipient, {
      aadPrefix: "ghola/coinbase-advanced-execution-vault-v1",
      expectedKind: "ghola_coinbase_advanced_execution_vault",
    });
  }
  let strategyPolicy = null;
  if (body.encrypted_strategy_bundle) {
    const openedStrategy = await openSealedBundle(body.encrypted_strategy_bundle, recipient, {
      expectedKind: "ghola_private_agent_strategy",
    });
    strategyPolicy = sanitizeStrategyPolicy(openedStrategy.json.policy);
  }
  if (body.omnibus_allocation) await state.putOmnibusAllocation(body.omnibus_allocation);
  const sessionPolicy = publicSessionPolicy(body.session_policy, body.policy_commitment);
  const session = {
    session_commitment: commitment("coinbase_session", {
      account_commitment: body.account_commitment,
      execution_mode: body.execution_mode,
      vault_commitment: body.vault_commitment || null,
      allocation_commitment: body.omnibus_allocation?.allocation_commitment || null,
      policy_commitment: body.policy_commitment,
    }),
    provider,
    venue_id: "coinbase_advanced",
    execution_mode: body.execution_mode,
    account_commitment: body.account_commitment,
    vault_commitment: body.vault_commitment || null,
    allocation_commitment: body.omnibus_allocation?.allocation_commitment || null,
    policy_commitment: body.policy_commitment,
    session_policy: sessionPolicy,
    strategy_policy: strategyPolicy,
    created_at: new Date().toISOString(),
  };
  await state.putSession(session);
  return session;
}

export async function executeHyperliquidOrder({ body, recipient, state }) {
  const cached = await state.getIdempotency(body.work_order_commitment);
  if (cached?.receipt) return cached.receipt;
  const executionMode = hyperliquidExecutionMode(body);
  let credential;
  let allocation = null;
  if (isHyperliquidAllocationMode(executionMode)) {
    const allocationCommitment = body.managed_allocation?.allocation_commitment ||
      body.managed_allocation_commitment ||
      body.allocation_commitment;
    if (body.managed_allocation?.allocation_commitment) {
      await state.putHyperliquidManagedAllocation(body.managed_allocation);
    }
    const record = await state.getHyperliquidManagedAllocation(allocationCommitment);
    if (!record?.allocation || record.allocation.status !== "allocated") {
      throw new PrivateExecutionError("hyperliquid managed allocation is unavailable", 404);
    }
    allocation = record.allocation;
    credential = loadManagedHyperliquidCredential(allocation);
  } else {
    if (process.env.PRIVATE_AGENT_VENUE_DRY_RUN === "true" && !body.encrypted_execution_vault) {
      credential = dryRunHyperliquidCredential();
    } else {
      const openedVault = await openSealedBundle(body.encrypted_execution_vault, recipient, {
        aadPrefix: "ghola/hyperliquid-execution-vault-v1",
        expectedKind: "ghola_hyperliquid_execution_vault",
      });
      credential = hyperliquidCredentialFromVault(openedVault.json);
    }
  }
  const session = await state.findSession({
    venue_id: "hyperliquid",
    vault_commitment: executionMode === "byo_api_key" ? body.vault_commitment : undefined,
    allocation_commitment: isHyperliquidAllocationMode(executionMode)
      ? body.managed_allocation_commitment || body.allocation_commitment
      : undefined,
    policy_commitment: body.policy_commitment,
  });
  const instruction = await resolvePrivateCancelTarget(await instructionForBody({
    body,
    recipient,
    venue_id: "hyperliquid",
    session,
  }), { state, venue_id: "hyperliquid" });
  await enforceInstructionPolicy({ body, instruction, session, state });
  const cloid = await state.deriveHyperliquidCloid(body.work_order_commitment);
  const adapterResult = await submitHyperliquidExecution({
    credential,
    instruction,
    cloid,
  });
  await state.putExecutionAttempt(body.work_order_commitment, {
    venue_id: "hyperliquid",
    platform_class: "hyperliquid_style_market",
    execution_mode: executionMode,
    provider_ref_seed: adapterResult.provider_ref_seed,
    result_seed: adapterResult.result_seed,
    fills: adapterResult.fills,
    final_proof: adapterResult.final_proof || null,
    status: adapterResult.status,
    created_at: new Date().toISOString(),
  });
  const receipt = executionReceipt({
    venue_id: "hyperliquid",
    platform_class: "hyperliquid_style_market",
    execution_mode: executionMode,
    instruction,
    body,
    status: adapterResult.status,
    provider_ref_seed: adapterResult.provider_ref_seed,
    result_seed: adapterResult.result_seed,
    fills: adapterResult.fills,
    final_proof: adapterResult.final_proof,
    visibility_summary: {
      main_wallet_exposed: false,
      ghola_operator_sees: "commitment_and_ciphertext_only",
      hyperliquid_sees: executionMode === "hyperliquid_native_vault"
        ? "vault_address_and_order_activity"
        : "execution_account_and_order_activity",
      venue_access_source: hyperliquidVenueAccessSource(executionMode),
      ghola_access_role: "private_execution_router",
      venue_gate: "venue_accepts_or_rejects_credentials",
      public_chain_sees: executionMode === "hyperliquid_native_vault"
        ? "hyperliquid_vault_deposit_and_order_activity"
        : executionMode === "ghola_pooled"
        ? "private_funding_evidence_required"
        : allocation
        ? "no_public_wallet_settlement"
        : instruction.order?.live_order_mode === "tiny_fill"
          ? "no_ghola_public_settlement"
          : "private_funding_evidence_required",
    },
  });
  return state.putIdempotency(body.work_order_commitment, receipt);
}

export async function readHyperliquidSnapshot({ body, recipient, state }) {
  const { executionMode, credential } = await hyperliquidCredentialForBody({ body, recipient, state });
  return readHyperliquidAccountSnapshot({
    credential,
    accountSource: hyperliquidAccountSource(executionMode),
  });
}

export async function streamHyperliquidAccountState({ body, recipient, state, onEvent }) {
  const { executionMode, credential } = await hyperliquidCredentialForBody({ body, recipient, state });
  return createHyperliquidAccountStateStream({
    credential,
    accountSource: hyperliquidAccountSource(executionMode),
    coin: typeof body.coin === "string" ? body.coin.toUpperCase() : "BTC",
    onEvent,
  });
}

export async function verifyVenueCredential({ body, recipient }) {
  const venueId = body.venue_id;
  if (venueId === "coinbase_advanced") {
    const openedVault = await openSealedBundle(body.encrypted_execution_vault, recipient, {
      aadPrefix: "ghola/coinbase-advanced-execution-vault-v1",
      expectedKind: "ghola_coinbase_advanced_execution_vault",
    });
    const credential = coinbaseCredentialFromVault(openedVault.json);
    const permissions = process.env.PRIVATE_AGENT_VENUE_DRY_RUN === "true"
      ? { can_view: true, can_trade: true, can_transfer: false, portfolio_commitment_seed: "dry-run" }
      : await assertCoinbaseKeyPermissions(credential);
    return credentialVerificationResult({
      venue_id: "coinbase_advanced",
      source: "coinbase_key_permissions",
      can_read: permissions.can_view === true,
      can_trade: permissions.can_trade === true,
      can_withdraw: permissions.can_transfer === true,
      evidence_seed: {
        portfolio: permissions.portfolio_commitment_seed,
      },
    });
  }
  if (venueId === "hyperliquid") {
    const openedVault = await openSealedBundle(body.encrypted_execution_vault, recipient, {
      aadPrefix: "ghola/hyperliquid-execution-vault-v1",
      expectedKind: "ghola_hyperliquid_execution_vault",
    });
    const credential = hyperliquidCredentialFromVault(openedVault.json);
    const snapshot = await readHyperliquidAccountSnapshot({
      credential,
      accountSource: "sealed_byo",
    });
    return credentialVerificationResult({
      venue_id: "hyperliquid",
      source: "hyperliquid_account_readiness",
      can_read: snapshot.status === "ready_to_trade",
      can_trade: snapshot.trading_enabled === true,
      can_withdraw: false,
      evidence_seed: {
        account_source: snapshot.account_source,
        status: snapshot.status,
      },
    });
  }
  if (venueId === "jupiter") {
    const openedVault = await openSealedBundle(body.encrypted_execution_vault, recipient, {
      aadPrefix: "ghola/solana-swap-execution-vault-v1",
      expectedKind: "ghola_solana_swap_execution_vault",
    });
    jupiterCredentialFromVault(openedVault.json);
    return credentialVerificationResult({
      venue_id: "jupiter",
      source: "solana_swap_vault_shape",
      can_read: true,
      can_trade: true,
      can_withdraw: false,
      evidence_seed: {
        credential_loaded: true,
      },
    });
  }
  throw new PrivateExecutionError("venue credential verification is unsupported", 404);
}

async function hyperliquidCredentialForBody({ body, recipient, state }) {
  const executionMode = hyperliquidExecutionMode(body);
  let credential;
  if (isHyperliquidAllocationMode(executionMode)) {
    const allocationCommitment = body.managed_allocation?.allocation_commitment ||
      body.managed_allocation_commitment ||
      body.allocation_commitment;
    if (body.managed_allocation?.allocation_commitment) {
      await state.putHyperliquidManagedAllocation(body.managed_allocation);
    }
    const record = await state.getHyperliquidManagedAllocation(allocationCommitment);
    if (!record?.allocation || record.allocation.status !== "allocated") {
      throw new PrivateExecutionError("hyperliquid managed allocation is unavailable", 404);
    }
    credential = loadManagedHyperliquidCredential(record.allocation);
  } else {
    if (process.env.PRIVATE_AGENT_VENUE_DRY_RUN === "true" && !body.encrypted_execution_vault) {
      credential = dryRunHyperliquidCredential();
    } else {
      const openedVault = await openSealedBundle(body.encrypted_execution_vault, recipient, {
        aadPrefix: "ghola/hyperliquid-execution-vault-v1",
        expectedKind: "ghola_hyperliquid_execution_vault",
      });
      credential = hyperliquidCredentialFromVault(openedVault.json);
    }
  }
  return { executionMode, credential };
}

export async function executeCoinbaseOrder({ body, recipient, state }) {
  const cached = await state.getIdempotency(body.work_order_commitment);
  if (cached?.receipt) return cached.receipt;
  const session = await state.findSession({
    venue_id: "coinbase_advanced",
    vault_commitment: body.vault_commitment || undefined,
    policy_commitment: body.policy_commitment || undefined,
    allocation_commitment: body.omnibus_allocation?.allocation_commitment || body.allocation_commitment || undefined,
  });
  const instruction = await resolvePrivateCancelTarget(await instructionForBody({
    body,
    recipient,
    venue_id: "coinbase_advanced",
    session,
  }), { state, venue_id: "coinbase_advanced" });
  await enforceInstructionPolicy({ body, instruction, session, state });

  let credential;
  if (body.execution_mode === "partner_omnibus") {
    credential = process.env.PRIVATE_AGENT_VENUE_DRY_RUN === "true"
      ? dryRunCoinbaseCredential()
      : loadPartnerCoinbaseCredential(process.env);
    if (body.omnibus_allocation) {
      await state.putOmnibusAllocation(body.omnibus_allocation);
      await state.reserveOmnibus({
        allocation_commitment: body.omnibus_allocation.allocation_commitment,
        allocation: body.omnibus_allocation,
        work_order_commitment: body.work_order_commitment,
        notional_bucket: String(bucketToUsd(body.session_policy?.max_notional_bucket || "0")),
      });
    }
  } else {
    if (process.env.PRIVATE_AGENT_VENUE_DRY_RUN === "true" && !body.encrypted_execution_vault) {
      credential = dryRunCoinbaseCredential();
    } else {
      const openedVault = await openSealedBundle(body.encrypted_execution_vault, recipient, {
        aadPrefix: "ghola/coinbase-advanced-execution-vault-v1",
        expectedKind: "ghola_coinbase_advanced_execution_vault",
      });
      credential = coinbaseCredentialFromVault(openedVault.json);
    }
  }

  const clientOrderId = await state.deriveClientOrderId("ghola", body.work_order_commitment);
  let adapterResult;
  try {
    adapterResult = await submitCoinbaseExecution({
      credential,
      instruction,
      clientOrderId,
    });
  } catch (error) {
    if (body.execution_mode === "partner_omnibus" && body.omnibus_allocation?.allocation_commitment) {
      await state.releaseOmnibus({
        allocation_commitment: body.omnibus_allocation.allocation_commitment,
        work_order_commitment: body.work_order_commitment,
      });
    }
    throw error;
  }

  const receipt = executionReceipt({
    venue_id: "coinbase_advanced",
    platform_class: "coinbase_style_provider",
    execution_mode: body.execution_mode,
    instruction,
    body,
    status: adapterResult.status,
    provider_ref_seed: adapterResult.provider_ref_seed,
    result_seed: adapterResult.result_seed,
    fills: adapterResult.fills,
    final_proof: adapterResult.final_proof,
    visibility_summary: {
      main_wallet_exposed: false,
      ghola_operator_sees: "commitment_and_ciphertext_only",
      coinbase_sees: body.execution_mode === "partner_omnibus"
        ? "partner_pooled_account_and_order_activity"
        : "byo_account_and_order_activity",
    },
  });
  await state.putExecutionAttempt(body.work_order_commitment, {
    venue_id: "coinbase_advanced",
    platform_class: "coinbase_style_provider",
    execution_mode: body.execution_mode,
    provider_ref_seed: adapterResult.provider_ref_seed,
    result_seed: adapterResult.result_seed,
    fills: adapterResult.fills,
    final_proof: adapterResult.final_proof || null,
    status: adapterResult.status,
    created_at: new Date().toISOString(),
  });
  if (body.execution_mode === "partner_omnibus" && body.omnibus_allocation?.allocation_commitment) {
    for (const fill of receipt.fill_commitments || []) {
      await state.settleOmnibusFill({
        allocation_commitment: body.omnibus_allocation.allocation_commitment,
        work_order_commitment: body.work_order_commitment,
        fill_commitment: fill,
        notional_bucket: String(Math.ceil(estimateOrderNotionalUsd(instruction.order || {}))),
      });
    }
  }
  return state.putIdempotency(body.work_order_commitment, receipt);
}

export async function executeSolanaPerpsOrder({ body, recipient, state }) {
  const cached = await state.getIdempotency(body.work_order_commitment);
  if (cached?.receipt) return cached.receipt;
  const venueId = normalizeSolanaPerpsVenueId(body.venue_id);
  const executionMode = body.execution_mode === "ghola_pooled" ? "ghola_pooled" : "user_stealth";
  let credential = null;
  if (process.env.PRIVATE_AGENT_VENUE_DRY_RUN !== "true") {
    if (executionMode === "ghola_pooled") {
      credential = loadPooledSolanaPerpsCredential(venueId);
    } else {
      const openedVault = await openSealedBundle(body.encrypted_execution_vault, recipient, {
        aadPrefix: "ghola/solana-perps-execution-vault-v1",
        expectedKind: "ghola_solana_perps_execution_vault",
      });
      credential = solanaPerpsCredentialFromVault(openedVault.json);
    }
  }
  const session = await state.findSession({
    venue_id: venueId,
    vault_commitment: body.vault_commitment || undefined,
    allocation_commitment: body.allocation_commitment || undefined,
    policy_commitment: body.policy_commitment || undefined,
  });
  const instruction = await resolvePrivateCancelTarget(await instructionForBody({
    body,
    recipient,
    venue_id: venueId,
    session,
  }), { state, venue_id: venueId });
  await enforceInstructionPolicy({ body, instruction, session, state });
  const clientOrderId = await state.deriveClientOrderId(venueId, body.work_order_commitment);
  const adapterResult = await submitSolanaPerpsExecution({
    credential,
    instruction,
    clientOrderId,
    venueId,
    executionMode,
  });
  await state.putExecutionAttempt(body.work_order_commitment, {
    venue_id: venueId,
    platform_class: "solana_perps_market",
    execution_mode: executionMode,
    provider_ref_seed: adapterResult.provider_ref_seed,
    result_seed: adapterResult.result_seed,
    fills: adapterResult.fills,
    final_proof: adapterResult.final_proof || null,
    status: adapterResult.status,
    created_at: new Date().toISOString(),
  });
  const receipt = executionReceipt({
    venue_id: venueId,
    platform_class: "solana_perps_market",
    execution_mode: executionMode,
    instruction,
    body,
    status: adapterResult.status,
    provider_ref_seed: adapterResult.provider_ref_seed,
    result_seed: adapterResult.result_seed,
    fills: adapterResult.fills,
    final_proof: adapterResult.final_proof,
    visibility_summary: {
      main_wallet_exposed: false,
      ghola_operator_sees: "commitment_and_ciphertext_only",
      solana_perps_sees: executionMode === "ghola_pooled"
        ? "pooled_venue_account_and_order_activity"
        : "stealth_venue_account_and_order_activity",
      venue_access_source: executionMode,
      ghola_access_role: "sealed_private_execution_router",
      venue_gate: "venue_accepts_or_rejects_account_and_order",
      public_chain_sees: "venue_account_activity_visible_if_public_settlement",
    },
  });
  return state.putIdempotency(body.work_order_commitment, receipt);
}

export async function executeJupiterSwapOrder({ body, recipient, state }) {
  const cached = await state.getIdempotency(body.work_order_commitment);
  if (cached?.receipt) return cached.receipt;
  const executionMode = body.execution_mode === "ghola_pooled" ? "ghola_pooled" : "user_stealth";
  let credential = null;
  if (process.env.PRIVATE_AGENT_VENUE_DRY_RUN !== "true") {
    if (executionMode === "ghola_pooled") {
      credential = loadPooledJupiterCredential();
    } else {
      const openedVault = await openSealedBundle(body.encrypted_execution_vault, recipient, {
        aadPrefix: "ghola/solana-swap-execution-vault-v1",
        expectedKind: "ghola_solana_swap_execution_vault",
      });
      credential = jupiterCredentialFromVault(openedVault.json);
    }
  }
  const session = await state.findSession({
    venue_id: "jupiter",
    vault_commitment: body.vault_commitment || undefined,
    allocation_commitment: body.allocation_commitment || undefined,
    policy_commitment: body.policy_commitment || undefined,
  });
  const instruction = await instructionForBody({
    body,
    recipient,
    venue_id: "jupiter",
    session,
  });
  await enforceInstructionPolicy({ body, instruction, session, state });
  const clientOrderId = await state.deriveClientOrderId("jupiter", body.work_order_commitment);
  const adapterResult = await submitJupiterSwapExecution({
    credential,
    instruction,
    clientOrderId,
    executionMode,
  });
  await state.putExecutionAttempt(body.work_order_commitment, {
    venue_id: "jupiter",
    platform_class: "solana_swap_aggregator",
    execution_mode: executionMode,
    provider_ref_seed: adapterResult.provider_ref_seed,
    result_seed: adapterResult.result_seed,
    fills: adapterResult.fills,
    final_proof: adapterResult.final_proof || null,
    status: adapterResult.status,
    created_at: new Date().toISOString(),
  });
  const receipt = executionReceipt({
    venue_id: "jupiter",
    platform_class: "solana_swap_aggregator",
    execution_mode: executionMode,
    instruction,
    body,
    status: adapterResult.status,
    provider_ref_seed: adapterResult.provider_ref_seed,
    result_seed: adapterResult.result_seed,
    fills: adapterResult.fills,
    final_proof: adapterResult.final_proof,
    visibility_summary: {
      main_wallet_exposed: false,
      ghola_operator_sees: "commitment_and_ciphertext_only",
      jupiter_sees: executionMode === "ghola_pooled"
        ? "pooled_swap_authority_and_route"
        : "stealth_swap_authority_and_route",
      venue_access_source: executionMode,
      ghola_access_role: "sealed_private_execution_router",
      venue_gate: "jupiter_accepts_or_rejects_swap",
      public_chain_sees: "swap_authority_activity_visible_if_public_settlement",
    },
  });
  return state.putIdempotency(body.work_order_commitment, receipt);
}

export async function executeAutopilotOrder({
  venue_id,
  operation_class,
  work_order_commitment,
  policy_commitment,
  session_policy,
  instruction,
  execution = {},
  recipient,
  state,
}) {
  const body = {
    version: 1,
    work_order_commitment,
    policy_commitment,
    session_policy,
    operation_class,
    [AUTOPILOT_INTERNAL_INSTRUCTION]: instruction,
    ...execution,
  };
  if (venue_id === "jupiter") {
    return executeJupiterSwapOrder({
      body: {
        ...body,
        venue_id: "jupiter",
        platform_class: "solana_swap_aggregator",
        execution_mode: execution.execution_mode || "ghola_pooled",
      },
      recipient,
      state,
    });
  }
  if (venue_id === "phoenix" || venue_id === "backpack") {
    return executeSolanaPerpsOrder({
      body: {
        ...body,
        venue_id,
        platform_class: "solana_perps_market",
        execution_mode: execution.execution_mode || "ghola_pooled",
      },
      recipient,
      state,
    });
  }
  if (venue_id === "hyperliquid") {
    return executeHyperliquidOrder({
      body: {
        ...body,
        venue_id: "hyperliquid",
        platform_class: "hyperliquid_style_market",
        execution_mode: execution.execution_mode || "ghola_pooled",
      },
      recipient,
      state,
    });
  }
  if (venue_id === "coinbase_advanced") {
    return executeCoinbaseOrder({
      body: {
        ...body,
        venue_id: "coinbase_advanced",
        platform_class: "coinbase_style_provider",
        execution_mode: execution.execution_mode || "partner_omnibus",
      },
      recipient,
      state,
    });
  }
  throw new PrivateExecutionError("autopilot venue is unsupported", 400);
}

export async function verifyAutopilotOrder({
  venue_id,
  operation_class,
  work_order_commitment,
  policy_commitment,
  session_policy,
  instruction,
  execution = {},
  recipient,
  state,
}) {
  const body = {
    version: 1,
    work_order_commitment,
    policy_commitment,
    session_policy,
    operation_class,
    [AUTOPILOT_INTERNAL_INSTRUCTION]: instruction,
    ...execution,
  };
  if (venue_id === "jupiter") {
    return verifyJupiterSwapNoSubmit({
      body: {
        ...body,
        venue_id: "jupiter",
        platform_class: "solana_swap_aggregator",
        execution_mode: execution.execution_mode || "user_stealth",
      },
      recipient,
      state,
    });
  }
  if (venue_id === "hyperliquid") {
    return verifyHyperliquidOrderNoSubmit({
      body: {
        ...body,
        venue_id: "hyperliquid",
        platform_class: "hyperliquid_style_market",
        execution_mode: execution.execution_mode || "byo_api_key",
      },
      recipient,
      state,
    });
  }
  if (venue_id === "phoenix" || venue_id === "backpack") {
    return verifySolanaPerpsOrderNoSubmit({
      body: {
        ...body,
        venue_id,
        platform_class: "solana_perps_market",
        execution_mode: execution.execution_mode || (venue_id === "backpack" ? "ghola_pooled" : "user_stealth"),
      },
      recipient,
      state,
    });
  }
  if (venue_id === "coinbase_advanced") {
    return verifyCoinbaseOrderNoSubmit({
      body: {
        ...body,
        venue_id: "coinbase_advanced",
        platform_class: "coinbase_style_provider",
        execution_mode: execution.execution_mode || "byo_api_key",
      },
      recipient,
      state,
    });
  }
  throw new PrivateExecutionError("autopilot venue is unsupported", 400);
}

export async function verifySolanaPerpsOrderNoSubmit({ body, recipient, state }) {
  const venueId = normalizeSolanaPerpsVenueId(body.venue_id);
  const executionMode = body.execution_mode === "ghola_pooled" ? "ghola_pooled" : "user_stealth";
  const credential = executionMode === "ghola_pooled"
    ? loadPooledSolanaPerpsCredential(venueId)
    : solanaPerpsCredentialFromVault((await openSealedBundle(body.encrypted_execution_vault, recipient, {
        aadPrefix: "ghola/solana-perps-execution-vault-v1",
        expectedKind: "ghola_solana_perps_execution_vault",
      })).json);
  const session = await state.findSession({
    venue_id: venueId,
    vault_commitment: body.vault_commitment || undefined,
    allocation_commitment: body.allocation_commitment || undefined,
    policy_commitment: body.policy_commitment || undefined,
  });
  const instruction = await resolvePrivateCancelTarget(await instructionForBody({
    body,
    recipient,
    venue_id: venueId,
    session,
  }), { state, venue_id: venueId });
  await enforceInstructionPolicy({ body, instruction, session, state: null });
  const clientOrderId = await state.deriveClientOrderId(venueId, body.work_order_commitment);
  const adapterResult = await verifySolanaPerpsNoSubmit({
    credential,
    instruction,
    clientOrderId,
    venueId,
    executionMode,
  });
  const providerRefCommitment = commitment(`${venueId}_provider_ref`, adapterResult.provider_ref_seed);
  return {
    version: 1,
    venue_id: venueId,
    platform_class: "solana_perps_market",
    execution_mode: executionMode,
    status: "verified_no_funds",
    work_order_commitment: body.work_order_commitment,
    vault_commitment: body.vault_commitment || null,
    provider_ref_commitment: providerRefCommitment,
    result_commitment: commitment(`${venueId}_result`, {
      work_order_commitment: body.work_order_commitment,
      provider_ref_commitment: providerRefCommitment,
      status: "verified_no_funds",
      seed: adapterResult.result_seed,
    }),
    verification_commitment: commitment("solana_perps_no_submit_verification", {
      work_order_commitment: body.work_order_commitment,
      provider_ref_commitment: providerRefCommitment,
      result_seed: adapterResult.result_seed,
      checks: adapterResult.checks,
    }),
    checks: adapterResult.checks,
    visibility_summary: {
      main_wallet_exposed: false,
      ghola_operator_sees: "commitment_and_ciphertext_only",
      solana_perps_sees: "no_submit_order_packet_prepared",
      venue_access_source: executionMode,
      ghola_access_role: "sealed_private_execution_router",
      venue_gate: "not_tested_without_submit",
      public_chain_sees: "no_transaction_sent",
    },
    updated_at: new Date().toISOString(),
  };
}

export async function verifyCoinbaseOrderNoSubmit({ body, recipient, state }) {
  const session = await state.findSession({
    venue_id: "coinbase_advanced",
    vault_commitment: body.vault_commitment || undefined,
    policy_commitment: body.policy_commitment || undefined,
    allocation_commitment: body.omnibus_allocation?.allocation_commitment || body.allocation_commitment || undefined,
  });
  const instruction = await resolvePrivateCancelTarget(await instructionForBody({
    body,
    recipient,
    venue_id: "coinbase_advanced",
    session,
  }), { state, venue_id: "coinbase_advanced" });
  await enforceInstructionPolicy({ body, instruction, session, state: null });

  let credential;
  if (body.execution_mode === "partner_omnibus") {
    credential = process.env.PRIVATE_AGENT_VENUE_DRY_RUN === "true"
      ? dryRunCoinbaseCredential()
      : loadPartnerCoinbaseCredential(process.env);
  } else if (process.env.PRIVATE_AGENT_VENUE_DRY_RUN === "true" && !body.encrypted_execution_vault) {
    credential = dryRunCoinbaseCredential();
  } else {
    const openedVault = await openSealedBundle(body.encrypted_execution_vault, recipient, {
      aadPrefix: "ghola/coinbase-advanced-execution-vault-v1",
      expectedKind: "ghola_coinbase_advanced_execution_vault",
    });
    credential = coinbaseCredentialFromVault(openedVault.json);
  }

  const clientOrderId = await state.deriveClientOrderId("ghola", body.work_order_commitment);
  const adapterResult = await verifyCoinbaseNoSubmit({
    credential,
    instruction,
    clientOrderId,
  });
  const providerRefCommitment = commitment("coinbase_provider_ref", adapterResult.provider_ref_seed);
  return {
    version: 1,
    venue_id: "coinbase_advanced",
    platform_class: "coinbase_style_provider",
    execution_mode: body.execution_mode || "byo_api_key",
    status: "verified_no_funds",
    work_order_commitment: body.work_order_commitment,
    vault_commitment: body.vault_commitment || null,
    allocation_commitment: body.omnibus_allocation?.allocation_commitment || body.allocation_commitment || null,
    provider_ref_commitment: providerRefCommitment,
    result_commitment: commitment("coinbase_result", {
      work_order_commitment: body.work_order_commitment,
      provider_ref_commitment: providerRefCommitment,
      status: "verified_no_funds",
      seed: adapterResult.result_seed,
    }),
    verification_commitment: commitment("coinbase_no_submit_verification", {
      work_order_commitment: body.work_order_commitment,
      provider_ref_commitment: providerRefCommitment,
      result_seed: adapterResult.result_seed,
      checks: adapterResult.checks,
    }),
    checks: adapterResult.checks,
    visibility_summary: {
      main_wallet_exposed: false,
      ghola_operator_sees: "commitment_and_ciphertext_only",
      coinbase_sees: "no_submit_order_request_prepared",
      venue_access_source: body.execution_mode === "partner_omnibus" ? "partner_omnibus" : "user_provided_credentials",
      ghola_access_role: "sealed_private_execution_router",
      venue_gate: "not_tested_without_submit",
      public_chain_sees: "no_transaction_sent",
    },
    updated_at: new Date().toISOString(),
  };
}

export async function verifyJupiterSwapNoSubmit({ body, recipient, state }) {
  const executionMode = body.execution_mode === "ghola_pooled" ? "ghola_pooled" : "user_stealth";
  const credential = executionMode === "ghola_pooled"
    ? loadPooledJupiterCredential()
    : jupiterCredentialFromVault((await openSealedBundle(body.encrypted_execution_vault, recipient, {
        aadPrefix: "ghola/solana-swap-execution-vault-v1",
        expectedKind: "ghola_solana_swap_execution_vault",
      })).json);
  const session = await state.findSession({
    venue_id: "jupiter",
    vault_commitment: body.vault_commitment || undefined,
    allocation_commitment: body.allocation_commitment || undefined,
    policy_commitment: body.policy_commitment || undefined,
  });
  const instruction = await instructionForBody({
    body,
    recipient,
    venue_id: "jupiter",
    session,
  });
  await enforceInstructionPolicy({ body, instruction, session, state: null });
  const clientOrderId = await state.deriveClientOrderId("jupiter", body.work_order_commitment);
  const adapterResult = await verifyJupiterSwapNoSubmitAdapter({
    credential,
    instruction,
    clientOrderId,
    executionMode,
  });
  const providerRefCommitment = commitment("jupiter_provider_ref", adapterResult.provider_ref_seed);
  return {
    version: 1,
    venue_id: "jupiter",
    platform_class: "solana_swap_aggregator",
    execution_mode: executionMode,
    status: "verified_no_funds",
    work_order_commitment: body.work_order_commitment,
    vault_commitment: body.vault_commitment || null,
    allocation_commitment: body.allocation_commitment || null,
    provider_ref_commitment: providerRefCommitment,
    result_commitment: commitment("jupiter_result", {
      work_order_commitment: body.work_order_commitment,
      provider_ref_commitment: providerRefCommitment,
      status: "verified_no_funds",
      seed: adapterResult.result_seed,
    }),
    verification_commitment: commitment("jupiter_no_submit_verification", {
      work_order_commitment: body.work_order_commitment,
      provider_ref_commitment: providerRefCommitment,
      result_seed: adapterResult.result_seed,
      checks: adapterResult.checks,
    }),
    checks: adapterResult.checks,
    final_proof: adapterResult.final_proof,
    visibility_summary: {
      main_wallet_exposed: false,
      ghola_operator_sees: "commitment_and_ciphertext_only",
      jupiter_sees: "no_submit_swap_transaction_prepared",
      venue_access_source: executionMode,
      ghola_access_role: "sealed_private_execution_router",
      venue_gate: "not_tested_without_submit",
      public_chain_sees: "no_transaction_sent",
    },
    updated_at: new Date().toISOString(),
  };
}

export async function verifyHyperliquidOrderNoSubmit({ body, recipient, state }) {
  const executionMode = hyperliquidExecutionMode(body);
  let credential;
  let allocation = null;
  if (isHyperliquidAllocationMode(executionMode)) {
    const allocationCommitment = body.managed_allocation?.allocation_commitment ||
      body.managed_allocation_commitment ||
      body.allocation_commitment;
    const record = await state.getHyperliquidManagedAllocation(allocationCommitment);
    if (!record?.allocation || record.allocation.status !== "allocated") {
      throw new PrivateExecutionError("hyperliquid managed allocation is unavailable", 404);
    }
    allocation = record.allocation;
    credential = loadManagedHyperliquidCredential(allocation);
  } else {
    if (process.env.PRIVATE_AGENT_VENUE_DRY_RUN === "true" && !body.encrypted_execution_vault) {
      credential = dryRunHyperliquidCredential();
    } else {
      const openedVault = await openSealedBundle(body.encrypted_execution_vault, recipient, {
        aadPrefix: "ghola/hyperliquid-execution-vault-v1",
        expectedKind: "ghola_hyperliquid_execution_vault",
      });
      credential = hyperliquidCredentialFromVault(openedVault.json);
    }
  }
  const session = await state.findSession({
    venue_id: "hyperliquid",
    vault_commitment: executionMode === "byo_api_key" ? body.vault_commitment : undefined,
    allocation_commitment: isHyperliquidAllocationMode(executionMode)
      ? body.managed_allocation_commitment || body.allocation_commitment
      : undefined,
    policy_commitment: body.policy_commitment,
  });
  const instruction = await resolvePrivateCancelTarget(await instructionForBody({
    body,
    recipient,
    venue_id: "hyperliquid",
    session,
  }), { state, venue_id: "hyperliquid" });
  await enforceInstructionPolicy({ body, instruction, session, state: null });
  const cloid = await state.deriveHyperliquidCloid(body.work_order_commitment);
  const adapterResult = await verifyHyperliquidNoSubmit({
    credential,
    instruction,
    cloid,
    executionMode,
  });
  const providerRefCommitment = commitment("hyperliquid_provider_ref", adapterResult.provider_ref_seed);
  return {
    version: 1,
    platform_class: "hyperliquid_style_market",
    execution_mode: executionMode,
    status: "verified_no_funds",
    work_order_commitment: body.work_order_commitment,
    vault_commitment: body.vault_commitment || null,
    allocation_commitment: allocation?.allocation_commitment || body.managed_allocation_commitment || body.allocation_commitment || null,
    provider_ref_commitment: providerRefCommitment,
    result_commitment: commitment("hyperliquid_result", {
      work_order_commitment: body.work_order_commitment,
      provider_ref_commitment: providerRefCommitment,
      status: "verified_no_funds",
      seed: adapterResult.result_seed,
    }),
    verification_commitment: commitment("hyperliquid_no_submit_verification", {
      work_order_commitment: body.work_order_commitment,
      provider_ref_commitment: providerRefCommitment,
      result_seed: adapterResult.result_seed,
      checks: adapterResult.checks,
    }),
    checks: adapterResult.checks,
    visibility_summary: {
      main_wallet_exposed: false,
      ghola_operator_sees: "commitment_and_ciphertext_only",
      hyperliquid_sees: "no_submit_order_request_prepared",
      venue_access_source: hyperliquidVenueAccessSource(executionMode),
      ghola_access_role: "sealed_private_execution_router",
      venue_gate: "not_tested_without_submit",
      public_chain_sees: "no_transaction_sent",
    },
    updated_at: new Date().toISOString(),
  };
}

export async function reconcileStoredExecution({ body, state, venue_id, platform_class }) {
  const attempted = await state.getExecutionAttempt(body.work_order_commitment);
  const cached = (await state.getIdempotency(body.work_order_commitment))?.receipt || null;
  const status = attempted?.status === "failed" ? "failed" : "reconciled";
  const providerRefSeed = attempted?.provider_ref_seed ||
    cached?.provider_ref_commitment ||
    {
      venue: venue_id,
      work_order_commitment: body.work_order_commitment,
      reconciliation_only: true,
    };
  const resultSeed = attempted?.result_seed ||
    cached?.result_commitment ||
    {
      kind: `${venue_id}_reconcile`,
      status,
      work_order_commitment: body.work_order_commitment,
    };
  const finalProof = attempted?.final_proof || {
    version: 1,
    proof_kind: "connector_execution_reconciliation_v1",
    status,
    venue_id,
    broadcast_performed: Boolean(attempted || cached),
    final_venue_execution_proven: Boolean(attempted || cached),
    final_fill_proven: Array.isArray(attempted?.fills) && attempted.fills.length > 0,
    checked_at: new Date().toISOString(),
  };
  return executionReceipt({
    venue_id,
    platform_class,
    execution_mode: body.execution_mode,
    body: {
      ...body,
      operation_class: "reconcile",
    },
    status,
    provider_ref_seed: providerRefSeed,
    result_seed: resultSeed,
    fills: attempted?.fills || cached?.fill_commitments || [],
    final_proof: finalProof,
    visibility_summary: cached?.visibility_summary || {
      main_wallet_exposed: false,
      ghola_operator_sees: "commitment_and_ciphertext_only",
      public_chain_sees: "reconciled_from_worker_state",
    },
  });
}

async function instructionForBody({ body, recipient, venue_id, session }) {
  if (body[AUTOPILOT_INTERNAL_INSTRUCTION]) {
    return normalizeInstruction(body[AUTOPILOT_INTERNAL_INSTRUCTION], {
      venue_id,
      operation_class: body.operation_class,
    });
  }
  if (body.encrypted_execution_instruction_bundle) {
    const opened = await openSealedBundle(body.encrypted_execution_instruction_bundle, recipient, {
      aadPrefix: "ghola/private-execution-instruction-v1",
      expectedKind: "ghola_private_execution_instruction",
    });
    const boundToWorkOrder = opened.associatedDataText.includes(`work_order:${body.work_order_commitment}`);
    const boundToPreview = body.preview_commitment &&
      opened.associatedDataText.includes(`preview:${body.preview_commitment}`);
    if (!boundToWorkOrder && !boundToPreview) {
      throw new PrivateExecutionError("execution instruction commitment mismatch");
    }
    return normalizeInstruction(opened.json, {
      venue_id,
      operation_class: body.operation_class,
    });
  }
  const template = session?.strategy_policy?.execution_instruction_template;
  if (template) {
    return normalizeInstruction(
      {
        version: 1,
        kind: "ghola_private_execution_instruction",
        venue_id,
        operation_class: body.operation_class,
        order: template.order,
        cancel: template.cancel,
        reconcile: template.reconcile,
      },
      { venue_id, operation_class: body.operation_class },
    );
  }
  throw new PrivateExecutionError("encrypted execution instruction is required");
}

async function resolvePrivateCancelTarget(instruction, { state, venue_id }) {
  const target = instruction?.cancel?.target_work_order_commitment;
  if (instruction?.operation_class !== "cancel" || !target) return instruction;
  if (!(await state.getIdempotency(target))?.receipt) {
    throw new PrivateExecutionError("cancel target work order is unknown");
  }
  const clientOrderId = venue_id === "hyperliquid"
    ? await state.deriveHyperliquidCloid(target)
    : await state.deriveClientOrderId("ghola", target);
  return {
    ...instruction,
    cancel: {
      ...instruction.cancel,
      client_order_id: clientOrderId,
    },
  };
}

function hyperliquidExecutionMode(body) {
  if (body.execution_mode === "hyperliquid_native_vault") return "hyperliquid_native_vault";
  if (body.execution_mode === "ghola_pooled") return "ghola_pooled";
  return body.execution_mode === "managed_testnet" ||
      body.managed_allocation_commitment ||
      (body.allocation_commitment && body.execution_mode !== "byo_api_key")
    ? "managed_testnet"
    : "byo_api_key";
}

function isHyperliquidAllocationMode(mode) {
  return mode === "managed_testnet" || mode === "ghola_pooled" || mode === "hyperliquid_native_vault";
}

function hyperliquidVenueAccessSource(mode) {
  if (mode === "ghola_pooled") return "ghola_pooled_venue_account";
  if (mode === "hyperliquid_native_vault") return "hyperliquid_native_vault";
  if (mode === "managed_testnet") return "ghola_managed_testnet";
  return "user_provided_credentials";
}

function hyperliquidAccountSource(mode) {
  if (mode === "ghola_pooled") return "ghola_pooled";
  if (mode === "hyperliquid_native_vault") return "hyperliquid_native_vault";
  if (mode === "managed_testnet") return "ghola_managed";
  return "sealed_byo";
}

function managedCredentialIndex(seed, length) {
  if (length <= 1) return 0;
  const hex = sha256Hex(String(seed || "hyperliquid-managed"));
  return Number.parseInt(hex.slice(0, 8), 16) % length;
}

function publicHyperliquidManagedAllocation(allocation) {
  const { credential_ref: _credentialRef, ...publicAllocation } = allocation;
  return publicAllocation;
}

function executionReceipt(input) {
  const providerRefCommitment = commitment(`${input.venue_id}_provider_ref`, input.provider_ref_seed);
  const fillCommitments = Array.isArray(input.fills)
    ? input.fills.map((fill) => commitment(`${input.venue_id}_fill`, fill))
    : [];
  const mandate = input.instruction?.mandate || null;
  return {
    version: 1,
    venue_id: input.venue_id === "hyperliquid" ? undefined : input.venue_id,
    platform_class: input.platform_class,
    execution_mode: input.execution_mode || undefined,
    status: input.status || "submitted",
    work_order_commitment: input.body.work_order_commitment,
    platform_fee_policy_commitment: input.body.platform_fee_policy_commitment || null,
    vault_commitment: input.body.vault_commitment || null,
    allocation_commitment: input.body.omnibus_allocation?.allocation_commitment ||
      input.body.managed_allocation_commitment ||
      input.body.allocation_commitment ||
      null,
    provider_ref_commitment: providerRefCommitment,
    result_commitment: commitment(`${input.venue_id}_result`, {
      work_order_commitment: input.body.work_order_commitment,
      provider_ref_commitment: providerRefCommitment,
      platform_fee_policy_commitment: input.body.platform_fee_policy_commitment || null,
      status: input.status,
      seed: input.result_seed,
    }),
    mandate_commitment: mandate
      ? commitment("agent_mandate", {
          work_order_commitment: input.body.work_order_commitment,
          venue_id: input.venue_id,
          operation_class: input.instruction?.operation_class || null,
          mandate,
        })
      : null,
    mandate_status: mandate ? "enforced" : undefined,
    fill_commitments: fillCommitments,
    final_proof: input.final_proof || null,
    visibility_summary: input.visibility_summary,
    updated_at: new Date().toISOString(),
  };
}

function credentialVerificationResult(input) {
  const verificationCommitment = commitment("venue_credential_verification", {
    venue_id: input.venue_id,
    source: input.source,
    can_read: input.can_read,
    can_trade: input.can_trade,
    can_withdraw: input.can_withdraw,
    evidence_seed: input.evidence_seed,
  });
  return {
    version: 1,
    venue_id: input.venue_id,
    status: input.can_read && input.can_trade && !input.can_withdraw ? "verified" : "blocked",
    can_read: input.can_read === true,
    can_trade: input.can_trade === true,
    can_withdraw: input.can_withdraw === true,
    verification_commitment: verificationCommitment,
    evidence_commitment: commitment("venue_credential_verification_evidence", input.evidence_seed || {}),
    source: input.source,
    checked_at: new Date().toISOString(),
  };
}

function publicSessionPolicy(policy, policyCommitment) {
  if (!policy || typeof policy !== "object") return { policy_commitment: policyCommitment };
  return {
    policy_commitment: policyCommitment,
    market_allowlist: Array.isArray(policy.market_allowlist) ? policy.market_allowlist.map(String) : [],
    max_notional_bucket: typeof policy.max_notional_bucket === "string" ? policy.max_notional_bucket : "25",
    max_order_count: Number.isInteger(policy.max_order_count) ? policy.max_order_count : 10,
    kill_switch: policy.kill_switch === true,
    expires_at: typeof policy.expires_at === "string" ? policy.expires_at : null,
  };
}

function sanitizeStrategyPolicy(policy) {
  if (!policy || typeof policy !== "object") return null;
  const template = policy.execution_instruction_template &&
    typeof policy.execution_instruction_template === "object"
    ? policy.execution_instruction_template
    : null;
  return {
    version: policy.version || 1,
    strategy_id: policy.strategy_id || null,
    allowed_assets: Array.isArray(policy.allowed_assets) ? policy.allowed_assets.map(String) : [],
    max_trade_micro_usdc: Number.isFinite(policy.max_trade_micro_usdc)
      ? policy.max_trade_micro_usdc
      : null,
    daily_cap_micro_usdc: Number.isFinite(policy.daily_cap_micro_usdc)
      ? policy.daily_cap_micro_usdc
      : null,
    max_actions_per_day: Number.isInteger(policy.max_actions_per_day)
      ? policy.max_actions_per_day
      : null,
    execution_instruction_template: template,
  };
}

function dryRunCoinbaseCredential() {
  return {
    network: "mainnet",
    base_url: "https://api.coinbase.com/api/v3/brokerage",
    api_key_name: "organizations/dry-run/apiKeys/dry-run",
    api_private_key_pem: "-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIGvY6aoo2dGd5dbwG7Hz3Tj8MwbD0QuR4APs8dP8s91BoAoGCCqGSM49\nAwEHoUQDQgAEUxJ3vyaSbfNuLS9wEVxAIUlA7PAwHFrs4zSj34tpf8jEABERLQzt\nBmg+ObHTkW0HnqRyx5m8lxbvqD8AqXjp3w==\n-----END EC PRIVATE KEY-----",
    portfolio_id: null,
  };
}

function dryRunHyperliquidCredential() {
  return {
    network: "testnet",
    base_url: "https://api.hyperliquid-testnet.xyz",
    account_address: "0x0000000000000000000000000000000000000001",
    api_wallet_private_key: "0x1111111111111111111111111111111111111111111111111111111111111111",
    agent_name: "dry-run-byo",
  };
}

function isEvmAddress(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  return JSON.stringify(value, Object.keys(value || {}).sort());
}
