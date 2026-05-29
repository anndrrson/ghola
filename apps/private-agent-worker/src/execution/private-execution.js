import { createHash } from "node:crypto";
import { openSealedBundle } from "../crypto/envelope.js";
import {
  bucketToUsd,
  enforceInstructionPolicy,
  estimateOrderNotionalUsd,
  normalizeInstruction,
} from "./policy.js";
import {
  coinbaseCredentialFromVault,
  loadPartnerCoinbaseCredential,
  submitCoinbaseExecution,
} from "../venues/coinbase.js";
import {
  hyperliquidManagedAccountRefs,
  hyperliquidCredentialFromVault,
  loadManagedHyperliquidCredential,
  readHyperliquidAccountSnapshot,
  submitHyperliquidExecution,
} from "../venues/hyperliquid.js";
import {
  normalizeSolanaPerpsVenueId,
  solanaPerpsCredentialFromVault,
  submitSolanaPerpsExecution,
  verifySolanaPerpsNoSubmit,
} from "../venues/solana_perps.js";

export class PrivateExecutionError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "PrivateExecutionError";
    this.status = status;
  }
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
  state.putSession(session);
  return session;
}

export async function storeHyperliquidSession({ body, recipient, state, provider }) {
  const executionMode = body.execution_mode === "managed_testnet" ? "managed_testnet" : "byo_api_key";
  if (executionMode === "byo_api_key") {
    await openSealedBundle(body.encrypted_execution_vault, recipient, {
      aadPrefix: "ghola/hyperliquid-execution-vault-v1",
      expectedKind: "ghola_hyperliquid_execution_vault",
    });
  } else if (body.managed_allocation?.credential_ref) {
    state.putHyperliquidManagedAllocation(body.managed_allocation);
  } else {
    const allocationCommitment = body.managed_allocation_commitment || body.allocation_commitment;
    if (!state.getHyperliquidManagedAllocation(allocationCommitment)) {
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
  state.putSession(session);
  return session;
}

export function createHyperliquidManagedAllocation({ body, state }) {
  const network = body.network === "testnet" ? "testnet" : "testnet";
  const refs = hyperliquidManagedAccountRefs();
  if (process.env.PRIVATE_AGENT_VENUE_DRY_RUN !== "true" && refs.length === 0) {
    throw new PrivateExecutionError("hyperliquid managed testnet pool is unavailable", 503);
  }
  const selected = refs.length > 0
    ? refs[managedCredentialIndex(body.account_commitment, refs.length)]
    : {
        credential_ref: commitment("hyperliquid_managed_credential", {
          account_commitment: body.account_commitment,
          network,
          dry_run: true,
        }),
        network,
        market_allowlist: [],
      };
  if (selected.network !== "testnet") {
    throw new PrivateExecutionError("hyperliquid managed pilot is testnet-only", 400);
  }
  const policy = publicSessionPolicy(body.session_policy, body.policy_commitment);
  const allocation = {
    version: 1,
    venue_id: "hyperliquid",
    platform_class: "hyperliquid_style_market",
    execution_mode: "managed_testnet",
    network,
    status: "allocated",
    account_commitment: body.account_commitment,
    allocation_commitment: commitment("hyperliquid_managed_allocation", {
      account_commitment: body.account_commitment,
      policy_commitment: body.policy_commitment,
      credential_ref: selected.credential_ref,
      network,
    }),
    policy_commitment: body.policy_commitment,
    pool_commitment: commitment("hyperliquid_managed_pool", {
      network,
      credential_count: refs.length,
    }),
    subledger_account_commitment: commitment("hyperliquid_managed_subledger", {
      account_commitment: body.account_commitment,
      network,
    }),
    credential_ref: selected.credential_ref,
    session_policy: policy,
    allowed_operations: ["read", "limit_order", "cancel", "reconcile"],
    blocked_operations: ["withdraw", "vault_transfer", "leverage_escalation", "staking"],
    visibility_summary: {
      main_wallet_exposed: false,
      ghola_operator_sees: "commitment_and_ciphertext_only",
      hyperliquid_sees: "execution_account_and_order_activity",
      public_chain_sees: "no_public_wallet_settlement",
    },
    created_at: new Date().toISOString(),
  };
  state.putHyperliquidManagedAllocation(allocation);
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
  if (body.omnibus_allocation) state.putOmnibusAllocation(body.omnibus_allocation);
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
  state.putSession(session);
  return session;
}

export async function executeHyperliquidOrder({ body, recipient, state }) {
  const cached = state.getIdempotency(body.work_order_commitment);
  if (cached?.receipt) return cached.receipt;
  const executionMode = hyperliquidExecutionMode(body);
  let credential;
  let allocation = null;
  if (executionMode === "managed_testnet") {
    const allocationCommitment = body.managed_allocation_commitment || body.allocation_commitment;
    const record = state.getHyperliquidManagedAllocation(allocationCommitment);
    if (!record?.allocation || record.allocation.status !== "allocated") {
      throw new PrivateExecutionError("hyperliquid managed allocation is unavailable", 404);
    }
    allocation = record.allocation;
    credential = loadManagedHyperliquidCredential(allocation);
  } else {
    const openedVault = await openSealedBundle(body.encrypted_execution_vault, recipient, {
      aadPrefix: "ghola/hyperliquid-execution-vault-v1",
      expectedKind: "ghola_hyperliquid_execution_vault",
    });
    credential = hyperliquidCredentialFromVault(openedVault.json);
  }
  const session = state.findSession({
    venue_id: "hyperliquid",
    vault_commitment: executionMode === "byo_api_key" ? body.vault_commitment : undefined,
    allocation_commitment: executionMode === "managed_testnet"
      ? body.managed_allocation_commitment || body.allocation_commitment
      : undefined,
    policy_commitment: body.policy_commitment,
  });
  const instruction = resolvePrivateCancelTarget(await instructionForBody({
    body,
    recipient,
    venue_id: "hyperliquid",
    session,
  }), { state, venue_id: "hyperliquid" });
  enforceInstructionPolicy({ body, instruction, session, state });
  const cloid = state.deriveHyperliquidCloid(body.work_order_commitment);
  const adapterResult = await submitHyperliquidExecution({
    credential,
    instruction,
    cloid,
  });
  const receipt = executionReceipt({
    venue_id: "hyperliquid",
    platform_class: "hyperliquid_style_market",
    execution_mode: executionMode,
    body,
    status: adapterResult.status,
    provider_ref_seed: adapterResult.provider_ref_seed,
    result_seed: adapterResult.result_seed,
    fills: adapterResult.fills,
    visibility_summary: {
      main_wallet_exposed: false,
      ghola_operator_sees: "commitment_and_ciphertext_only",
      hyperliquid_sees: "execution_account_and_order_activity",
      venue_access_source: executionMode === "byo_api_key" ? "user_provided_credentials" : "ghola_managed_testnet",
      ghola_access_role: "private_execution_router",
      venue_gate: "venue_accepts_or_rejects_credentials",
      public_chain_sees: allocation
        ? "no_public_wallet_settlement"
        : instruction.order?.live_order_mode === "tiny_fill"
          ? "no_ghola_public_settlement"
          : "private_funding_evidence_required",
    },
  });
  return state.putIdempotency(body.work_order_commitment, receipt);
}

export async function readHyperliquidSnapshot({ body, recipient, state }) {
  const executionMode = hyperliquidExecutionMode(body);
  let credential;
  if (executionMode === "managed_testnet") {
    const allocationCommitment = body.managed_allocation_commitment || body.allocation_commitment;
    const record = state.getHyperliquidManagedAllocation(allocationCommitment);
    if (!record?.allocation || record.allocation.status !== "allocated") {
      throw new PrivateExecutionError("hyperliquid managed allocation is unavailable", 404);
    }
    credential = loadManagedHyperliquidCredential(record.allocation);
  } else {
    const openedVault = await openSealedBundle(body.encrypted_execution_vault, recipient, {
      aadPrefix: "ghola/hyperliquid-execution-vault-v1",
      expectedKind: "ghola_hyperliquid_execution_vault",
    });
    credential = hyperliquidCredentialFromVault(openedVault.json);
  }
  return readHyperliquidAccountSnapshot({
    credential,
    accountSource: executionMode === "managed_testnet" ? "ghola_managed" : "sealed_byo",
  });
}

export async function executeCoinbaseOrder({ body, recipient, state }) {
  const cached = state.getIdempotency(body.work_order_commitment);
  if (cached?.receipt) return cached.receipt;
  const session = state.findSession({
    venue_id: "coinbase_advanced",
    vault_commitment: body.vault_commitment || undefined,
    policy_commitment: body.policy_commitment || undefined,
    allocation_commitment: body.omnibus_allocation?.allocation_commitment || body.allocation_commitment || undefined,
  });
  const instruction = resolvePrivateCancelTarget(await instructionForBody({
    body,
    recipient,
    venue_id: "coinbase_advanced",
    session,
  }), { state, venue_id: "coinbase_advanced" });
  enforceInstructionPolicy({ body, instruction, session, state });

  let credential;
  if (body.execution_mode === "partner_omnibus") {
    credential = process.env.PRIVATE_AGENT_VENUE_DRY_RUN === "true"
      ? dryRunCoinbaseCredential()
      : loadPartnerCoinbaseCredential(process.env);
    if (body.omnibus_allocation) {
      state.putOmnibusAllocation(body.omnibus_allocation);
      state.reserveOmnibus({
        allocation_commitment: body.omnibus_allocation.allocation_commitment,
        allocation: body.omnibus_allocation,
        work_order_commitment: body.work_order_commitment,
        notional_bucket: String(bucketToUsd(body.session_policy?.max_notional_bucket || "0")),
      });
    }
  } else {
    const openedVault = await openSealedBundle(body.encrypted_execution_vault, recipient, {
      aadPrefix: "ghola/coinbase-advanced-execution-vault-v1",
      expectedKind: "ghola_coinbase_advanced_execution_vault",
    });
    credential = coinbaseCredentialFromVault(openedVault.json);
  }

  const clientOrderId = state.deriveClientOrderId("ghola", body.work_order_commitment);
  let adapterResult;
  try {
    adapterResult = await submitCoinbaseExecution({
      credential,
      instruction,
      clientOrderId,
    });
  } catch (error) {
    if (body.execution_mode === "partner_omnibus" && body.omnibus_allocation?.allocation_commitment) {
      state.releaseOmnibus({
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
    body,
    status: adapterResult.status,
    provider_ref_seed: adapterResult.provider_ref_seed,
    result_seed: adapterResult.result_seed,
    fills: adapterResult.fills,
    visibility_summary: {
      main_wallet_exposed: false,
      ghola_operator_sees: "commitment_and_ciphertext_only",
      coinbase_sees: body.execution_mode === "partner_omnibus"
        ? "partner_pooled_account_and_order_activity"
        : "byo_account_and_order_activity",
    },
  });
  if (body.execution_mode === "partner_omnibus" && body.omnibus_allocation?.allocation_commitment) {
    for (const fill of receipt.fill_commitments || []) {
      state.settleOmnibusFill({
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
  const cached = state.getIdempotency(body.work_order_commitment);
  if (cached?.receipt) return cached.receipt;
  const venueId = normalizeSolanaPerpsVenueId(body.venue_id);
  const executionMode = body.execution_mode === "ghola_pooled" ? "ghola_pooled" : "user_stealth";
  let credential = null;
  if (process.env.PRIVATE_AGENT_VENUE_DRY_RUN !== "true") {
    const openedVault = await openSealedBundle(body.encrypted_execution_vault, recipient, {
      aadPrefix: "ghola/solana-perps-execution-vault-v1",
      expectedKind: "ghola_solana_perps_execution_vault",
    });
    credential = solanaPerpsCredentialFromVault(openedVault.json);
  }
  const session = state.findSession({
    venue_id: venueId,
    vault_commitment: body.vault_commitment || undefined,
    allocation_commitment: body.allocation_commitment || undefined,
    policy_commitment: body.policy_commitment || undefined,
  });
  const instruction = resolvePrivateCancelTarget(await instructionForBody({
    body,
    recipient,
    venue_id: venueId,
    session,
  }), { state, venue_id: venueId });
  enforceInstructionPolicy({ body, instruction, session, state });
  const clientOrderId = state.deriveClientOrderId(venueId, body.work_order_commitment);
  const adapterResult = await submitSolanaPerpsExecution({
    credential,
    instruction,
    clientOrderId,
    venueId,
    executionMode,
  });
  const receipt = executionReceipt({
    venue_id: venueId,
    platform_class: "solana_perps_market",
    execution_mode: executionMode,
    body,
    status: adapterResult.status,
    provider_ref_seed: adapterResult.provider_ref_seed,
    result_seed: adapterResult.result_seed,
    fills: adapterResult.fills,
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

export async function verifySolanaPerpsOrderNoSubmit({ body, recipient, state }) {
  const venueId = normalizeSolanaPerpsVenueId(body.venue_id);
  const executionMode = body.execution_mode === "ghola_pooled" ? "ghola_pooled" : "user_stealth";
  const openedVault = await openSealedBundle(body.encrypted_execution_vault, recipient, {
    aadPrefix: "ghola/solana-perps-execution-vault-v1",
    expectedKind: "ghola_solana_perps_execution_vault",
  });
  const credential = solanaPerpsCredentialFromVault(openedVault.json);
  const session = state.findSession({
    venue_id: venueId,
    vault_commitment: body.vault_commitment || undefined,
    allocation_commitment: body.allocation_commitment || undefined,
    policy_commitment: body.policy_commitment || undefined,
  });
  const instruction = resolvePrivateCancelTarget(await instructionForBody({
    body,
    recipient,
    venue_id: venueId,
    session,
  }), { state, venue_id: venueId });
  enforceInstructionPolicy({ body, instruction, session, state: null });
  const clientOrderId = state.deriveClientOrderId(venueId, body.work_order_commitment);
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

async function instructionForBody({ body, recipient, venue_id, session }) {
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

function resolvePrivateCancelTarget(instruction, { state, venue_id }) {
  const target = instruction?.cancel?.target_work_order_commitment;
  if (instruction?.operation_class !== "cancel" || !target) return instruction;
  if (!state.getIdempotency(target)?.receipt) {
    throw new PrivateExecutionError("cancel target work order is unknown");
  }
  const clientOrderId = venue_id === "hyperliquid"
    ? state.deriveHyperliquidCloid(target)
    : state.deriveClientOrderId("ghola", target);
  return {
    ...instruction,
    cancel: {
      ...instruction.cancel,
      client_order_id: clientOrderId,
    },
  };
}

function hyperliquidExecutionMode(body) {
  return body.execution_mode === "managed_testnet" ||
      body.managed_allocation_commitment ||
      body.allocation_commitment
    ? "managed_testnet"
    : "byo_api_key";
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
  return {
    version: 1,
    venue_id: input.venue_id === "hyperliquid" ? undefined : input.venue_id,
    platform_class: input.platform_class,
    execution_mode: input.execution_mode || undefined,
    status: input.status || "submitted",
    work_order_commitment: input.body.work_order_commitment,
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
    fill_commitments: fillCommitments,
    visibility_summary: input.visibility_summary,
    updated_at: new Date().toISOString(),
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

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  return JSON.stringify(value, Object.keys(value || {}).sort());
}
