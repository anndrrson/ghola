import { createHash } from "node:crypto";
import { venueAdapterCapability } from "@ghola/execution-core";
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
  readHyperliquidCarryAccountMetrics,
  readHyperliquidFundingSettlements,
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
import {
  asterCredentialFromVault,
  dryRunAsterCredential,
  readAsterAccountState,
  readAsterFundingSettlements,
  submitAndReconcileAsterExecution,
  verifyAsterNoSubmit,
} from "../venues/aster.js";
import {
  lighterClientOrderIndex,
  openLighterExecutionCredential,
  readLighterFundingSettlements,
  readLighterWithdrawalRouteQuote,
  submitAndReconcileLighterExecution,
  verifyLighterCredential,
  verifyLighterNoSubmit,
} from "../venues/lighter.js";

export class PrivateExecutionError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "PrivateExecutionError";
    this.status = status;
  }
}

async function persistPreSubmissionAttempt({
  state,
  workOrderCommitment,
  attempt,
  readOnlyReconcile,
  retryMessage,
}) {
  if (readOnlyReconcile) {
    await state.putExecutionAttempt(workOrderCommitment, attempt);
    return;
  }
  if (typeof state.claimExecutionAttempt !== "function") {
    throw new PrivateExecutionError("atomic execution attempt state is unavailable", 503);
  }
  const claim = await state.claimExecutionAttempt(workOrderCommitment, attempt);
  if (!claim?.ok) throw new PrivateExecutionError(retryMessage, 409);
}

const AUTOPILOT_INTERNAL_INSTRUCTION = Symbol("ghola.autopilot.internal_instruction");
const HYPERLIQUID_PROOF_PROTOCOL = "ghola-hyperliquid-proof-v2";
const ACCOUNT_BOUND_COMMITMENT = /^[A-Za-z0-9_.:-]{8,240}$/;
const ACTIVE_CARRY_ADAPTER_STATUSES = new Set(["proven", "implemented_unproven"]);
const CARRY_PRIVATE_EXECUTION_ADAPTERS = Object.freeze({
  hyperliquid_v1: privateCarryAdapter({
    venueId: "hyperliquid",
    platformClass: "hyperliquid_style_market",
    execute: executeHyperliquidOrder,
    verify: verifyHyperliquidOrderNoSubmit,
    executeMode: "ghola_pooled",
    verifyMode: "byo_api_key",
  }),
  aster_v1: privateCarryAdapter({
    venueId: "aster",
    platformClass: "hyperliquid_style_market",
    execute: executeAsterOrder,
    verify: verifyAsterOrderNoSubmit,
    executeMode: "byo_api_key",
    verifyMode: "byo_api_key",
  }),
  lighter_v1: privateCarryAdapter({
    venueId: "lighter",
    platformClass: "hyperliquid_style_market",
    execute: executeLighterOrder,
    verify: verifyLighterOrderNoSubmit,
    executeMode: "byo_api_key",
    verifyMode: "byo_api_key",
  }),
});

export function registeredCarryAdapterId(venueId, capability) {
  const declared = venueAdapterCapability(venueId, capability);
  if (!declared || !ACTIVE_CARRY_ADAPTER_STATUSES.has(declared.status)) return null;
  const registered = CARRY_PRIVATE_EXECUTION_ADAPTERS[declared.adapter_id];
  if (!registered || registered.venue_id !== venueId) {
    throw new PrivateExecutionError("carry adapter registry binding is unavailable", 409);
  }
  return declared.adapter_id;
}

function registeredCarryAdapter(venueId, capability) {
  const adapterId = registeredCarryAdapterId(venueId, capability);
  return adapterId ? CARRY_PRIVATE_EXECUTION_ADAPTERS[adapterId] : null;
}

function privateCarryAdapter({ venueId, platformClass, execute, verify, executeMode, verifyMode }) {
  return Object.freeze({
    venue_id: venueId,
    execute,
    verify,
    body(body, execution, phase) {
      return {
        ...body,
        venue_id: venueId,
        platform_class: platformClass,
        execution_mode: execution.execution_mode || (phase === "execute" ? executeMode : verifyMode),
      };
    },
  });
}

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
    await openAccountBoundExecutionVault({
      body,
      recipient,
      venueId: "hyperliquid",
      expectedKind: "ghola_hyperliquid_execution_vault",
      allowedNetworks: ["mainnet", "testnet"],
    });
  } else if (body.managed_allocation?.credential_ref) {
    await state.putHyperliquidManagedAllocation(body.managed_allocation);
  } else {
    const allocationCommitment = body.managed_allocation_commitment || body.allocation_commitment;
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
  const executionMode = body.execution_mode === "ghola_pooled" ? "ghola_pooled" : "managed_testnet";
  const network = executionMode === "ghola_pooled" ? "mainnet" : "testnet";
  const refs = hyperliquidManagedAccountRefs()
    .filter((ref) => ref.network === network);
  if (process.env.PRIVATE_AGENT_VENUE_DRY_RUN !== "true" && refs.length === 0) {
    throw new PrivateExecutionError(
      executionMode === "ghola_pooled"
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
  });
  const allocation = {
    version: 1,
    venue_id: "hyperliquid",
    platform_class: "hyperliquid_style_market",
    execution_mode: executionMode,
    network,
    status: "allocated",
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
    eligibility_commitment: body.eligibility_commitment || null,
    funding_evidence_commitment: body.funding_evidence_commitment || null,
    credential_ref: selected.credential_ref,
    session_policy: policy,
    allowed_operations: ["read", "limit_order", "cancel", "reconcile"],
    blocked_operations: ["withdraw", "vault_transfer", "leverage_escalation", "staking"],
    visibility_summary: {
      main_wallet_exposed: false,
      ghola_operator_sees: "commitment_and_ciphertext_only",
      hyperliquid_sees: "execution_account_and_order_activity",
      public_chain_sees: executionMode === "ghola_pooled"
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
  const readOnlyReconcile = body.operation_class === "reconcile";
  const cached = await state.getIdempotency(body.work_order_commitment);
  if (cached?.receipt && !readOnlyReconcile) return cached.receipt;
  const priorAttempt = await state.getExecutionAttempt(body.work_order_commitment);
  if (!readOnlyReconcile && ["pending", "ambiguous", "submitted", "filled", "cancelled", "reconciled"].includes(priorAttempt?.status)) {
    throw new PrivateExecutionError(
      "hyperliquid work order already has a durable submission attempt; reconcile it instead of retrying",
      409,
    );
  }
  const { executionMode, credential, allocation } = await hyperliquidCredentialForBody({ body, recipient, state });
  const session = await state.findSession({
    venue_id: "hyperliquid",
    vault_commitment: executionMode === "byo_api_key" ? body.vault_commitment : undefined,
    allocation_commitment: isHyperliquidAllocationMode(executionMode)
      ? body.managed_allocation_commitment || body.allocation_commitment
      : undefined,
    policy_commitment: body.policy_commitment,
  });
  const instruction = await resolvePrivateOrderTarget(await instructionForBody({
    body,
    recipient,
    venue_id: "hyperliquid",
    session,
  }), { state, venue_id: "hyperliquid", body });
  await enforceInstructionPolicy({
    body,
    instruction,
    session,
    state,
    trusted_internal: Boolean(body[AUTOPILOT_INTERNAL_INSTRUCTION]),
  });
  const cloid = await state.deriveHyperliquidCloid(body.work_order_commitment);
  const pendingAttempt = {
    venue_id: "hyperliquid",
    account_commitment: allocation?.account_commitment || body.account_commitment || null,
    platform_class: "hyperliquid_style_market",
    execution_mode: executionMode,
    submit_count: readOnlyReconcile ? 0 : 1,
    ambiguity_retry_count: 0,
    provider_ref_seed: { venue: "hyperliquid", cloid, pending: true },
    result_seed: { kind: "hyperliquid_submission_pending" },
    fills: [],
    final_proof: null,
    status: "pending",
    created_at: new Date().toISOString(),
  };
  await persistPreSubmissionAttempt({
    state,
    workOrderCommitment: body.work_order_commitment,
    attempt: pendingAttempt,
    readOnlyReconcile,
    retryMessage: "hyperliquid work order already has a durable submission attempt; reconcile it instead of retrying",
  });
  let adapterResult;
  try {
    adapterResult = await submitHyperliquidExecution({
      credential,
      instruction,
      cloid,
    });
  } catch (error) {
    await state.putExecutionAttempt(body.work_order_commitment, {
      ...pendingAttempt,
      result_seed: { kind: "hyperliquid_submission_ambiguous" },
      status: "ambiguous",
      updated_at: new Date().toISOString(),
    });
    throw error;
  }
  await state.putExecutionAttempt(body.work_order_commitment, {
    ...pendingAttempt,
    submit_count: pendingAttempt.submit_count,
    ambiguity_retry_count: pendingAttempt.ambiguity_retry_count,
    provider_ref_seed: adapterResult.provider_ref_seed,
    result_seed: adapterResult.result_seed,
    fills: adapterResult.fills,
    final_proof: adapterResult.final_proof || null,
    status: adapterResult.status,
    created_at: new Date().toISOString(),
  });
  const receipt = {
    execution_protocol: HYPERLIQUID_PROOF_PROTOCOL,
    ...executionReceipt({
    venue_id: "hyperliquid",
    platform_class: "hyperliquid_style_market",
    execution_mode: executionMode,
    instruction,
    body,
    account_commitment: allocation?.account_commitment || body.account_commitment || null,
    status: adapterResult.status,
    provider_ref_seed: adapterResult.provider_ref_seed,
    result_seed: adapterResult.result_seed,
    fills: adapterResult.fills,
    final_proof: adapterResult.final_proof,
    visibility_summary: {
      main_wallet_exposed: false,
      ghola_operator_sees: "commitment_and_ciphertext_only",
      hyperliquid_sees: "execution_account_and_order_activity",
      venue_access_source: hyperliquidVenueAccessSource(executionMode),
      ghola_access_role: "private_execution_router",
      venue_gate: "venue_accepts_or_rejects_credentials",
      public_chain_sees: executionMode === "ghola_pooled"
        ? "private_funding_evidence_required"
        : allocation
        ? "no_public_wallet_settlement"
        : instruction.order?.live_order_mode === "tiny_fill"
          ? "no_ghola_public_settlement"
          : "private_funding_evidence_required",
    },
    }),
  };
  return state.putIdempotency(body.work_order_commitment, receipt);
}

export async function readHyperliquidSnapshot({ body, recipient, state }) {
  const { executionMode, credential } = await hyperliquidCredentialForBody({ body, recipient, state });
  return readHyperliquidAccountSnapshot({
    credential,
    accountSource: executionMode === "ghola_pooled"
      ? "ghola_pooled"
      : executionMode === "managed_testnet" ? "ghola_managed" : "sealed_byo",
  });
}

export async function readHyperliquidCarryMetrics({ body, recipient, state }) {
  const { credential } = await hyperliquidCredentialForBody({ body, recipient, state });
  return readHyperliquidCarryAccountMetrics({ credential });
}

export async function readCarryFundingSettlements({ body, recipient, state }) {
  const venueId = String(body.venue_id || "");
  const common = {
    asset: String(body.asset || "").toUpperCase(),
    start_time_ms: Number(body.start_time_ms),
    end_time_ms: Number(body.end_time_ms),
  };
  const adapterId = registeredCarryAdapterId(venueId, "carry_execution");
  if (adapterId === "hyperliquid_v1") {
    const { credential } = await hyperliquidCredentialForBody({ body, recipient, state });
    return readHyperliquidFundingSettlements({ credential, ...common });
  }
  if (adapterId === "aster_v1") {
    const credential = await asterCredentialForBody({ body, recipient });
    return readAsterFundingSettlements({ credential, symbol: common.asset, ...common });
  }
  if (adapterId === "lighter_v1") {
    const credential = await lighterCredentialForBody({ body, recipient });
    return readLighterFundingSettlements({ credential, market: common.asset, ...common });
  }
  throw new PrivateExecutionError(`authoritative funding settlement history is unavailable for ${venueId}`, 409);
}

export async function reconcileHyperliquidOrder({ body, recipient, state }) {
  const { executionMode, credential } = await hyperliquidCredentialForBody({ body, recipient, state });
  const targetWorkOrderCommitment = body.work_order_commitment;
  const attempted = await state.getExecutionAttempt(targetWorkOrderCommitment);
  const targetCloid = await state.deriveHyperliquidCloid(targetWorkOrderCommitment);
  const instruction = normalizeInstruction({
    version: 1,
    kind: "ghola_private_execution_instruction",
    venue_id: "hyperliquid",
    operation_class: "reconcile",
    reconcile: {
      target_work_order_commitment: targetWorkOrderCommitment,
      target_client_order_id: targetCloid,
      target_order_id: attempted?.provider_ref_seed?.order_id || attempted?.provider_ref_seed?.oid || null,
    },
  }, { venue_id: "hyperliquid", operation_class: "reconcile" });
  const adapterResult = await submitHyperliquidExecution({
    credential,
    instruction,
    cloid: targetCloid,
  });
  await state.putExecutionAttempt(targetWorkOrderCommitment, {
    ...attempted,
    venue_id: "hyperliquid",
    platform_class: "hyperliquid_style_market",
    execution_mode: executionMode,
    provider_ref_seed: adapterResult.provider_ref_seed,
    result_seed: adapterResult.result_seed,
    fills: adapterResult.fills,
    final_proof: adapterResult.final_proof || null,
    status: adapterResult.status,
    created_at: attempted?.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  return {
    execution_protocol: HYPERLIQUID_PROOF_PROTOCOL,
    ...executionReceipt({
    venue_id: "hyperliquid",
    platform_class: "hyperliquid_style_market",
    execution_mode: executionMode,
    instruction,
    body: { ...body, operation_class: "reconcile" },
    status: adapterResult.status,
    provider_ref_seed: adapterResult.provider_ref_seed,
    result_seed: adapterResult.result_seed,
    fills: adapterResult.fills,
    final_proof: adapterResult.final_proof,
    visibility_summary: {
      main_wallet_exposed: false,
      ghola_operator_sees: "commitment_and_ciphertext_only",
      hyperliquid_sees: "account_and_targeted_order_status_query",
      venue_access_source: hyperliquidVenueAccessSource(executionMode),
      ghola_access_role: "private_execution_reconciler",
      venue_gate: "venue_order_status_is_source_of_truth",
      public_chain_sees: "no_transaction_sent",
    },
    }),
  };
}

export async function streamHyperliquidAccountState({ body, recipient, state, onEvent }) {
  const { executionMode, credential } = await hyperliquidCredentialForBody({ body, recipient, state });
  return createHyperliquidAccountStateStream({
    credential,
    accountSource: executionMode === "ghola_pooled"
      ? "ghola_pooled"
      : executionMode === "managed_testnet" ? "ghola_managed" : "sealed_byo",
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
    const openedVault = await openAccountBoundExecutionVault({
      body,
      recipient,
      venueId: "hyperliquid",
      expectedKind: "ghola_hyperliquid_execution_vault",
      allowedNetworks: ["mainnet", "testnet"],
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
  if (venueId === "aster") {
    const openedVault = await openSealedBundle(body.encrypted_execution_vault, recipient, {
      expectedAad: [
        "ghola/aster-execution-vault-v1",
        `account:${body.account_commitment}`,
        `recipient:${recipient.recipient_id}`,
        "network:mainnet",
      ].join("|"),
      expectedKind: "ghola_aster_execution_vault",
    });
    const credential = asterCredentialFromVault(openedVault.json);
    const snapshot = await readAsterAccountState({ credential, symbol: "BTCUSDT" });
    return credentialVerificationResult({
      venue_id: "aster",
      source: "aster_v3_account_readiness",
      can_read: true,
      can_trade: snapshot.can_trade,
      can_withdraw: false,
      evidence_seed: {
        account_ready: snapshot.can_trade,
        fee_schedule_loaded: snapshot.maker_fee_bps !== null && snapshot.taker_fee_bps !== null,
      },
    });
  }
  if (venueId === "lighter") {
    const credential = await openLighterExecutionCredential({
      bundle: body.encrypted_execution_vault,
      recipient,
      accountCommitment: body.account_commitment,
    });
    const verification = await verifyLighterCredential({ credential });
    return credentialVerificationResult({
      venue_id: "lighter",
      source: "lighter_sdk_account_readiness_with_attested_owner_only_policy",
      can_read: verification.can_read,
      can_trade: verification.can_trade,
      can_withdraw: verification.can_withdraw,
      authority_boundary: {
        venue_native_trade_only: false,
        enforced_by: "attested_worker_policy",
      },
      evidence_seed: {
        account_status: verification.account.account_status,
        venue_native_trade_only: false,
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
  let allocation = null;
  if (isHyperliquidAllocationMode(executionMode)) {
    const allocationCommitment = body.managed_allocation_commitment || body.allocation_commitment;
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
      const openedVault = await openAccountBoundExecutionVault({
        body,
        recipient,
        venueId: "hyperliquid",
        expectedKind: "ghola_hyperliquid_execution_vault",
        allowedNetworks: ["mainnet", "testnet"],
      });
      credential = hyperliquidCredentialFromVault(openedVault.json);
    }
  }
  return { executionMode, credential, allocation };
}

async function openAccountBoundExecutionVault({
  body,
  recipient,
  venueId,
  expectedKind,
  allowedNetworks,
}) {
  const accountCommitment = String(body?.account_commitment || "");
  if (!ACCOUNT_BOUND_COMMITMENT.test(accountCommitment)) {
    throw new PrivateExecutionError(`${venueId} account commitment is unavailable`, 400);
  }
  const opened = await openSealedBundle(body.encrypted_execution_vault, recipient, {
    aadPrefix: `ghola/${venueId}-execution-vault-v1`,
    expectedKind,
  });
  const network = String(opened.json?.network || "");
  if (!allowedNetworks.includes(network)) {
    throw new PrivateExecutionError(`${venueId} execution vault network is invalid`, 400);
  }
  const expectedAad = [
    `ghola/${venueId}-execution-vault-v1`,
    `account:${accountCommitment}`,
    `recipient:${recipient.recipient_id}`,
    `network:${network}`,
  ].join("|");
  if (opened.associatedDataText !== expectedAad) {
    throw new PrivateExecutionError(`${venueId} execution vault account binding mismatch`, 403);
  }
  return opened;
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
  const instruction = await resolvePrivateOrderTarget(await instructionForBody({
    body,
    recipient,
    venue_id: "coinbase_advanced",
    session,
  }), { state, venue_id: "coinbase_advanced", body });
  await enforceInstructionPolicy({
    body,
    instruction,
    session,
    state,
    trusted_internal: Boolean(body[AUTOPILOT_INTERNAL_INSTRUCTION]),
  });

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

  const clientOrderId = await state.deriveClientOrderId("gh", body.work_order_commitment);
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
  const instruction = await resolvePrivateOrderTarget(await instructionForBody({
    body,
    recipient,
    venue_id: venueId,
    session,
  }), { state, venue_id: venueId, body });
  await enforceInstructionPolicy({
    body,
    instruction,
    session,
    state,
    trusted_internal: Boolean(body[AUTOPILOT_INTERNAL_INSTRUCTION]),
  });
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
  await enforceInstructionPolicy({
    body,
    instruction,
    session,
    state,
    trusted_internal: Boolean(body[AUTOPILOT_INTERNAL_INSTRUCTION]),
  });
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
  const carryAdapter = registeredCarryAdapter(venue_id, "carry_execution");
  if (carryAdapter) {
    return carryAdapter.execute({
      body: carryAdapter.body(body, execution, "execute"),
      recipient,
      state,
    });
  }
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
  const carryAdapter = registeredCarryAdapter(venue_id, "no_submit_reconciliation");
  if (carryAdapter) {
    return carryAdapter.verify({
      body: carryAdapter.body(body, execution, "verify"),
      recipient,
      state,
    });
  }
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
  if (venue_id === "phoenix" || venue_id === "backpack") {
    return verifySolanaPerpsOrderNoSubmit({
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

export async function executeAsterOrder({ body, recipient, state }) {
  const readOnlyReconcile = body.operation_class === "reconcile";
  const cached = await state.getIdempotency(body.work_order_commitment);
  if (cached?.receipt && !readOnlyReconcile) return cached.receipt;
  const priorAttempt = await state.getExecutionAttempt(body.work_order_commitment);
  if (!readOnlyReconcile && ["pending", "ambiguous", "open", "filled", "cancelled", "rejected"].includes(priorAttempt?.status)) {
    throw new PrivateExecutionError("aster work order already has an attempt; reconcile it instead of retrying", 409);
  }
  const credential = await asterCredentialForBody({ body, recipient });
  const session = await state.findSession({
    venue_id: "aster",
    vault_commitment: body.vault_commitment || undefined,
    policy_commitment: body.policy_commitment || undefined,
  });
  const instruction = await resolvePrivateOrderTarget(await instructionForBody({
    body,
    recipient,
    venue_id: "aster",
    session,
  }), { state, venue_id: "aster", body });
  await enforceInstructionPolicy({
    body,
    instruction,
    session,
    state,
    trusted_internal: Boolean(body[AUTOPILOT_INTERNAL_INSTRUCTION]),
  });
  const clientOrderId = await state.deriveClientOrderId("gh", body.work_order_commitment);
  const pending = {
    venue_id: "aster",
    account_commitment: body.account_commitment || null,
    platform_class: "hyperliquid_style_market",
    execution_mode: "byo_api_key",
    submit_count: readOnlyReconcile ? 0 : 1,
    ambiguity_retry_count: 0,
    provider_ref_seed: { venue: "aster", client_order_id: clientOrderId, pending: true },
    result_seed: { kind: "aster_submission_pending" },
    fills: [],
    final_proof: null,
    status: "pending",
    created_at: new Date().toISOString(),
  };
  await persistPreSubmissionAttempt({
    state,
    workOrderCommitment: body.work_order_commitment,
    attempt: pending,
    readOnlyReconcile,
    retryMessage: "aster work order already has an attempt; reconcile it instead of retrying",
  });
  let result;
  try {
    result = await submitAndReconcileAsterExecution({ credential, instruction, clientOrderId });
  } catch (error) {
    const ambiguous = error?.code === "submission_outcome_ambiguous";
    await state.putExecutionAttempt(body.work_order_commitment, {
      ...pending,
      result_seed: { kind: ambiguous ? "aster_submission_ambiguous" : "aster_submission_rejected" },
      status: ambiguous ? "ambiguous" : "rejected",
      updated_at: new Date().toISOString(),
    });
    throw error;
  }
  await state.putExecutionAttempt(body.work_order_commitment, {
    ...pending,
    provider_ref_seed: result.provider_ref_seed,
    result_seed: result.result_seed,
    fills: result.fills,
    final_proof: result.final_proof,
    status: result.status,
    updated_at: new Date().toISOString(),
  });
  const receipt = executionReceipt({
    venue_id: "aster",
    platform_class: "hyperliquid_style_market",
    execution_mode: "byo_api_key",
    instruction,
    body,
    status: result.status,
    provider_ref_seed: result.provider_ref_seed,
    result_seed: result.result_seed,
    fills: result.fills,
    final_proof: result.final_proof,
    visibility_summary: {
      main_wallet_exposed: false,
      ghola_operator_sees: "commitment_and_ciphertext_only",
      aster_sees: "account_and_order_activity",
      venue_access_source: "sealed_api_wallet",
      ghola_access_role: "private_execution_router",
      venue_gate: "venue_accepts_or_rejects_credentials",
      public_chain_sees: "no_ghola_settlement_transaction",
    },
  });
  return state.putIdempotency(body.work_order_commitment, receipt);
}

export async function verifyAsterOrderNoSubmit({ body, recipient, state }) {
  const credential = await asterCredentialForBody({ body, recipient });
  const session = await state.findSession({
    venue_id: "aster",
    vault_commitment: body.vault_commitment || undefined,
    policy_commitment: body.policy_commitment || undefined,
  });
  const instruction = await resolvePrivateOrderTarget(await instructionForBody({
    body,
    recipient,
    venue_id: "aster",
    session,
  }), { state, venue_id: "aster", body });
  await enforceInstructionPolicy({
    body,
    instruction,
    session,
    state,
    trusted_internal: Boolean(body[AUTOPILOT_INTERNAL_INSTRUCTION]),
    account_usage: false,
  });
  const clientOrderId = await state.deriveClientOrderId("gh", body.work_order_commitment);
  const result = await verifyAsterNoSubmit({ credential, instruction, clientOrderId });
  const providerSeed = { venue: "aster", client_order_id: clientOrderId, checks: result.checks };
  const providerRefCommitment = commitment("aster_provider_ref", providerSeed);
  return {
    version: 1,
    venue_id: "aster",
    execution_protocol: "ghola-aster-v3-proof-v1",
    platform_class: "hyperliquid_style_market",
    execution_mode: "byo_api_key",
    status: result.status,
    work_order_commitment: body.work_order_commitment,
    account_commitment: body.account_commitment || null,
    vault_commitment: body.vault_commitment || null,
    provider_ref_commitment: providerRefCommitment,
    result_commitment: commitment("aster_no_submit_result", { providerRefCommitment, status: result.status }),
    verification_commitment: commitment("aster_no_submit_verification", { providerSeed, account: result.account }),
    checks: result.checks,
    account: result.account,
    authority_boundary: result.authority_boundary,
    order_shape: {
      market: result.order.symbol,
      side: result.order.side.toLowerCase(),
      base_size: result.order.quantity,
      limit_price: result.order.price,
      reduce_only: result.order.reduceOnly === "true",
      notional_micro_usdc: Math.round(Number(result.order.quantity) * Number(result.order.price) * 1_000_000),
    },
    visibility_summary: {
      main_wallet_exposed: false,
      ghola_operator_sees: "commitment_and_ciphertext_only",
      aster_sees: "authenticated_account_reads_only",
      transaction_broadcast: false,
    },
    updated_at: new Date().toISOString(),
  };
}

async function asterCredentialForBody({ body, recipient }) {
  if (process.env.PRIVATE_AGENT_VENUE_DRY_RUN === "true" && !body.encrypted_execution_vault) return dryRunAsterCredential();
  const opened = await openAccountBoundExecutionVault({
    body,
    recipient,
    venueId: "aster",
    expectedKind: "ghola_aster_execution_vault",
    allowedNetworks: ["mainnet"],
  });
  return asterCredentialFromVault(opened.json);
}

export async function executeLighterOrder({ body, recipient, state }) {
  const readOnlyReconcile = body.operation_class === "reconcile";
  const cached = await state.getIdempotency(body.work_order_commitment);
  if (cached?.receipt && !readOnlyReconcile) return cached.receipt;
  const priorAttempt = await state.getExecutionAttempt(body.work_order_commitment);
  if (!readOnlyReconcile && ["pending", "ambiguous", "open", "filled", "cancelled", "rejected"].includes(priorAttempt?.status)) {
    throw new PrivateExecutionError("lighter work order already has an attempt; reconcile it instead of retrying", 409);
  }
  const credential = await lighterCredentialForBody({ body, recipient });
  const session = await state.findSession({
    venue_id: "lighter",
    vault_commitment: body.vault_commitment || undefined,
    policy_commitment: body.policy_commitment || undefined,
  });
  const instruction = await resolvePrivateOrderTarget(await instructionForBody({
    body,
    recipient,
    venue_id: "lighter",
    session,
  }), { state, venue_id: "lighter", body });
  await enforceInstructionPolicy({
    body,
    instruction,
    session,
    state,
    trusted_internal: Boolean(body[AUTOPILOT_INTERNAL_INSTRUCTION]),
  });
  const clientOrderIndex = lighterClientOrderIndex(body.work_order_commitment);
  const pending = {
    venue_id: "lighter",
    account_commitment: body.account_commitment || null,
    platform_class: "hyperliquid_style_market",
    execution_mode: "byo_api_key",
    submit_count: readOnlyReconcile ? 0 : 1,
    ambiguity_retry_count: 0,
    provider_ref_seed: { venue: "lighter", client_order_index: clientOrderIndex, pending: true },
    result_seed: { kind: "lighter_submission_pending" },
    fills: [],
    final_proof: null,
    status: "pending",
    created_at: new Date().toISOString(),
  };
  await persistPreSubmissionAttempt({
    state,
    workOrderCommitment: body.work_order_commitment,
    attempt: pending,
    readOnlyReconcile,
    retryMessage: "lighter work order already has an attempt; reconcile it instead of retrying",
  });
  let result;
  try {
    result = await submitAndReconcileLighterExecution({ credential, instruction, clientOrderIndex });
  } catch (error) {
    const ambiguous = error?.code === "submission_ambiguous";
    await state.putExecutionAttempt(body.work_order_commitment, {
      ...pending,
      result_seed: { kind: ambiguous ? "lighter_submission_ambiguous" : "lighter_submission_rejected" },
      status: ambiguous ? "ambiguous" : "rejected",
      updated_at: new Date().toISOString(),
    });
    throw error;
  }
  await state.putExecutionAttempt(body.work_order_commitment, {
    ...pending,
    provider_ref_seed: result.provider_ref_seed,
    result_seed: result.result_seed,
    fills: result.fills,
    final_proof: result.final_proof,
    status: result.status,
    updated_at: new Date().toISOString(),
  });
  const receipt = executionReceipt({
    venue_id: "lighter",
    platform_class: "hyperliquid_style_market",
    execution_mode: "byo_api_key",
    instruction,
    body,
    status: result.status,
    provider_ref_seed: result.provider_ref_seed,
    result_seed: result.result_seed,
    fills: result.fills,
    final_proof: result.final_proof,
    visibility_summary: {
      main_wallet_exposed: false,
      ghola_operator_sees: "commitment_and_ciphertext_only",
      lighter_sees: "account_and_order_activity",
      venue_access_source: "sealed_api_key",
      ghola_access_role: "attested_policy_limited_execution_router",
      venue_native_trade_only: false,
      owner_only_operations: ["withdraw", "transfer", "leverage", "margin", "account_config", "api_key_rotation"],
      public_chain_sees: "lighter_account_activity",
    },
  });
  return state.putIdempotency(body.work_order_commitment, receipt);
}

export async function verifyLighterOrderNoSubmit({ body, recipient, state }) {
  const credential = await lighterCredentialForBody({ body, recipient });
  const session = await state.findSession({
    venue_id: "lighter",
    vault_commitment: body.vault_commitment || undefined,
    policy_commitment: body.policy_commitment || undefined,
  });
  const instruction = await resolvePrivateOrderTarget(await instructionForBody({
    body,
    recipient,
    venue_id: "lighter",
    session,
  }), { state, venue_id: "lighter", body });
  await enforceInstructionPolicy({
    body,
    instruction,
    session,
    state,
    trusted_internal: Boolean(body[AUTOPILOT_INTERNAL_INSTRUCTION]),
    account_usage: false,
  });
  const clientOrderIndex = lighterClientOrderIndex(body.work_order_commitment);
  const result = await verifyLighterNoSubmit({ credential, instruction, clientOrderIndex });
  const providerSeed = { venue: "lighter", client_order_index: clientOrderIndex, checks: result.checks };
  const providerRefCommitment = commitment("lighter_provider_ref", providerSeed);
  return {
    version: 1,
    venue_id: "lighter",
    execution_protocol: "ghola-lighter-sdk-proof-v1",
    platform_class: "hyperliquid_style_market",
    execution_mode: "byo_api_key",
    status: result.status,
    work_order_commitment: body.work_order_commitment,
    account_commitment: body.account_commitment || null,
    vault_commitment: body.vault_commitment || null,
    provider_ref_commitment: providerRefCommitment,
    result_commitment: commitment("lighter_no_submit_result", { providerRefCommitment, status: result.status }),
    verification_commitment: commitment("lighter_no_submit_verification", { providerSeed, account: result.account }),
    checks: result.checks,
    account: result.account,
    order_shape: result.order_shape,
    authority_boundary: result.authority_boundary,
    visibility_summary: {
      main_wallet_exposed: false,
      ghola_operator_sees: "commitment_and_ciphertext_only",
      lighter_sees: "authenticated_account_reads_and_local_signature_only",
      transaction_broadcast: false,
      venue_native_trade_only: false,
    },
    updated_at: new Date().toISOString(),
  };
}

export async function readLighterCarryWithdrawalRoute({
  request,
  probe_context: probeContext,
  recipient,
  openCredential = openLighterExecutionCredential,
  readWithdrawalQuote = readLighterWithdrawalRouteQuote,
}) {
  const access = probeContext?.venue_access_by_account?.[request?.from_account_commitment];
  if (probeContext?.owner_commitment !== access?.owner_commitment
    || access?.status !== "ready"
    || access?.account_commitment !== request?.from_account_commitment
    || !access?.encrypted_execution_vault) {
    throw new PrivateExecutionError("lighter carry route access is unavailable", 409);
  }
  const credential = await openCredential({
    bundle: access.encrypted_execution_vault,
    recipient,
    accountCommitment: access.account_commitment,
  });
  return readWithdrawalQuote({
    credential,
    account_state_commitment: request.source_account_state_commitment,
  });
}

export async function readPrivateCarryAccountCapacity({
  request,
  probe_context: probeContext,
  recipient,
  now = () => Date.now(),
  openExecutionVault = openAccountBoundExecutionVault,
  readHyperliquidMetrics = readHyperliquidCarryAccountMetrics,
  readAsterState = readAsterAccountState,
}) {
  const venueId = String(request?.venue_id || "");
  const accountCommitment = String(request?.from_account_commitment || "");
  const access = probeContext?.venue_access_by_account?.[accountCommitment];
  if (probeContext?.owner_commitment !== access?.owner_commitment
    || access?.status !== "ready"
    || access?.account_commitment !== accountCommitment
    || !access?.encrypted_execution_vault) {
    throw new PrivateExecutionError(`${venueId || "carry"} account capacity access is unavailable`, 409);
  }
  const venue = venueId === "hyperliquid"
    ? {
        asset: "USDC",
        expectedKind: "ghola_hyperliquid_execution_vault",
        allowedNetworks: ["mainnet", "testnet"],
      }
    : venueId === "aster"
      ? {
          asset: "USDT",
          expectedKind: "ghola_aster_execution_vault",
          allowedNetworks: ["mainnet"],
        }
      : null;
  if (!venue || request?.collateral_asset !== venue.asset) {
    throw new PrivateExecutionError("carry account capacity venue is unsupported", 400);
  }
  const opened = await openExecutionVault({
    body: {
      account_commitment: accountCommitment,
      encrypted_execution_vault: access.encrypted_execution_vault,
    },
    recipient,
    venueId,
    expectedKind: venue.expectedKind,
    allowedNetworks: venue.allowedNetworks,
  });
  const account = venueId === "hyperliquid"
    ? await readHyperliquidMetrics({ credential: hyperliquidCredentialFromVault(opened.json) })
    : await readAsterState({ credential: asterCredentialFromVault(opened.json), symbol: "BTCUSDT" });
  const maximum = decimalNumberToMicroFloor(account?.available_balance);
  return Object.freeze({
    verified: true,
    venue_id: venueId,
    collateral_asset: venue.asset,
    account_state_commitment: request.source_account_state_commitment,
    read_only: true,
    fund_movement_authorized: false,
    transaction_broadcast: false,
    minimum_transfer_micro_usdc: 0,
    maximum_transfer_micro_usdc: maximum,
    as_of_ms: positiveSafeInteger(now(), "carry account capacity time is invalid"),
  });
}

async function lighterCredentialForBody({ body, recipient }) {
  return openLighterExecutionCredential({
    bundle: body.encrypted_execution_vault,
    recipient,
    accountCommitment: body.account_commitment,
  });
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
  const instruction = await resolvePrivateOrderTarget(await instructionForBody({
    body,
    recipient,
    venue_id: venueId,
    session,
  }), { state, venue_id: venueId, body });
  await enforceInstructionPolicy({
    body,
    instruction,
    session,
    state,
    trusted_internal: Boolean(body[AUTOPILOT_INTERNAL_INSTRUCTION]),
    account_usage: false,
  });
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
  const instruction = await resolvePrivateOrderTarget(await instructionForBody({
    body,
    recipient,
    venue_id: "coinbase_advanced",
    session,
  }), { state, venue_id: "coinbase_advanced", body });
  await enforceInstructionPolicy({
    body,
    instruction,
    session,
    state,
    trusted_internal: Boolean(body[AUTOPILOT_INTERNAL_INSTRUCTION]),
    account_usage: false,
  });

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
  await enforceInstructionPolicy({
    body,
    instruction,
    session,
    state,
    trusted_internal: Boolean(body[AUTOPILOT_INTERNAL_INSTRUCTION]),
    account_usage: false,
  });
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
  const { executionMode, credential, allocation } = await hyperliquidCredentialForBody({ body, recipient, state });
  const session = await state.findSession({
    venue_id: "hyperliquid",
    vault_commitment: executionMode === "byo_api_key" ? body.vault_commitment : undefined,
    allocation_commitment: isHyperliquidAllocationMode(executionMode)
      ? body.managed_allocation_commitment || body.allocation_commitment
      : undefined,
    policy_commitment: body.policy_commitment,
  });
  const instruction = await resolvePrivateOrderTarget(await instructionForBody({
    body,
    recipient,
    venue_id: "hyperliquid",
    session,
  }), { state, venue_id: "hyperliquid", body });
  await enforceInstructionPolicy({
    body,
    instruction,
    session,
    state,
    trusted_internal: Boolean(body[AUTOPILOT_INTERNAL_INSTRUCTION]),
    account_usage: false,
  });
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
    execution_protocol: HYPERLIQUID_PROOF_PROTOCOL,
    platform_class: "hyperliquid_style_market",
    execution_mode: executionMode,
    status: "verified_no_funds",
    work_order_commitment: body.work_order_commitment,
    account_commitment: allocation?.account_commitment || body.account_commitment || null,
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
    order_shape: adapterResult.order_shape,
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

async function resolvePrivateOrderTarget(instruction, { state, venue_id, body }) {
  const target = instruction?.operation_class === "cancel"
    ? instruction.cancel?.target_work_order_commitment
    : instruction?.operation_class === "reconcile"
      ? instruction.reconcile?.target_work_order_commitment
      : null;
  if (!target) return instruction;
  const cached = (await state.getIdempotency(target))?.receipt;
  if (!cached && !await durableRecoveryTargetAllowed({ state, body, target, venueId: venue_id })) {
    throw new PrivateExecutionError(instruction.operation_class === "cancel"
      ? "cancel target work order is unknown"
      : "reconcile target work order is unknown");
  }
  const clientOrderId = venue_id === "hyperliquid"
    ? await state.deriveHyperliquidCloid(target)
    : venue_id === "lighter"
      ? lighterClientOrderIndex(target)
      : venue_id === "aster"
        ? await state.deriveClientOrderId("gh", target)
        : await state.deriveClientOrderId("ghola", target);
  if (instruction.operation_class === "reconcile") {
    const attempt = await state.getExecutionAttempt(target);
    return {
      ...instruction,
      reconcile: {
        ...instruction.reconcile,
        target_client_order_id: clientOrderId,
        ...(venue_id === "lighter" ? { target_client_order_index: clientOrderId } : {}),
        target_order_id: attempt?.provider_ref_seed?.order_id || attempt?.provider_ref_seed?.oid || null,
      },
    };
  }
  return {
    ...instruction,
    cancel: {
      ...instruction.cancel,
      client_order_id: clientOrderId,
      ...(venue_id === "lighter" ? { client_order_index: clientOrderId } : {}),
    },
  };
}

async function durableRecoveryTargetAllowed({ state, body, target, venueId }) {
  if (!body?.[AUTOPILOT_INTERNAL_INSTRUCTION] || !body.recovery_saga_id) return false;
  const saga = await state.getMultiLegSaga?.(body.recovery_saga_id);
  if (
    !saga ||
    saga.execution_context?.policy_commitment !== body.policy_commitment
  ) return false;
  if (saga.execution_context?.autopilot_session_id) {
    if (saga.execution_context.autopilot_session_id !== body.autopilot_session_id) return false;
  } else if (
    saga.execution_context?.carry_position_id !== body.carry_position_id ||
    saga.execution_context?.owner_commitment !== body.owner_commitment
  ) return false;
  const contextLeg = saga.execution_context.legs.find((leg) => leg.work_order_commitment === target);
  const sagaLeg = contextLeg && saga.legs.find((leg) => leg.leg_id === contextLeg.leg_id);
  if (sagaLeg?.venue_id === venueId) return true;
  for (const leg of saga.legs.filter((item) => item.venue_id === venueId)) {
    for (const action of ["unwind", "completion"]) {
      const stored = await state.getIdempotency?.(recoveryAccountingKey(saga.saga_id, leg.leg_id, action));
      const accounting = stored?.receipt;
      if (
        accounting?.version === 1 &&
        accounting?.kind === "multi_leg_recovery_accounting" &&
        accounting?.saga_id === saga.saga_id &&
        accounting?.leg_id === leg.leg_id &&
        accounting?.venue_id === venueId &&
        accounting?.action === action &&
        accounting.executions?.some((execution) => execution?.work_order_commitment === target)
      ) return true;
    }
  }
  return false;
}

function recoveryAccountingKey(sagaId, legId, action) {
  return `accounting:recovery:${sha256Hex(`${sagaId}:${legId}:${action}`).slice(0, 40)}`;
}

function hyperliquidExecutionMode(body) {
  if (body.execution_mode === "ghola_pooled") return "ghola_pooled";
  return body.execution_mode === "managed_testnet" ||
      body.managed_allocation_commitment ||
      (body.allocation_commitment && body.execution_mode !== "byo_api_key")
    ? "managed_testnet"
    : "byo_api_key";
}

function isHyperliquidAllocationMode(mode) {
  return mode === "managed_testnet" || mode === "ghola_pooled";
}

function hyperliquidVenueAccessSource(mode) {
  if (mode === "ghola_pooled") return "ghola_pooled_venue_account";
  if (mode === "managed_testnet") return "ghola_managed_testnet";
  return "user_provided_credentials";
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
    account_commitment: input.account_commitment || input.body.account_commitment || null,
    vault_commitment: input.body.vault_commitment || null,
    allocation_commitment: input.body.omnibus_allocation?.allocation_commitment ||
      input.body.managed_allocation_commitment ||
      input.body.allocation_commitment ||
      null,
    provider_ref_commitment: providerRefCommitment,
    result_commitment: commitment(`${input.venue_id}_result`, {
      work_order_commitment: input.body.work_order_commitment,
      provider_ref_commitment: providerRefCommitment,
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
    authority_boundary: input.authority_boundary || undefined,
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

function decimalNumberToMicroFloor(value) {
  const amount = Number(value);
  const micro = Math.floor(amount * 1_000_000);
  if (!Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(micro)) {
    throw new PrivateExecutionError("carry account capacity is invalid", 502);
  }
  return micro;
}

function positiveSafeInteger(value, message) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new PrivateExecutionError(message, 500);
  return value;
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  return JSON.stringify(value, Object.keys(value || {}).sort());
}
