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
  reconcileCoinbaseExecution,
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
import { emitOperatorEvent } from "../observability/operator-events.js";

export class PrivateExecutionError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "PrivateExecutionError";
    this.status = status;
  }
}

const AUTOPILOT_INTERNAL_INSTRUCTION = Symbol("ghola.autopilot.internal_instruction");
const COINBASE_EXPOSURE_CREATING_OPERATIONS = new Set([
  "spot_limit_order",
  "spot_market_order",
]);

export function commitment(prefix, value) {
  return `${prefix}_${sha256Hex(canonicalJson(value)).slice(0, 48)}`;
}

export function assertPrivateExecutionRecoveryInvariant({
  venue_id,
  execution_mode,
  instruction,
  dry_run = false,
}) {
  if (dry_run) return;
  const operationClass = instruction?.operation_class;
  if (
    venue_id === "coinbase_advanced" &&
    COINBASE_EXPOSURE_CREATING_OPERATIONS.has(operationClass)
  ) {
    const tif = String(instruction?.order?.tif || "").toLowerCase();
    const recoveryBackedByoIoc =
      execution_mode === "byo_api_key" &&
      operationClass === "spot_limit_order" &&
      (tif === "ioc" || tif === "fok") &&
      instruction?.order?.post_only !== true;
    if (recoveryBackedByoIoc) return;
    throw privateExecutionContainmentError(
      "COINBASE_LIVE_EXECUTION_RECOVERY_UNPROVEN",
      "coinbase live execution is limited to recovery-backed BYO limit IOC/FOK orders",
    );
  }
  if (operationClass !== "perp_limit_order") return;
  const tif = String(instruction?.order?.tif || "").toLowerCase();
  if (venue_id === "phoenix") {
    throw privateExecutionContainmentError(
      "PHOENIX_LIVE_EXECUTION_RECOVERY_UNPROVEN",
      "phoenix live execution is disabled until exact submit and cancellation recovery are proven",
    );
  }
  if (venue_id === "backpack" && tif !== "ioc") {
    throw privateExecutionContainmentError(
      "BACKPACK_RESTING_ORDER_RECOVERY_UNPROVEN",
      "backpack live resting orders are disabled until deterministic cancellation is proven",
    );
  }
}

export async function executeClaimedPrivateSubmission({
  state,
  work_order_commitment,
  claim_context,
  prepare,
  submit,
  evidence,
  finalize,
}) {
  const startedAt = Date.now();
  const operatorFields = {
    venue_id: claim_context?.venue_id,
    platform_class: claim_context?.platform_class,
    execution_mode: claim_context?.execution_mode,
    operation_class: claim_context?.operation_class,
    work_order_commitment,
  };
  const claim = await state.claimExecution(work_order_commitment, claim_context);
  if (claim?.status === "completed" && claim.receipt) {
    void emitOperatorEvent("execution_claim_replayed", {
      ...operatorFields,
      severity: "info",
      claim_status: "completed",
      duration_ms: Date.now() - startedAt,
    });
    return claim.receipt;
  }
  if (claim?.status === "rejected" && claim.rejection) {
    void emitOperatorEvent("execution_claim_rejected_replay", {
      ...operatorFields,
      severity: "warn",
      claim_status: "rejected",
      error_code: claim.rejection.error_code,
      duration_ms: Date.now() - startedAt,
    });
    throw executionClaimRejection(claim.rejection);
  }
  if (claim?.status === "context_mismatch") {
    void emitOperatorEvent("execution_claim_context_mismatch", {
      ...operatorFields,
      severity: "error",
      claim_status: "context_mismatch",
      error_code: "EXECUTION_CLAIM_CONTEXT_MISMATCH",
      duration_ms: Date.now() - startedAt,
    });
    throw executionClaimContextMismatch();
  }
  if (claim?.status !== "claimed" || !claim.claim_token) {
    const error = new PrivateExecutionError(
      "execution claim is unresolved; reconciliation required",
      409,
    );
    error.code = "EXECUTION_CLAIM_RECONCILE_REQUIRED";
    void emitOperatorEvent("execution_claim_unresolved", {
      ...operatorFields,
      severity: "critical",
      claim_status: claim?.status || "unknown",
      error_code: error.code,
      duration_ms: Date.now() - startedAt,
    });
    throw error;
  }
  void emitOperatorEvent("execution_claim_acquired", {
    ...operatorFields,
    severity: "info",
    claim_status: "claimed",
    duration_ms: Date.now() - startedAt,
  });
  let submissionStarted = false;
  let completedEvidence = null;
  try {
    if (typeof evidence !== "function") {
      throw new Error("execution evidence builder is required");
    }
    if (prepare) await prepare();
    submissionStarted = true;
    const adapterResult = await submit();
    completedEvidence = structuredClone(
      bindExecutionClaimCompletion(
        await evidence(adapterResult),
        claim_context,
      ),
    );
    await state.recordExecutionClaimEvidence(
      work_order_commitment,
      claim.claim_token,
      completedEvidence,
    );
    if (finalize) await finalize(adapterResult, structuredClone(completedEvidence));
    const receipt = await state.completeExecutionClaim(
      work_order_commitment,
      claim.claim_token,
      completedEvidence,
    );
    void emitOperatorEvent("execution_claim_completed", {
      ...operatorFields,
      severity: "info",
      claim_status: "completed",
      status: receipt?.status || completedEvidence?.receipt?.status || "completed",
      broadcast_performed: completedEvidence?.receipt?.final_proof?.broadcast_performed === true,
      final_venue_execution_proven: completedEvidence?.receipt?.final_proof?.final_venue_execution_proven === true,
      final_fill_proven: completedEvidence?.receipt?.final_proof?.final_fill_proven === true,
      duration_ms: Date.now() - startedAt,
    });
    return receipt;
  } catch (error) {
    try {
      const failure = executionClaimFailure(claim_context, error);
      if (submissionStarted) {
        await state.markExecutionClaimReconcileRequired(
          work_order_commitment,
          claim.claim_token,
          failure,
          completedEvidence,
        );
      } else {
        await state.rejectExecutionClaim(
          work_order_commitment,
          claim.claim_token,
          failure,
        );
      }
    } catch {
      // The durable in-progress claim still prevents any rebroadcast.
    }
    void emitOperatorEvent(
      submissionStarted ? "execution_reconciliation_required" : "execution_claim_rejected",
      {
        ...operatorFields,
        severity: submissionStarted ? "critical" : "warn",
        claim_status: submissionStarted ? "reconcile_required" : "rejected",
        error_code: safeExecutionErrorCode(error),
        duration_ms: Date.now() - startedAt,
      },
    );
    throw error;
  }
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
  const executionMode = hyperliquidExecutionMode(body);
  const claimContext = executionClaimContext({
    body,
    venue_id: "hyperliquid",
    platform_class: "hyperliquid_style_market",
    execution_mode: executionMode,
  });
  const cached = await boundCachedExecutionReceipt({
    state,
    work_order_commitment: body.work_order_commitment,
    claim_context: claimContext,
  });
  if (cached) return cached;
  let credential;
  let allocation = null;
  let pendingManagedAllocation = null;
  if (isHyperliquidAllocationMode(executionMode)) {
    const allocationCommitment = body.managed_allocation?.allocation_commitment ||
      body.managed_allocation_commitment ||
      body.allocation_commitment;
    if (body.managed_allocation?.allocation_commitment) {
      pendingManagedAllocation = body.managed_allocation;
    }
    const record = pendingManagedAllocation
      ? { allocation: pendingManagedAllocation }
      : await state.getHyperliquidManagedAllocation(allocationCommitment);
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
  const expectedNetwork = body.session_policy?.execution_network;
  if (expectedNetwork && credential.network !== expectedNetwork) {
    throw new PrivateExecutionError("hyperliquid execution network does not match session policy", 409);
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
  return executeClaimedPrivateSubmission({
    state,
    work_order_commitment: body.work_order_commitment,
    claim_context: claimContext,
    prepare: async () => {
      if (body.autopilot_session_id) {
        const autopilot = await state.getAutopilotSession(body.autopilot_session_id);
        if (!autopilot || autopilot.control_latch || autopilot.status !== "running" || autopilot.execution_enabled !== true) {
          throw new PrivateExecutionError("autopilot execution permit is unavailable", 409);
        }
      }
      await enforceInstructionPolicy({ body, instruction, session, state });
      if (pendingManagedAllocation) {
        await state.putHyperliquidManagedAllocation(pendingManagedAllocation);
      }
    },
    submit: () => submitHyperliquidExecution({ credential, instruction, cloid }),
    evidence: async (adapterResult) => ({
      attempt: executionAttempt({
        venue_id: "hyperliquid",
        platform_class: "hyperliquid_style_market",
        execution_mode: executionMode,
        adapterResult,
      }),
      receipt: executionReceipt({
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
      }),
    }),
  });
}

export async function executeHyperliquidBoundInstruction({
  body,
  instruction,
  recipient,
  state,
}) {
  const boundBody = { ...body };
  boundBody[AUTOPILOT_INTERNAL_INSTRUCTION] = instruction;
  return executeHyperliquidOrder({ body: boundBody, recipient, state });
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

export async function executeCoinbaseOrder({
  body,
  recipient,
  state,
  submitExecution = submitCoinbaseExecution,
}) {
  const claimContext = executionClaimContext({
    body,
    venue_id: "coinbase_advanced",
    platform_class: "coinbase_style_provider",
    execution_mode: body.execution_mode,
  });
  const cached = await boundCachedExecutionReceipt({
    state,
    work_order_commitment: body.work_order_commitment,
    claim_context: claimContext,
  });
  if (cached) return cached;
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
  assertPrivateExecutionRecoveryInvariant({
    venue_id: "coinbase_advanced",
    execution_mode: body.execution_mode,
    instruction,
    dry_run: process.env.PRIVATE_AGENT_VENUE_DRY_RUN === "true",
  });
  await enforceInstructionPolicy({ body, instruction, session, state: null });

  let credential;
  if (body.execution_mode === "partner_omnibus") {
    credential = process.env.PRIVATE_AGENT_VENUE_DRY_RUN === "true"
      ? dryRunCoinbaseCredential()
      : loadPartnerCoinbaseCredential(process.env);
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
  return executeClaimedPrivateSubmission({
    state,
    work_order_commitment: body.work_order_commitment,
    claim_context: claimContext,
    prepare: async () => {
      await enforceInstructionPolicy({ body, instruction, session, state });
      if (
        body.execution_mode === "partner_omnibus" &&
        body.omnibus_allocation &&
        coinbaseOperationCreatesExposure(instruction.operation_class)
      ) {
        await state.putOmnibusAllocation(body.omnibus_allocation);
        await state.reserveOmnibus({
          allocation_commitment: body.omnibus_allocation.allocation_commitment,
          allocation: body.omnibus_allocation,
          work_order_commitment: body.work_order_commitment,
          notional_bucket: String(bucketToUsd(body.session_policy?.max_notional_bucket || "0")),
        });
      }
    },
    submit: () => submitExecution({ credential, instruction, clientOrderId }),
    evidence: async (adapterResult) => {
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
      return {
        attempt: executionAttempt({
          venue_id: "coinbase_advanced",
          platform_class: "coinbase_style_provider",
          execution_mode: body.execution_mode,
          adapterResult,
        }),
        receipt,
      };
    },
    finalize: async (_adapterResult, completed) => {
      if (
        body.execution_mode === "partner_omnibus" &&
        body.omnibus_allocation?.allocation_commitment &&
        coinbaseOperationCreatesExposure(instruction.operation_class)
      ) {
        for (const fill of completed.receipt.fill_commitments || []) {
          await state.settleOmnibusFill({
            allocation_commitment: body.omnibus_allocation.allocation_commitment,
            work_order_commitment: body.work_order_commitment,
            fill_commitment: fill,
            notional_bucket: String(Math.ceil(estimateOrderNotionalUsd(instruction.order || {}))),
          });
        }
      }
    },
  });
}

export async function executeSolanaPerpsOrder({
  body,
  recipient,
  state,
  submitExecution = submitSolanaPerpsExecution,
}) {
  const venueId = normalizeSolanaPerpsVenueId(body.venue_id);
  const executionMode = body.execution_mode === "ghola_pooled" ? "ghola_pooled" : "user_stealth";
  const claimContext = executionClaimContext({
    body,
    venue_id: venueId,
    platform_class: "solana_perps_market",
    execution_mode: executionMode,
  });
  const cached = await boundCachedExecutionReceipt({
    state,
    work_order_commitment: body.work_order_commitment,
    claim_context: claimContext,
  });
  if (cached) return cached;
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
  assertPrivateExecutionRecoveryInvariant({
    venue_id: venueId,
    execution_mode: executionMode,
    instruction,
    dry_run: process.env.PRIVATE_AGENT_VENUE_DRY_RUN === "true",
  });
  await enforceInstructionPolicy({ body, instruction, session, state: null });
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
  const clientOrderId = await state.deriveClientOrderId(venueId, body.work_order_commitment);
  return executeClaimedPrivateSubmission({
    state,
    work_order_commitment: body.work_order_commitment,
    claim_context: claimContext,
    prepare: () => enforceInstructionPolicy({ body, instruction, session, state }),
    submit: () => {
      return submitExecution({
        credential,
        instruction,
        clientOrderId,
        venueId,
        executionMode,
      });
    },
    evidence: async (adapterResult) => ({
      attempt: executionAttempt({
        venue_id: venueId,
        platform_class: "solana_perps_market",
        execution_mode: executionMode,
        adapterResult,
      }),
      receipt: executionReceipt({
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
      }),
    }),
  });
}

export async function executeJupiterSwapOrder({ body, recipient, state }) {
  const executionMode = body.execution_mode === "ghola_pooled" ? "ghola_pooled" : "user_stealth";
  const claimContext = executionClaimContext({
    body,
    venue_id: "jupiter",
    platform_class: "solana_swap_aggregator",
    execution_mode: executionMode,
  });
  const cached = await boundCachedExecutionReceipt({
    state,
    work_order_commitment: body.work_order_commitment,
    claim_context: claimContext,
  });
  if (cached) return cached;
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
  await enforceInstructionPolicy({ body, instruction, session, state: null });
  const clientOrderId = await state.deriveClientOrderId("jupiter", body.work_order_commitment);
  return executeClaimedPrivateSubmission({
    state,
    work_order_commitment: body.work_order_commitment,
    claim_context: claimContext,
    prepare: () => enforceInstructionPolicy({ body, instruction, session, state }),
    submit: () => {
      return submitJupiterSwapExecution({
        credential,
        instruction,
        clientOrderId,
        executionMode,
      });
    },
    evidence: async (adapterResult) => ({
      attempt: executionAttempt({
        venue_id: "jupiter",
        platform_class: "solana_swap_aggregator",
        execution_mode: executionMode,
        adapterResult,
      }),
      receipt: executionReceipt({
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
      }),
    }),
  });
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

export async function reconcileCoinbaseClaim({ body, recipient, state }) {
  const workOrderCommitment = body.work_order_commitment;
  const evidence = await state.getExecutionClaimEvidence(workOrderCommitment);
  if (!evidence?.context || evidence.context.venue_id !== "coinbase_advanced") {
    const error = new PrivateExecutionError("coinbase execution claim was not found", 404);
    error.code = "COINBASE_EXECUTION_CLAIM_NOT_FOUND";
    throw error;
  }
  if (evidence.receipt?.final_proof?.final_fill_proven === true) {
    return evidence.receipt;
  }

  let credential;
  const executionMode = evidence.context.execution_mode || body.execution_mode || "byo_api_key";
  if (executionMode === "partner_omnibus") {
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

  const clientOrderId = await state.deriveClientOrderId("ghola", workOrderCommitment);
  const providerOrderId = evidence.attempt?.provider_ref_seed?.order_id ||
    evidence.receipt?.final_proof?.provider_order_id ||
    null;
  const adapterResult = await reconcileCoinbaseExecution({
    credential,
    instruction: {
      operation_class: "reconcile",
      reconcile: { product_id: body.product_id || null },
    },
    clientOrderId,
    providerOrderId,
  });
  const completed = bindExecutionClaimCompletion({
    attempt: executionAttempt({
      venue_id: "coinbase_advanced",
      platform_class: "coinbase_style_provider",
      execution_mode: executionMode,
      adapterResult,
    }),
    receipt: executionReceipt({
      venue_id: "coinbase_advanced",
      platform_class: "coinbase_style_provider",
      execution_mode: executionMode,
      instruction: null,
      body,
      status: adapterResult.status,
      provider_ref_seed: adapterResult.provider_ref_seed,
      result_seed: adapterResult.result_seed,
      fills: adapterResult.fills,
      final_proof: adapterResult.final_proof,
      visibility_summary: evidence.receipt?.visibility_summary || {
        main_wallet_exposed: false,
        ghola_operator_sees: "commitment_and_ciphertext_only",
        coinbase_sees: executionMode === "partner_omnibus"
          ? "partner_pooled_account_and_order_activity"
          : "byo_account_and_order_activity",
      },
    }),
  }, evidence.context);
  if (adapterResult.final_proof?.final_fill_proven !== true) {
    return completed.receipt;
  }
  if (typeof state.resolveExecutionClaim !== "function") {
    throw new PrivateExecutionError("durable execution reconciliation is unavailable", 503);
  }
  return state.resolveExecutionClaim(workOrderCommitment, completed);
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
  const cached = (await state.getIdempotency(body.work_order_commitment))?.receipt || null;
  if (cached) return cached;
  const evidence = typeof state.getExecutionClaimEvidence === "function"
    ? await state.getExecutionClaimEvidence(body.work_order_commitment)
    : null;
  if (evidence?.receipt) return evidence.receipt;
  const attempted = evidence?.attempt || await state.getExecutionAttempt(body.work_order_commitment);
  const storedProof = attempted?.final_proof && typeof attempted.final_proof === "object"
    ? attempted.final_proof
    : {};
  const broadcastPerformed = storedProof.broadcast_performed === true;
  const finalVenueExecutionProven = storedProof.final_venue_execution_proven === true;
  const finalFillProven = storedProof.final_fill_proven === true;
  const status = attempted?.status === "failed"
    ? "failed"
    : finalVenueExecutionProven ? "reconciled" : "reconcile_required";
  const providerRefSeed = attempted?.provider_ref_seed ||
    {
      venue: venue_id,
      work_order_commitment: body.work_order_commitment,
      reconciliation_only: true,
    };
  const resultSeed = attempted?.result_seed ||
    {
      kind: `${venue_id}_reconcile`,
      status,
      work_order_commitment: body.work_order_commitment,
    };
  const finalProof = {
    ...storedProof,
    version: 1,
    proof_kind: storedProof.proof_kind || "connector_execution_reconciliation_v1",
    status,
    venue_id,
    broadcast_performed: broadcastPerformed,
    final_venue_execution_proven: finalVenueExecutionProven,
    final_fill_proven: finalFillProven,
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
    fills: attempted?.fills || [],
    final_proof: finalProof,
    visibility_summary: {
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
    const error = new PrivateExecutionError(
      "cancel target work order is unresolved; reconciliation required",
      400,
    );
    error.code = "EXECUTION_CANCEL_TARGET_UNRESOLVED";
    throw error;
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

function coinbaseOperationCreatesExposure(operationClass) {
  return COINBASE_EXPOSURE_CREATING_OPERATIONS.has(operationClass);
}

function privateExecutionContainmentError(code, message) {
  const error = new PrivateExecutionError(message, 503);
  error.code = code;
  return error;
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

function executionClaimContext({ body, venue_id, platform_class, execution_mode }) {
  return {
    venue_id,
    platform_class,
    execution_mode,
    operation_class: body.operation_class,
    request_digest: executionRequestDigest({
      body,
      venue_id,
      platform_class,
      execution_mode,
    }),
  };
}

function executionRequestDigest({ body, venue_id, platform_class, execution_mode }) {
  const publicBody = Object.fromEntries(Object.entries(body || {}));
  return sha256Hex(stableExecutionJson({
    venue_id,
    platform_class,
    execution_mode,
    operation_class: body?.operation_class || null,
    body: publicBody,
    internal_instruction: body?.[AUTOPILOT_INTERNAL_INSTRUCTION] || null,
  }));
}

async function boundCachedExecutionReceipt({
  state,
  work_order_commitment,
  claim_context,
}) {
  const receipt = (await state.getIdempotency(work_order_commitment))?.receipt || null;
  if (!receipt) return null;
  if (
    typeof claim_context?.request_digest !== "string" ||
    receipt.execution_request_digest !== claim_context.request_digest
  ) {
    throw executionClaimContextMismatch();
  }
  return receipt;
}

function bindExecutionClaimCompletion(completed, claimContext) {
  if (!completed || typeof completed !== "object") {
    throw new PrivateExecutionError("execution completion is invalid", 500);
  }
  const requestDigest = claimContext?.request_digest;
  if (typeof requestDigest !== "string") throw executionClaimContextMismatch();
  return {
    ...completed,
    attempt: {
      ...(completed.attempt || {}),
      execution_request_digest: requestDigest,
    },
    receipt: {
      ...(completed.receipt || {}),
      execution_request_digest: requestDigest,
    },
  };
}

function executionClaimContextMismatch() {
  const error = new PrivateExecutionError(
    "work order is bound to a different execution request",
    409,
  );
  error.code = "EXECUTION_CLAIM_CONTEXT_MISMATCH";
  return error;
}

function executionAttempt({ venue_id, platform_class, execution_mode, adapterResult }) {
  return {
    venue_id,
    platform_class,
    execution_mode,
    provider_ref_seed: adapterResult.provider_ref_seed,
    result_seed: adapterResult.result_seed,
    fills: adapterResult.fills,
    final_proof: adapterResult.final_proof || null,
    status: adapterResult.status,
    created_at: new Date().toISOString(),
  };
}

function safeExecutionErrorCode(error) {
  const raw = typeof error?.code === "string"
    ? error.code
    : typeof error?.name === "string"
      ? error.name
      : "execution_error";
  return raw.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 96) || "execution_error";
}

function executionClaimFailure(context, error) {
  return {
    ...context,
    error_code: safeExecutionErrorCode(error),
    error_message: String(error?.message || "execution rejected").slice(0, 240),
    error_status: Number.isInteger(error?.status) ? error.status : 400,
    created_at: new Date().toISOString(),
  };
}

function executionClaimRejection(rejection) {
  const error = new PrivateExecutionError(
    String(rejection.error_message || "execution rejected"),
    Number.isInteger(rejection.error_status) ? rejection.error_status : 400,
  );
  error.code = String(rejection.error_code || "EXECUTION_CLAIM_REJECTED");
  return error;
}

function executionReceipt(input) {
  const providerRefCommitment = commitment(`${input.venue_id}_provider_ref`, input.provider_ref_seed);
  const fillCommitments = Array.isArray(input.fills)
    ? input.fills.map((fill) => commitment(`${input.venue_id}_fill`, fill))
    : [];
  const fillSummary = summarizeExecutionFills(input.fills);
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
    fill_summary: fillSummary,
    final_proof: input.final_proof || null,
    visibility_summary: input.visibility_summary,
    updated_at: new Date().toISOString(),
  };
}

function summarizeExecutionFills(fills) {
  if (!Array.isArray(fills) || fills.length === 0) {
    return {
      fill_count: 0,
      filled_base_size: "0",
      filled_notional_usd: 0,
      average_fill_price: null,
      fee_usd: 0,
      fee_status: "not_applicable",
    };
  }
  let baseSize = 0;
  let notional = 0;
  let fees = 0;
  let fillCount = 0;
  for (const fill of fills.slice(0, 25)) {
    const size = Number(fill?.sz ?? fill?.size ?? fill?.base_size ?? 0);
    const price = Number(fill?.px ?? fill?.price ?? 0);
    const fee = Number(fill?.fee ?? fill?.commission ?? 0);
    if (!Number.isFinite(size) || !Number.isFinite(price) || size <= 0 || price <= 0) continue;
    baseSize += size;
    notional += size * price;
    if (Number.isFinite(fee)) fees += Math.abs(fee);
    fillCount += 1;
  }
  return {
    fill_count: fillCount,
    filled_base_size: decimalText(baseSize),
    filled_notional_usd: roundMoney(notional),
    average_fill_price: baseSize > 0 ? roundMoney(notional / baseSize) : null,
    fee_usd: roundMoney(fees),
    fee_status: fees > 0 ? "reported" : "pending_reconciliation",
  };
}

function decimalText(value) {
  return Number.isFinite(value) && value > 0 ? String(Math.round(value * 1e8) / 1e8) : "0";
}

function roundMoney(value) {
  return Number.isFinite(value) ? Math.round(value * 1e8) / 1e8 : 0;
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
    strategy_id: typeof policy.strategy_id === "string" ? policy.strategy_id : null,
    execution_network: policy.execution_network === "testnet" ? "testnet" : policy.execution_network === "mainnet" ? "mainnet" : null,
    exact_notional_usd: typeof policy.exact_notional_usd === "string" ? policy.exact_notional_usd : null,
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

function stableExecutionJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableExecutionJson).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableExecutionJson(item)}`)
    .join(",")}}`;
}
