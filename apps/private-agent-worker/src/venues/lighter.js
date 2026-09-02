import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { didKeyFromVerifying, openSealedBundle } from "../crypto/envelope.js";
import {
  carryInventoryClientOrderIdentityCommitment,
  carryInventoryProviderOrderIdentityCommitment,
} from "../execution/carry-inventory.js";
import { fundingSigningIdentity } from "./shielded_funding_attestation.js";
import { lighterLiquidationDistance } from "./liquidation-distance.js";

const ALLOWED = new Set(["read", "limit_order", "cancel", "reconcile"]);
const OWNER_ONLY = ["withdraw", "transfer", "leverage", "margin", "account_config", "api_key_rotation"];
const SAFE_COMMITMENT = /^[A-Za-z0-9_.:-]{8,240}$/;
const UINT48_MAX = 281_474_976_710_655;
const GOLDILOCKS_MODULUS = 0xffffffff00000001n;
const LIGHTER_ACCOUNT_STATUS_INACTIVE = 0;
const LIGHTER_ACCOUNT_STATUS_ACTIVE = 1;
const LIGHTER_ORDER_FINGERPRINT_VERSION = 1;
const LIGHTER_ORDER_TIME_SKEW_MS = 300_000;
const LIGHTER_TIME_IN_FORCE = Object.freeze({
  ioc: "immediate-or-cancel",
  gtc: "good-till-time",
  alo: "post-only",
});
const LIGHTER_CANCELED_ORDER_STATUSES = new Set([
  "canceled",
  "canceled-post-only",
  "canceled-reduce-only",
  "canceled-position-not-allowed",
  "canceled-margin-not-allowed",
  "canceled-too-much-slippage",
  "canceled-not-enough-liquidity",
  "canceled-self-trade",
  "canceled-expired",
  "canceled-oco",
  "canceled-child",
  "canceled-liquidation",
  "canceled-invalid-balance",
]);

export class LighterExecutionError extends Error {
  constructor(message, status = 400, code = "venue_rejected") {
    super(message);
    this.name = "LighterExecutionError";
    this.status = status;
    this.code = code;
  }
}

export async function openLighterExecutionCredential({
  bundle,
  recipient,
  accountCommitment,
  sealingIdentity = fundingSigningIdentity,
}) {
  const opened = await openSealedBundle(bundle, recipient, {
    expectedAad: [
      "ghola/lighter-execution-vault-v1",
      `account:${accountCommitment}`,
      `recipient:${recipient.recipient_id}`,
      "network:mainnet",
    ].join("|"),
    expectedKind: "ghola_lighter_execution_vault",
  });
  const identity = sealingIdentity();
  const publicDer = identity?.publicKey?.export?.({ format: "der", type: "spki" });
  const publicBytes = publicDer ? new Uint8Array(Buffer.from(publicDer).subarray(-32)) : new Uint8Array();
  if (publicBytes.length !== 32 || opened.senderDid !== didKeyFromVerifying(publicBytes)) {
    throw new LighterExecutionError("lighter execution vault signer is invalid", 403, "venue_access_required");
  }
  return lighterCredentialFromVault(opened.json, { accountCommitment });
}

export function lighterCredentialFromVault(vault, { accountCommitment } = {}) {
  if (vault?.kind !== "ghola_lighter_execution_vault" || vault?.version !== 1) {
    throw new LighterExecutionError("lighter execution vault is invalid", 400, "venue_access_required");
  }
  const accountIndex = integer(vault.account_index, "lighter account index is invalid");
  const apiKeyIndex = integer(vault.api_key_index, "lighter API key index is invalid");
  const apiPrivateKey = String(vault.api_private_key || "").replace(/^0x/, "");
  const apiPublicKey = String(vault.api_public_key || "").replace(/^0x/, "").toLowerCase();
  const sealedAccountCommitment = String(vault.account_commitment || "");
  if (
    vault.network !== "mainnet" || accountIndex > UINT48_MAX || apiKeyIndex < 2 || apiKeyIndex > 254 ||
    !/^0x[0-9a-f]{40}$/i.test(String(vault.owner_address || "")) ||
    !SAFE_COMMITMENT.test(sealedAccountCommitment) ||
    (accountCommitment !== undefined && sealedAccountCommitment !== accountCommitment) ||
    vault.provisioning_status !== "owner_association_verified" ||
    !exactStringSet(vault.allowed_operations, ALLOWED) || !includesEvery(vault.blocked_operations, OWNER_ONLY) ||
    !includesEvery(vault.owner_only_operations, OWNER_ONLY)
  ) {
    throw new LighterExecutionError("lighter execution vault binding is invalid", 400, "venue_access_required");
  }
  if (!/^[0-9a-f]{64}$/i.test(apiPrivateKey) || /^0{64}$/.test(apiPrivateKey)) {
    throw new LighterExecutionError("lighter API private key is invalid", 400, "venue_access_required");
  }
  assertLighterPublicKey(apiPublicKey);
  const permissions = vault.permissions || {};
  if (permissions.can_read !== true || permissions.can_trade !== true || permissions.can_withdraw !== false || permissions.can_transfer !== false) {
    throw new LighterExecutionError("lighter authority boundary is invalid", 400, "venue_access_required");
  }
  return {
    network: vault.network === "testnet" ? "testnet" : "mainnet",
    api_base_url: vault.network === "testnet"
      ? "https://testnet.zklighter.elliot.ai"
      : "https://mainnet.zklighter.elliot.ai",
    account_index: accountIndex,
    api_key_index: apiKeyIndex,
    api_private_key: apiPrivateKey,
    authority_boundary: {
      tee_allowed: [...ALLOWED],
      owner_only: OWNER_ONLY,
      venue_native_trade_only: false,
      withdrawal_request_permitted: false,
      secure_withdrawal_destination: "owner_l1_only",
      owner_wallet_key_present: false,
      non_owner_fund_movement_possible: false,
    },
  };
}

function assertLighterPublicKey(value) {
  if (!/^[0-9a-f]{80}$/.test(value) || /^0{80}$/.test(value)) {
    throw new LighterExecutionError("lighter API public key is invalid", 400, "venue_access_required");
  }
  const bytes = Buffer.from(value, "hex");
  for (let offset = 0; offset < bytes.length; offset += 8) {
    let limb = 0n;
    for (let index = 7; index >= 0; index -= 1) limb = (limb << 8n) | BigInt(bytes[offset + index]);
    if (limb >= GOLDILOCKS_MODULUS) {
      throw new LighterExecutionError("lighter API public key is non-canonical", 400, "venue_access_required");
    }
  }
}

function exactStringSet(value, expected) {
  return Array.isArray(value) && value.length === expected.size && value.every((entry) => expected.has(entry));
}

function includesEvery(value, expected) {
  return Array.isArray(value) && expected.every((entry) => value.includes(entry));
}

export function assertLighterPilotMode(credential, operationClass, env = process.env) {
  if (!ALLOWED.has(operationClass)) throw new LighterExecutionError("lighter operation is forbidden", 403, "policy_denied");
  if (credential.network === "mainnet" && env.PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET !== "true") {
    throw new LighterExecutionError("lighter mainnet is disabled", 400, "live_execution_disabled");
  }
  const mode = env.PRIVATE_AGENT_LIGHTER_LIVE_MODE || "disabled";
  if ((operationClass === "read" || operationClass === "reconcile") && ["read_only", "tiny_fill", "full_ticket"].includes(mode)) return;
  if ((operationClass === "limit_order" || operationClass === "cancel") && ["tiny_fill", "full_ticket"].includes(mode)) return;
  throw new LighterExecutionError("lighter operation is disabled", 400, "live_execution_disabled");
}

export function lighterClientOrderIndex(workOrderCommitment) {
  const head = createHash("sha256").update(String(workOrderCommitment)).digest().readUInt32BE(0);
  return 1 + (head % 2_147_483_646);
}

export function lighterOrderFingerprint(instruction, clientOrderIndex, { submittedAtMs = Date.now() } = {}) {
  const order = normalizeOrder(instruction, clientOrderIndex);
  return normalizeSubmittedOrderFingerprint({
    version: LIGHTER_ORDER_FINGERPRINT_VERSION,
    market: order.market,
    client_order_index: order.client_order_index,
    side: order.side,
    base_size: order.base_size,
    limit_price: order.limit_price,
    reduce_only: order.reduce_only,
    time_in_force: order.tif,
    submitted_at_ms: submittedAtMs,
  });
}

export async function verifyLighterCredential({ credential, runner = defaultRunner }) {
  assertLighterPilotMode(credential, "read");
  const result = await runner({ action: "credential", credential, timeout_ms: timeoutMs() });
  if (result?.credential_verified !== true || result?.account_read !== true || result?.transaction_broadcast !== false) {
    throw new LighterExecutionError("lighter credential verification failed", 502, "venue_access_required");
  }
  const account = sanitizeAccount(result.account, {}, { expectedAccountIndex: credential.account_index });
  return {
    can_read: true,
    can_trade: account.can_trade,
    can_withdraw: false,
    secure_withdrawal_to_owner_possible: true,
    non_owner_fund_movement_possible: false,
    venue_native_trade_only: false,
    account,
  };
}

export async function readLighterWithdrawalRouteQuote({
  credential,
  account_state_commitment: accountStateCommitment,
  target_market: targetMarket = null,
  runner = defaultRunner,
  now = () => Date.now(),
}) {
  assertLighterPilotMode(credential, "read");
  if (!SAFE_COMMITMENT.test(String(accountStateCommitment || ""))) {
    throw new LighterExecutionError("lighter route account binding is invalid", 400, "venue_access_required");
  }
  const result = await runner({ action: "route_terms", credential, timeout_ms: timeoutMs() });
  if (result?.credential_verified !== true
    || result?.account_state_checked !== true
    || result?.withdrawal_terms_checked !== true
    || result?.transaction_broadcast !== false
    || result?.fee_source !== "lighter_sdk_normal_withdrawal_v1"
    || strictDecimal(result?.normal_withdrawal_fee_usdc) !== 0) {
    throw new LighterExecutionError("lighter withdrawal route verification failed", 502, "venue_access_required");
  }
  const minimum = decimalToMicro(result.minimum_withdrawal_usdc, "ceiling");
  const maximum = decimalToMicro(result.maximum_withdrawal_usdc, "floor");
  const account = sanitizeAccount(result.account, targetMarket ? { symbol: targetMarket } : {}, {
    expectedAccountIndex: credential.account_index,
  });
  const delaySeconds = integer(result.withdrawal_delay_seconds, "lighter withdrawal delay is invalid");
  if (maximum < minimum || delaySeconds * 1_000 > 7 * 86_400_000) {
    throw new LighterExecutionError("lighter withdrawal route is unavailable", 422, "venue_rejected");
  }
  return Object.freeze({
    kind: "withdrawal",
    status: maximum === 0 ? "degraded" : "available",
    valuation_asset: "USD",
    venue_id: "lighter",
    collateral_asset: "USDC",
    account_state_commitment: accountStateCommitment,
    verified: true,
    capacity_bound_verified: true,
    fee_upper_bound_verified: true,
    latency_upper_bound_verified: true,
    read_only: true,
    fund_movement_authorized: false,
    transaction_broadcast: false,
    minimum_transfer_micro_usdc: minimum,
    maximum_transfer_micro_usdc: maximum,
    fee_upper_bound_micro_usdc: 0,
    latency_upper_bound_ms: delaySeconds * 1_000,
    as_of_ms: now(),
    account_state: account,
  });
}

export async function verifyLighterNoSubmit({ credential, instruction, clientOrderIndex, runner = defaultRunner }) {
  assertLighterPilotMode(credential, "read");
  const order = normalizeOrder(instruction, clientOrderIndex);
  const result = await runner({ action: "verify", credential, order, timeout_ms: timeoutMs() });
  if (
    result?.credential_verified !== true ||
    result?.account_state_checked !== true ||
    result?.market_data_checked !== true ||
    result?.order_packet_built !== true ||
    result?.signed_order_fields_checked !== true ||
    result?.transaction_broadcast !== false
  ) {
    throw new LighterExecutionError("lighter no-submit verification failed", 502, "connector_submit_failed");
  }
  return normalizedVerification(result, order, credential.account_index);
}

export async function submitLighterExecution({
  credential,
  instruction,
  clientOrderIndex,
  submittedOrderFingerprint = null,
  runner = defaultRunner,
}) {
  const operationClass = instruction?.operation_class;
  assertLighterPilotMode(credential, operationClass);
  if (operationClass === "reconcile") {
    const target = instruction.reconcile?.target_client_order_index;
    const expectedOrderIndex = unsignedDecimalIntegerText(instruction.reconcile?.expected_order_index);
    if (expectedOrderIndex === null) {
      throw new LighterExecutionError(
        "lighter explicit reconciliation requires exact original order lineage",
        503,
        "submission_ambiguous",
      );
    }
    return reconcileLighterExecution({
      credential,
      clientOrderIndex: integer(target, "lighter reconcile target is invalid"),
      market: instruction.reconcile?.target_market || instruction.reconcile?.market || instruction.reconcile?.product_id,
      expectedOrderFingerprint: instruction.reconcile?.expected_order_fingerprint,
      expectedOrderIndex,
      submissionTxHash: instruction.reconcile?.submission_tx_hash,
      runner,
    });
  }
  if (operationClass === "cancel") {
    const cancel = instruction.cancel || {};
    const market = lighterMarket(cancel.market);
    const targetClientOrderIndex = integer(cancel.client_order_index, "lighter cancel target is invalid");
    const expectedOrderFingerprint = normalizeSubmittedOrderFingerprint(cancel.expected_order_fingerprint);
    const expectedOrderIndex = unsignedDecimalIntegerText(cancel.expected_order_index);
    if (!expectedOrderFingerprint
      || expectedOrderIndex === null
      || expectedOrderFingerprint.client_order_index !== targetClientOrderIndex
      || expectedOrderFingerprint.market !== market) {
      throw new LighterExecutionError(
        "lighter cancel requires exact original order lineage",
        503,
        "submission_ambiguous",
      );
    }
    try {
      const result = await runner({
        action: "cancel",
        credential,
        market,
        client_order_index: targetClientOrderIndex,
        expected_order_index: expectedOrderIndex,
        expected_order_fingerprint: expectedOrderFingerprint,
        timeout_ms: timeoutMs(),
      });
      if (result?.cancel_target_revalidated !== true
        || result?.target_fingerprint_checked !== true
        || result?.target_fingerprint_matched !== true
        || result?.target_identifier_collision !== false
        || unsignedDecimalIntegerText(result?.order_index) !== expectedOrderIndex) {
        throw new LighterExecutionError(
          "lighter cancel target revalidation is unproven",
          503,
          "submission_ambiguous",
        );
      }
      const normalized = normalizedSubmit(
        result,
        targetClientOrderIndex,
        "cancelled",
        expectedOrderFingerprint,
      );
      return {
        ...normalized,
        provider_ref_seed: {
          ...normalized.provider_ref_seed,
          order_index: expectedOrderIndex,
        },
      };
    } catch (error) {
      throw ambiguousLighterWrite(error);
    }
  }
  const order = normalizeOrder(instruction, clientOrderIndex);
  const fingerprint = submittedOrderFingerprint
    ? normalizeSubmittedOrderFingerprint(submittedOrderFingerprint)
    : lighterOrderFingerprint(instruction, clientOrderIndex);
  assertFingerprintMatchesRequestedOrder(fingerprint, order);
  let result;
  try {
    result = await runner({ action: "submit", credential, order, timeout_ms: timeoutMs() });
  } catch (error) {
    throw ambiguousLighterWrite(error);
  }
  return normalizedSubmit(result, clientOrderIndex, "submitted", fingerprint);
}

export async function submitAndReconcileLighterExecution({
  credential,
  instruction,
  clientOrderIndex,
  submittedOrderFingerprint = null,
  allowLineageDiscovery = false,
  runner = defaultRunner,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  env = process.env,
}) {
  const reconcileOnly = instruction?.operation_class === "reconcile";
  const cancelOnly = instruction?.operation_class === "cancel";
  const reconciliationClientOrderIndex = reconcileOnly
    ? integer(instruction?.reconcile?.target_client_order_index, "lighter reconcile target is invalid")
    : cancelOnly
      ? integer(instruction?.cancel?.client_order_index, "lighter cancel target is invalid")
      : integer(clientOrderIndex, "lighter client order index is invalid");
  const reconciliationMarket = reconcileOnly
    ? instruction?.reconcile?.target_market || instruction?.reconcile?.market || instruction?.reconcile?.product_id
    : cancelOnly
      ? instruction?.cancel?.market
      : instruction?.order?.market;
  const reconciliationFingerprint = reconcileOnly
    ? normalizeSubmittedOrderFingerprint(instruction?.reconcile?.expected_order_fingerprint)
    : cancelOnly
      ? normalizeSubmittedOrderFingerprint(instruction?.cancel?.expected_order_fingerprint)
      : submittedOrderFingerprint
        ? normalizeSubmittedOrderFingerprint(submittedOrderFingerprint)
        : lighterOrderFingerprint(instruction, reconciliationClientOrderIndex, { submittedAtMs: now() });
  if (!reconciliationFingerprint) {
    throw new LighterExecutionError(
      "lighter reconciliation requires the original submitted order fingerprint",
      503,
      "submission_ambiguous",
    );
  }
  let expectedOrderIndex = unsignedDecimalIntegerText(
    reconcileOnly
      ? instruction?.reconcile?.expected_order_index
      : cancelOnly
        ? instruction?.cancel?.expected_order_index
        : null,
  );
  if (reconcileOnly && expectedOrderIndex === null && allowLineageDiscovery !== true) {
    throw new LighterExecutionError(
      "lighter explicit reconciliation requires exact original order lineage",
      503,
      "submission_ambiguous",
    );
  }
  const submissionTxHash = String(
    reconcileOnly
      ? instruction?.reconcile?.submission_tx_hash || ""
      : cancelOnly
        ? instruction?.cancel?.submission_tx_hash || ""
        : "",
  ) || null;
  let submitted = reconcileOnly ? {
    status: "outcome_unknown",
    provider_ref_seed: {
      venue: "lighter",
      client_order_index: reconciliationClientOrderIndex,
      tx_hash: submissionTxHash,
      submitted_order_fingerprint: reconciliationFingerprint,
      submitted_order_fingerprint_commitment: orderFingerprintCommitment(reconciliationFingerprint),
    },
    result_seed: { kind: "lighter_reconcile_started" },
    fills: [],
    final_proof: null,
  } : null;
  let submissionResponseAmbiguous = false;
  if (!reconcileOnly) {
    try {
      submitted = await submitLighterExecution({
        credential,
        instruction,
        clientOrderIndex,
        submittedOrderFingerprint: reconciliationFingerprint,
        runner,
      });
    } catch (error) {
      if (error?.code !== "submission_ambiguous") throw error;
      submissionResponseAmbiguous = true;
      submitted = {
        status: "outcome_unknown",
        provider_ref_seed: {
          venue: "lighter",
          client_order_index: reconciliationClientOrderIndex,
          tx_hash: null,
          submitted_order_fingerprint: reconciliationFingerprint,
          submitted_order_fingerprint_commitment: orderFingerprintCommitment(reconciliationFingerprint),
        },
        result_seed: { kind: "lighter_submission_response_ambiguous" },
        fills: [],
        final_proof: null,
      };
    }
  }
  if (submitted.final_proof?.final_venue_execution_proven === true) return submitted;
  const timeout = boundedMs(env.PRIVATE_AGENT_LIGHTER_RECONCILE_TIMEOUT_MS, 250, 5_000, 1_200);
  const interval = boundedMs(env.PRIVATE_AGENT_LIGHTER_RECONCILE_INTERVAL_MS, 25, 1_000, 100);
  const deadline = now() + timeout;
  const maxAttempts = Math.max(1, Math.ceil(timeout / interval) + 1);
  let last = submitted;
  let exactOrderObserved = false;
  let readFailures = 0;
  let attempts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    try {
      const reconciled = await reconcileLighterExecution({
        credential,
        clientOrderIndex: reconciliationClientOrderIndex,
        market: reconciliationMarket,
        expectedOrderFingerprint: reconciliationFingerprint,
        expectedOrderIndex,
        submissionTxHash: submitted.provider_ref_seed?.tx_hash || submissionTxHash,
        runner,
      });
      if (reconciled.final_proof?.target_client_order_matched === true) {
        exactOrderObserved = true;
        last = reconciled;
        expectedOrderIndex = unsignedDecimalIntegerText(reconciled.provider_ref_seed?.order_index)
          || expectedOrderIndex;
      }
    } catch {
      readFailures += 1;
    }
    if (last.final_proof?.final_venue_execution_proven === true) {
      return reconciledLighterResult(last, submitted, {
        reconcileOnly,
        submissionResponseAmbiguous,
        readFailures,
        attempts: attempt,
        exhausted: false,
      });
    }
    if (attempt >= maxAttempts || now() >= deadline) break;
    await sleep(interval);
  }
  if (exactOrderObserved) {
    return reconciledLighterResult(last, submitted, {
      reconcileOnly,
      submissionResponseAmbiguous,
      readFailures,
      attempts,
      exhausted: true,
    });
  }
  throw new LighterExecutionError(
    "lighter submission outcome remains ambiguous after bounded exact-order reconciliation",
    503,
    "submission_ambiguous",
  );
}

function reconciledLighterResult(result, submitted, reconciliation) {
  const fingerprint = result.provider_ref_seed?.submitted_order_fingerprint
    || submitted.provider_ref_seed?.submitted_order_fingerprint
    || null;
  return {
    ...result,
    provider_ref_seed: {
      ...result.provider_ref_seed,
      submission_tx_hash: submitted.provider_ref_seed?.tx_hash
        || submitted.provider_ref_seed?.submission_tx_hash
        || result.provider_ref_seed?.submission_tx_hash
        || null,
      submitted_order_fingerprint: fingerprint,
      submitted_order_fingerprint_commitment: fingerprint
        ? orderFingerprintCommitment(fingerprint)
        : null,
    },
    reconciliation: {
      ...reconciliation,
      target_client_order_only: true,
      submission_retry_count: 0,
    },
    final_proof: result.final_proof ? {
      ...result.final_proof,
      query_broadcast: false,
      broadcast_performed: reconciliation.reconcileOnly !== true
        && reconciliation.submissionResponseAmbiguous !== true
        && submitted.provider_ref_seed?.broadcast_acknowledged === true,
    } : null,
  };
}

export async function reconcileLighterExecution({
  credential,
  clientOrderIndex,
  market,
  expectedOrderFingerprint = null,
  expectedOrderIndex = null,
  submissionTxHash = null,
  runner = defaultRunner,
}) {
  assertLighterPilotMode(credential, "reconcile");
  const targetClientOrderIndex = integer(clientOrderIndex, "lighter reconcile target is invalid");
  const normalizedMarket = lighterMarket(market);
  const fingerprint = normalizeSubmittedOrderFingerprint(expectedOrderFingerprint);
  const fingerprintCommitment = fingerprint ? orderFingerprintCommitment(fingerprint) : null;
  const lineageOrderIndex = unsignedDecimalIntegerText(expectedOrderIndex);
  const result = await runner({
    action: "reconcile",
    credential,
    client_order_index: targetClientOrderIndex,
    market: normalizedMarket,
    expected_order_fingerprint: fingerprint,
    expected_order_index: lineageOrderIndex,
    timeout_ms: timeoutMs(),
  });
  const candidate = result?.target_market_checked === true ? result?.order || null : null;
  const returnedClientOrderIndex = Number(candidate?.client_order_index);
  const resultAccountIndex = nonnegativeIntegerOrNull(result?.account_index);
  const resultMarketId = nonnegativeIntegerOrNull(result?.market_id);
  const localFingerprintMatched = candidate !== null
    && fingerprint !== null
    && resultAccountIndex === credential.account_index
    && resultMarketId !== null
    && nonnegativeIntegerOrNull(candidate?.market_index ?? candidate?.market_id) === resultMarketId
    && submittedOrderMatchesCandidate(candidate, fingerprint, {
      expectedAccountIndex: credential.account_index,
      expectedOrderIndex: lineageOrderIndex,
    });
  const fingerprintMatched = result?.target_fingerprint_checked === true
    && result?.target_fingerprint_matched === true
    && result?.target_identifier_collision === false
    && localFingerprintMatched;
  const targetMatched = fingerprintMatched &&
    Number.isSafeInteger(returnedClientOrderIndex) &&
    returnedClientOrderIndex === targetClientOrderIndex;
  const order = targetMatched ? candidate : null;
  const exactOriginalOrderObserved = targetMatched
    && unsignedDecimalIntegerText(order?.order_index) !== null;
  const status = orderStatus(order);
  const filledBase = canonicalDecimal(order?.filled_base_amount);
  const filledQuote = canonicalDecimal(order?.filled_quote_amount);
  const fillAmountValid = filledBase !== null;
  const hasFill = fillAmountValid && filledBase !== "0";
  const feeProof = order
    ? normalizedLighterFeeProof(result?.fee_proof, {
      credential,
      order,
      targetClientOrderIndex,
    })
    : { complete: false, reason: "target_order_unavailable" };
  const terminal = status === "filled" || status === "cancelled";
  const zeroFillFeeExact = exactOriginalOrderObserved
    && terminal
    && status !== "filled"
    && filledBase === "0"
    && filledQuote === "0"
    && feeProof.complete === true
    && feeProof.trade_count === 0;
  const feeExact = zeroFillFeeExact || (hasFill && feeProof.complete === true);
  const targetFillSetComplete = exactOriginalOrderObserved
    && terminal
    && feeProof.complete === true
    && (hasFill || zeroFillFeeExact);
  const terminalEvidenceComplete = terminal
    && fillAmountValid
    && (status !== "filled" || hasFill)
    && feeExact
    && targetFillSetComplete;
  return {
    status,
    provider_ref_seed: {
      venue: "lighter",
      client_order_index: targetClientOrderIndex,
      order_index: order?.order_index ?? null,
      venue_status: order?.status || null,
      submission_tx_hash: String(submissionTxHash || "") || null,
      submitted_order_fingerprint: fingerprint,
      submitted_order_fingerprint_commitment: fingerprintCommitment,
    },
    result_seed: {
      kind: "lighter_exact_reconcile",
      status,
      fee_exact: feeExact,
      fee_evidence_commitment: feeProof.evidence_commitment || null,
    },
    fills: order && hasFill
      ? feeProof.complete === true
        ? feeProof.fills
        : [{
          size: String(order.filled_base_amount),
          quote_size: String(order.filled_quote_amount || "0"),
          price: averagePrice(order),
          fee: null,
          fee_asset: null,
          executed_at_ms: null,
        }]
      : [],
    final_proof: {
      version: 1,
      proof_kind: "lighter_client_order_index_reconciliation_v1",
      status,
      venue_id: "lighter",
      target_client_order_matched: targetMatched,
      submitted_order_fingerprint_matched: fingerprintMatched,
      submitted_order_fingerprint_commitment: fingerprintCommitment,
      target_identifier_collision: result?.target_identifier_collision === false ? false : true,
      venue_order_lineage_matched: exactOriginalOrderObserved,
      query_broadcast: false,
      broadcast_performed: false,
      original_order_target_matched: exactOriginalOrderObserved,
      original_order_broadcast_proven: exactOriginalOrderObserved,
      final_venue_execution_proven: terminalEvidenceComplete,
      final_fill_proven: status === "filled" && hasFill && feeProof.complete === true,
      target_fill_set_complete: targetFillSetComplete,
      filled_base_size: order?.filled_base_amount || "0",
      average_fill_price: order ? averagePrice(order) : "0",
      fee_exact: feeExact,
      fee_quote_amount: zeroFillFeeExact ? "0" : feeProof.complete === true ? feeProof.fee_quote_amount : null,
      fee_asset: feeExact ? "USDC" : null,
      fee_evidence_kind: zeroFillFeeExact ? "lighter_terminal_zero_fill_v1" : feeProof.proof_kind || null,
      fee_evidence_commitment: feeProof.evidence_commitment || null,
      fee_evidence_trade_count: feeProof.trade_count ?? null,
      fee_evidence_pagination_complete: feeProof.pagination_complete === true,
      fee_evidence_incomplete_reason: feeExact ? null : feeProof.reason || null,
      first_fill_at_ms: feeProof.complete === true ? feeProof.first_fill_at_ms : null,
      last_fill_at_ms: feeProof.complete === true ? feeProof.last_fill_at_ms : null,
      fill_times_authoritative: hasFill && feeProof.complete === true && feeProof.fill_times_authoritative === true,
      fill_time_provenance: hasFill && feeProof.complete === true ? feeProof.fill_time_provenance : null,
      open_order_count: status === "open" || status === "partially_filled"
        ? 1
        : terminal
          ? 0
          : null,
      checked_at: new Date().toISOString(),
    },
  };
}

function normalizedLighterFeeProof(raw, { credential, order, targetClientOrderIndex }) {
  if (raw === undefined || raw === null) {
    return { complete: false, pagination_complete: false, reason: "missing_authenticated_trade_evidence" };
  }
  const invalid = () => {
    throw new LighterExecutionError("lighter authenticated trade fee proof is invalid", 502, "connector_submit_failed");
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || raw.version !== 1
    || raw.proof_kind !== "lighter_authenticated_order_trades_fee_v1"
    || raw.transaction_broadcast !== false
    || raw.pagination_complete !== true) invalid();
  const accountIndex = nonnegativeIntegerOrNull(raw.account_index);
  const marketId = nonnegativeIntegerOrNull(raw.market_id);
  const orderIndex = unsignedDecimalIntegerText(raw.order_index);
  const proofClientOrderIndex = nonnegativeIntegerOrNull(raw.client_order_index);
  const expectedMarketId = nonnegativeIntegerOrNull(order?.market_index ?? order?.market_id);
  const expectedOrderIndex = unsignedDecimalIntegerText(order?.order_index);
  if (accountIndex !== credential.account_index
    || marketId === null
    || marketId !== expectedMarketId
    || orderIndex === null
    || orderIndex !== expectedOrderIndex
    || proofClientOrderIndex !== targetClientOrderIndex) invalid();
  if (raw.complete === false) {
    if (!new Set(["no_order_trades", "trade_totals_incomplete"]).has(raw.reason)
      || raw.fee_quote_amount !== undefined
      || raw.evidence_commitment !== undefined) invalid();
    return {
      complete: false,
      pagination_complete: true,
      proof_kind: raw.proof_kind,
      reason: raw.reason,
    };
  }
  if (raw.complete !== true
    || raw.fee_rate_tick_denominator !== 1_000_000
    || raw.quote_atomic_denominator !== 1_000_000
    || raw.fee_asset !== "USDC"
    || !/^sha256:[0-9a-f]{64}$/.test(String(raw.evidence_commitment || ""))) invalid();
  const tradeCount = nonnegativeIntegerOrNull(raw.trade_count);
  const firstTradeId = unsignedDecimalIntegerText(raw.first_trade_id);
  const lastTradeId = unsignedDecimalIntegerText(raw.last_trade_id);
  const proofBase = canonicalDecimal(raw.filled_base_amount);
  const proofQuote = canonicalDecimal(raw.filled_quote_amount);
  const orderBase = canonicalDecimal(order?.filled_base_amount);
  const orderQuote = canonicalDecimal(order?.filled_quote_amount);
  const fee = canonicalDecimal(raw.fee_quote_amount, { signed: true });
  const firstFillAtMs = positiveSafeIntegerOrNull(raw.first_fill_at_ms);
  const lastFillAtMs = positiveSafeIntegerOrNull(raw.last_fill_at_ms);
  const authenticatedFills = Array.isArray(raw.authenticated_fills)
    ? raw.authenticated_fills.map((fill) => {
      if (!fill || typeof fill !== "object" || Array.isArray(fill)) invalid();
      const size = canonicalDecimal(fill.size, { positive: true });
      const quoteSize = canonicalDecimal(fill.quote_size, { positive: true });
      const price = canonicalDecimal(fill.price, { positive: true });
      const fillFee = canonicalDecimal(fill.fee, { signed: true });
      const executedAtMs = positiveSafeIntegerOrNull(fill.executed_at_ms);
      if (size === null || quoteSize === null || price === null || fillFee === null
        || fill.fee_asset !== "USDC" || executedAtMs === null) invalid();
      return {
        size,
        quote_size: quoteSize,
        price,
        fee: fillFee,
        fee_asset: "USDC",
        executed_at_ms: executedAtMs,
      };
    })
    : null;
  const zeroFillProof = tradeCount === 0
    && proofBase === "0" && proofQuote === "0"
    && orderBase === "0" && orderQuote === "0"
    && fee === "0"
    && firstTradeId === null && lastTradeId === null
    && firstFillAtMs === null && lastFillAtMs === null
    && raw.fill_times_authoritative === false
    && raw.fill_time_provenance === null
    && Array.isArray(authenticatedFills) && authenticatedFills.length === 0;
  const positiveFillProof = tradeCount !== null && tradeCount >= 1 && tradeCount <= 800
    && firstTradeId !== null && lastTradeId !== null
    && proofBase !== null && proofBase !== "0" && proofBase === orderBase
    && proofQuote !== null && proofQuote !== "0" && proofQuote === orderQuote
    && fee !== null
    && firstFillAtMs !== null && lastFillAtMs !== null && lastFillAtMs >= firstFillAtMs
    && raw.fill_times_authoritative === true
    && raw.fill_time_provenance === "lighter_authenticated_order_trades_timestamp_v1"
    && Array.isArray(authenticatedFills) && authenticatedFills.length === tradeCount
    && sumCanonicalDecimals(authenticatedFills.map((fill) => fill.size)) === proofBase
    && sumCanonicalDecimals(authenticatedFills.map((fill) => fill.quote_size)) === proofQuote
    && sumCanonicalDecimals(authenticatedFills.map((fill) => fill.fee), { signed: true }) === fee
    && Math.min(...authenticatedFills.map((fill) => fill.executed_at_ms)) === firstFillAtMs
    && Math.max(...authenticatedFills.map((fill) => fill.executed_at_ms)) === lastFillAtMs;
  if (!zeroFillProof && !positiveFillProof) invalid();
  return {
    complete: true,
    pagination_complete: true,
    proof_kind: raw.proof_kind,
    fee_quote_amount: fee,
    fee_asset: "USDC",
    trade_count: tradeCount,
    evidence_commitment: raw.evidence_commitment,
    first_fill_at_ms: firstFillAtMs,
    last_fill_at_ms: lastFillAtMs,
    fill_times_authoritative: true,
    fill_time_provenance: raw.fill_time_provenance,
    fills: authenticatedFills,
  };
}

export async function readLighterFundingSettlements({
  credential,
  market,
  start_time_ms: startTimeMs,
  end_time_ms: endTimeMs = Date.now(),
  runner = defaultRunner,
}) {
  assertLighterPilotMode(credential, "read");
  const start = integer(startTimeMs, "lighter funding start is invalid");
  const end = integer(endTimeMs, "lighter funding end is invalid");
  if (start <= 0 || end < start || end - start > 366 * 86_400_000) throw new LighterExecutionError("lighter funding window is invalid", 400, "venue_rejected");
  const result = await runner({ action: "funding", credential, market: lighterMarket(market), start_time_ms: start, end_time_ms: end, timeout_ms: fundingTimeoutMs() });
  const expectedMarket = lighterMarket(market);
  const returnedAccountIndex = nonnegativeIntegerOrNull(result?.account_index);
  const returnedMarketId = nonnegativeIntegerOrNull(result?.market_id);
  if (!Array.isArray(result?.funding_rows)
    || returnedAccountIndex !== credential.account_index
    || returnedMarketId === null
    || String(result?.symbol || "").toUpperCase() !== expectedMarket) {
    throw new LighterExecutionError("lighter funding history response is invalid", 502, "connector_submit_failed");
  }
  const rows = result.funding_rows;
  return rows.map((row) => {
    const rawTime = Number(row.timestamp ?? row.time ?? row.funding_timestamp);
    const occurredAt = rawTime > 0 && rawTime < 10_000_000_000 ? rawTime * 1_000 : rawTime;
    const amount = row.change ?? row.funding_payment ?? row.payment ?? row.amount;
    const settlement = {
      venue_id: "lighter",
      asset: String(result?.symbol || market || "").toUpperCase(),
      occurred_at_ms: occurredAt,
      amount_quote: String(amount ?? ""),
      quote_asset: String(row.quote_asset || row.asset || "USDC").toUpperCase(),
      settlement_id: String(row.funding_id ?? row.id ?? row.tx_hash ?? `${occurredAt}:${amount}`),
    };
    if (!row || typeof row !== "object" || Array.isArray(row)
      || row.type !== "funding"
      || nonnegativeIntegerOrNull(row.market_id ?? row.market_index) !== returnedMarketId
      || !Number.isSafeInteger(settlement.occurred_at_ms)
      || settlement.occurred_at_ms < start
      || settlement.occurred_at_ms > end
      || !/^-?\d+(?:\.\d+)?$/.test(settlement.amount_quote)
      || !new Set(["USD", "USDC", "USDT"]).has(settlement.quote_asset)
      || settlement.settlement_id.length === 0) {
      throw new LighterExecutionError("lighter funding history row is invalid", 502, "connector_submit_failed");
    }
    return settlement;
  });
}

function normalizeOrder(instruction, clientOrderIndex) {
  if (instruction?.operation_class !== "limit_order") {
    throw new LighterExecutionError("lighter supports limit_order only", 422, "venue_rejected");
  }
  const order = instruction.order || {};
  if (!/^[A-Z0-9._-]{1,16}$/.test(String(order.market || "").toUpperCase())) {
    throw new LighterExecutionError("lighter market is invalid", 422, "venue_rejected");
  }
  if (order.side !== "buy" && order.side !== "sell") throw new LighterExecutionError("lighter side is invalid", 422, "venue_rejected");
  const baseSize = positiveDecimal(order.base_size, "lighter base size is invalid");
  const limitPrice = positiveDecimal(order.limit_price, "lighter limit price is invalid");
  const tif = String(order.tif || "Ioc").toLowerCase();
  if (!new Set(["ioc", "gtc", "alo"]).has(tif)) throw new LighterExecutionError("lighter time in force is invalid", 422, "venue_rejected");
  return {
    market: String(order.market).toUpperCase(),
    side: order.side,
    base_size: baseSize,
    limit_price: limitPrice,
    tif,
    reduce_only: order.reduce_only === true,
    client_order_index: integer(clientOrderIndex, "lighter client order index is invalid"),
  };
}

function normalizeSubmittedOrderFingerprint(value) {
  if (value === undefined || value === null) return null;
  const invalid = () => {
    throw new LighterExecutionError(
      "lighter submitted order fingerprint is invalid",
      503,
      "submission_ambiguous",
    );
  };
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.version !== LIGHTER_ORDER_FINGERPRINT_VERSION) invalid();
  const market = String(value.market || "").toUpperCase();
  const clientOrderIndex = nonnegativeIntegerOrNull(value.client_order_index);
  const side = String(value.side || "").toLowerCase();
  const baseSize = canonicalDecimal(value.base_size, { positive: true });
  const limitPrice = canonicalDecimal(value.limit_price, { positive: true });
  const timeInForce = String(value.time_in_force || "").toLowerCase();
  const submittedAtMs = positiveSafeIntegerOrNull(value.submitted_at_ms);
  if (!/^[A-Z0-9._-]{1,16}$/.test(market)
    || clientOrderIndex === null
    || (side !== "buy" && side !== "sell")
    || baseSize === null
    || limitPrice === null
    || typeof value.reduce_only !== "boolean"
    || !Object.hasOwn(LIGHTER_TIME_IN_FORCE, timeInForce)
    || submittedAtMs === null) invalid();
  return Object.freeze({
    version: LIGHTER_ORDER_FINGERPRINT_VERSION,
    market,
    client_order_index: clientOrderIndex,
    side,
    base_size: baseSize,
    limit_price: limitPrice,
    reduce_only: value.reduce_only,
    time_in_force: timeInForce,
    submitted_at_ms: submittedAtMs,
  });
}

function assertFingerprintMatchesRequestedOrder(fingerprint, order) {
  if (!fingerprint
    || fingerprint.market !== order.market
    || fingerprint.client_order_index !== order.client_order_index
    || fingerprint.side !== order.side
    || fingerprint.base_size !== canonicalDecimal(order.base_size, { positive: true })
    || fingerprint.limit_price !== canonicalDecimal(order.limit_price, { positive: true })
    || fingerprint.reduce_only !== order.reduce_only
    || fingerprint.time_in_force !== order.tif) {
    throw new LighterExecutionError(
      "lighter submitted order fingerprint does not match the requested order",
      503,
      "submission_ambiguous",
    );
  }
}

function submittedOrderMatchesCandidate(candidate, fingerprint, {
  expectedAccountIndex,
  expectedOrderIndex,
}) {
  const candidateTimestampMs = venueTimestampMs(
    candidate?.created_at ?? candidate?.timestamp ?? candidate?.transaction_time,
  );
  const candidateOrderIndex = unsignedDecimalIntegerText(candidate?.order_index);
  return nonnegativeIntegerOrNull(candidate?.owner_account_index) === expectedAccountIndex
    && nonnegativeIntegerOrNull(candidate?.client_order_index) === fingerprint.client_order_index
    && canonicalDecimal(candidate?.initial_base_amount, { positive: true }) === fingerprint.base_size
    && canonicalDecimal(candidate?.price, { positive: true }) === fingerprint.limit_price
    && candidate?.is_ask === (fingerprint.side === "sell")
    && String(candidate?.side || "").toLowerCase() === fingerprint.side
    && candidate?.type === "limit"
    && candidate?.time_in_force === LIGHTER_TIME_IN_FORCE[fingerprint.time_in_force]
    && candidate?.reduce_only === fingerprint.reduce_only
    && candidateTimestampMs !== null
    && Math.abs(candidateTimestampMs - fingerprint.submitted_at_ms) <= LIGHTER_ORDER_TIME_SKEW_MS
    && candidateOrderIndex !== null
    && (expectedOrderIndex === null || candidateOrderIndex === expectedOrderIndex);
}

function orderFingerprintCommitment(fingerprint) {
  return `sha256:${createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex")}`;
}

function lighterMarket(value) {
  const market = String(value || "").toUpperCase();
  if (!/^[A-Z0-9._-]{1,16}$/.test(market)) throw new LighterExecutionError("lighter market is invalid", 422, "venue_rejected");
  return market;
}

function normalizedVerification(result, order, expectedAccountIndex) {
  const account = sanitizeAccount({
    ...result.account,
    target_active_orders: result.target_active_orders,
    target_active_orders_pagination_complete: result.target_active_orders_pagination_complete,
  }, result.market, { expectedAccountIndex });
  return {
    status: account.can_trade && account.available_balance > 0 ? "verified_ready" : "verified_no_funds",
    checks: {
      sdk_checked: true,
      signer_matches_key: true,
      market_data_checked: true,
      account_state_checked: true,
      margin_state_checked: account.margin_state_verified,
      order_request_checked: true,
      transaction_broadcast: false,
    },
    account,
    order_shape: {
      market: order.market,
      side: order.side,
      base_size: result.order_shape?.base_size || order.base_size,
      limit_price: result.order_shape?.limit_price || order.limit_price,
      reduce_only: order.reduce_only === true,
      notional_micro_usdc: Math.round(Number(result.order_shape?.base_size || order.base_size) * Number(result.order_shape?.limit_price || order.limit_price) * 1_000_000),
      quantity_step_e8: result.order_shape?.quantity_step_e8,
      price_tick_e8: result.order_shape?.price_tick_e8,
      client_order_index: order.client_order_index,
    },
    authority_boundary: {
      owner_only: OWNER_ONLY,
      venue_native_trade_only: false,
      enforced_by: "attested_worker_policy",
      withdrawal_request_permitted: false,
      secure_withdrawal_destination: "owner_l1_only",
      owner_wallet_key_present: false,
      non_owner_fund_movement_possible: false,
    },
  };
}

function normalizedSubmit(result, clientOrderIndex, fallbackStatus, submittedOrderFingerprint = null) {
  if (result?.accepted !== true) throw new LighterExecutionError("lighter rejected the transaction", 422, "venue_rejected");
  const fingerprint = normalizeSubmittedOrderFingerprint(submittedOrderFingerprint);
  return {
    status: result.status || fallbackStatus,
    provider_ref_seed: {
      venue: "lighter",
      client_order_index: Number(clientOrderIndex),
      tx_hash: result.tx_hash || null,
      broadcast_acknowledged: true,
      submitted_order_fingerprint: fingerprint,
      submitted_order_fingerprint_commitment: fingerprint
        ? orderFingerprintCommitment(fingerprint)
        : null,
    },
    result_seed: { kind: "lighter_sdk_result", status: result.status || fallbackStatus },
    fills: [],
    final_proof: null,
  };
}

function ambiguousLighterWrite(error) {
  if (error instanceof LighterExecutionError && ["venue_rejected", "venue_access_required"].includes(error.code)) {
    return error;
  }
  return new LighterExecutionError(
    "lighter submission outcome is ambiguous; reconcile exact client order index",
    error?.status || 502,
    "submission_ambiguous",
  );
}

function sanitizeAccount(account = {}, market = {}, {
  expectedAccountIndex = null,
} = {}) {
  if (!account || typeof account !== "object" || Array.isArray(account)) {
    throw new LighterExecutionError("lighter account state response is invalid", 502, "connector_submit_failed");
  }
  const code = account.code;
  const accountStatus = account.status;
  const accountIndex = account.account_index;
  const index = account.index;
  const availableBalance = strictDecimal(account.available_balance);
  const marginBalance = strictDecimal(account.total_asset_value ?? account.collateral);
  const initialMarginProvided = account.cross_initial_margin_requirement !== undefined
    && account.cross_initial_margin_requirement !== null;
  const maintenanceMarginProvided = account.cross_maintenance_margin_requirement !== undefined
    && account.cross_maintenance_margin_requirement !== null;
  const initialMargin = initialMarginProvided ? strictDecimal(account.cross_initial_margin_requirement) : null;
  const maintenanceMargin = maintenanceMarginProvided ? strictDecimal(account.cross_maintenance_margin_requirement) : null;
  const liquidation = lighterLiquidationDistance(account);
  const openOrderCount = typeof account.pending_order_count === "number"
    ? nonnegativeIntegerOrNull(account.pending_order_count)
    : null;
  const makerFeeBps = rateBps(market.maker_fee);
  const takerFeeBps = rateBps(market.taker_fee);
  const positionInventory = sanitizeLighterPositions(account.positions);
  const targetOrderInventory = sanitizeLighterTargetOrders(account.target_active_orders, market);
  if (code !== 0
    || !Number.isSafeInteger(accountStatus)
    || ![LIGHTER_ACCOUNT_STATUS_INACTIVE, LIGHTER_ACCOUNT_STATUS_ACTIVE].includes(accountStatus)
    || !Number.isSafeInteger(accountIndex)
    || accountIndex < 0
    || !Number.isSafeInteger(index)
    || index !== accountIndex
    || (expectedAccountIndex !== null && accountIndex !== expectedAccountIndex)
    || availableBalance === null
    || availableBalance < 0
    || marginBalance === null
    || marginBalance < 0
    || availableBalance > marginBalance
    || (initialMarginProvided && (initialMargin === null || initialMargin < 0))
    || (maintenanceMarginProvided && (maintenanceMargin === null || maintenanceMargin < 0))
    || openOrderCount === null
    || !Number.isSafeInteger(liquidation.position_count)
    || liquidation.position_count < 0) {
    throw new LighterExecutionError("lighter account state response is invalid", 502, "connector_submit_failed");
  }
  return {
    can_trade: accountStatus === LIGHTER_ACCOUNT_STATUS_ACTIVE,
    account_status: accountStatus,
    account_status_verified: true,
    account_index: accountIndex,
    available_balance: availableBalance,
    margin_balance: marginBalance,
    initial_margin: initialMargin,
    maintenance_margin: maintenanceMargin,
    margin_state_verified: initialMargin !== null && maintenanceMargin !== null,
    position_count: liquidation.position_count,
    liquidation_distance_bps: liquidation.liquidation_distance_bps,
    liquidation_distance_verified: liquidation.liquidation_distance_verified,
    liquidation_distance_source: liquidation.liquidation_distance_source,
    open_order_count: openOrderCount,
    positions: positionInventory.rows,
    target_open_orders: targetOrderInventory.rows,
    position_inventory_verified: account.inventory_pagination_complete === true
      && positionInventory.verified
      && positionInventory.rows.length === liquidation.position_count,
    position_inventory_pagination_complete: account.inventory_pagination_complete === true,
    position_inventory_has_more: account.inventory_pagination_complete !== true,
    open_order_inventory_verified: (targetOrderInventory.verified
      && account.target_active_orders_pagination_complete === true)
      || (openOrderCount === 0 && account.target_active_orders === undefined),
    open_order_inventory_pagination_complete: account.target_active_orders_pagination_complete === true
      || (openOrderCount === 0 && account.target_active_orders === undefined),
    open_order_inventory_has_more: account.target_active_orders_pagination_complete !== true
      && !(openOrderCount === 0 && account.target_active_orders === undefined),
    flat_zero_orders: liquidation.position_count === 0 && openOrderCount === 0,
    maker_fee_bps: makerFeeBps,
    taker_fee_bps: takerFeeBps,
    fee_source: "market_schedule_conservative_upper_bound",
    fees_exact_for_account: false,
    fees_conservative_upper_bound: Number.isFinite(makerFeeBps) && Number.isFinite(takerFeeBps),
  };
}

function sanitizeLighterPositions(positions) {
  if (!Array.isArray(positions)) return { verified: false, rows: [] };
  const active = positions.filter((row) => strictDecimal(row?.position) !== 0);
  const rows = active.map((row) => {
    const signed = canonicalDecimal(row?.position, { signed: true });
    const sign = Number(row?.sign);
    const market = String(row?.symbol || row?.market || "").toUpperCase();
    const negative = signed?.startsWith("-") || sign < 0;
    const baseSize = signed?.replace(/^-/, "") || null;
    if (!baseSize || !/^[A-Z0-9._-]{1,16}$/.test(market)
      || ![-1, 1].includes(sign) || (negative ? sign !== -1 : sign !== 1)) return null;
    return { market, side: negative ? "short" : "long", base_size: baseSize };
  });
  return { verified: rows.every(Boolean), rows: rows.filter(Boolean) };
}

function sanitizeLighterTargetOrders(orders, market) {
  if (!Array.isArray(orders)) return { verified: false, rows: [] };
  const targetMarket = String(market?.symbol || "").toUpperCase();
  const rows = orders.map((row) => {
    const baseSize = canonicalDecimal(row?.remaining_base_amount ?? row?.initial_base_amount, { positive: true });
    const side = typeof row?.is_ask === "boolean"
      ? row.is_ask ? "sell" : "buy"
      : String(row?.side || "").toLowerCase();
    const identitySeed = row?.order_index ?? row?.client_order_index;
    if (!/^[A-Z0-9._-]{1,16}$/.test(targetMarket)
      || !["buy", "sell"].includes(side)
      || !baseSize || identitySeed === undefined || identitySeed === null) return null;
    return {
      market: targetMarket,
      side,
      base_size: baseSize,
      reduce_only: row?.reduce_only === true,
      order_handle_commitment: `lighter:order:${createHash("sha256")
        .update(JSON.stringify({ order_index: row?.order_index ?? null, client_order_index: row?.client_order_index ?? null }))
        .digest("hex").slice(0, 40)}`,
      client_order_identity_commitment: carryInventoryClientOrderIdentityCommitment({
        venue_id: "lighter",
        client_order_id: row?.client_order_index,
      }),
      provider_order_identity_commitment: carryInventoryProviderOrderIdentityCommitment({
        venue_id: "lighter",
        provider_order_id: row?.order_index,
      }),
    };
  });
  return { verified: rows.every(Boolean), rows: rows.filter(Boolean) };
}

function orderStatus(order) {
  if (!order) return "outcome_unknown";
  const value = String(order.status || "").toLowerCase();
  if (value === "filled") return "filled";
  if (LIGHTER_CANCELED_ORDER_STATUSES.has(value)) return "cancelled";
  if (value === "in-progress" || value === "pending" || value === "open") return "open";
  return "outcome_unknown";
}

function averagePrice(order) {
  const base = Number(order?.filled_base_amount || 0);
  const quote = Number(order?.filled_quote_amount || 0);
  return base > 0 && quote > 0 ? String(quote / base) : String(order?.price || "0");
}

function defaultRunner(payload) {
  const runnerPath = join(dirname(fileURLToPath(import.meta.url)), "lighter_runner.py");
  const python = process.env.PRIVATE_AGENT_PYTHON || "python3";
  return new Promise((resolve, reject) => {
    const child = spawn(python, [runnerPath], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTHONUNBUFFERED: "1" } });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new LighterExecutionError("lighter runner timed out", 504, "connector_submit_failed"));
    }, payload.timeout_ms || timeoutMs());
    const stdout = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.on("error", () => {
      clearTimeout(timeout);
      reject(new LighterExecutionError("lighter runner unavailable", 502, "connector_submit_failed"));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      let result;
      try { result = JSON.parse(Buffer.concat(stdout).toString("utf8") || "{}"); } catch { result = null; }
      if (code !== 0 || !result) reject(new LighterExecutionError(result?.error || "lighter runner failed", 502, result?.error_code || "connector_submit_failed"));
      else resolve(result);
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function timeoutMs() {
  return Number.parseInt(process.env.PRIVATE_AGENT_LIGHTER_TIMEOUT_MS || "12000", 10);
}

function fundingTimeoutMs() {
  const parsed = Number.parseInt(process.env.PRIVATE_AGENT_LIGHTER_FUNDING_TIMEOUT_MS || "30000", 10);
  return Number.isInteger(parsed) && parsed >= 12_000 && parsed <= 60_000 ? parsed : 30_000;
}

function boundedMs(value, minimum, maximum, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function integer(value, message) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new LighterExecutionError(message, 422, "venue_rejected");
  return number;
}

function decimalToMicro(value, rounding) {
  const text = String(value ?? "");
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) {
    throw new LighterExecutionError("lighter withdrawal amount is invalid", 422, "venue_rejected");
  }
  const [whole, fraction = ""] = text.split(".");
  const padded = `${fraction}000000`;
  let micro = BigInt(whole) * 1_000_000n + BigInt(padded.slice(0, 6));
  if (rounding === "ceiling" && fraction.length > 6 && /[1-9]/.test(fraction.slice(6))) micro += 1n;
  if (micro > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new LighterExecutionError("lighter withdrawal amount is invalid", 422, "venue_rejected");
  }
  return Number(micro);
}

function positiveDecimal(value, message) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new LighterExecutionError(message, 422, "venue_rejected");
  return String(value);
}

function strictDecimal(value) {
  const raw = String(value ?? "");
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) return null;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}

function canonicalDecimal(value, { signed = false, positive = false } = {}) {
  const raw = String(value ?? "").trim();
  if (raw.length === 0 || raw.length > 128) return null;
  const match = (signed ? /^(-?)(\d+)(?:\.(\d+))?$/ : /^(\d+)(?:\.(\d+))?$/).exec(raw);
  if (!match) return null;
  const negative = signed && match[1] === "-";
  const wholeIndex = signed ? 2 : 1;
  const fractionIndex = signed ? 3 : 2;
  const whole = match[wholeIndex].replace(/^0+(?=\d)/, "");
  const fraction = String(match[fractionIndex] || "").replace(/0+$/, "");
  const zero = whole === "0" && fraction.length === 0;
  if (positive && zero) return null;
  return `${negative && !zero ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

function sumCanonicalDecimals(values, { signed = false } = {}) {
  const parsed = values.map((value) => {
    const canonical = canonicalDecimal(value, { signed });
    if (canonical === null) return null;
    const negative = canonical.startsWith("-");
    const unsigned = negative ? canonical.slice(1) : canonical;
    const [whole, fraction = ""] = unsigned.split(".");
    return {
      coefficient: BigInt(`${negative ? "-" : ""}${whole}${fraction}`),
      scale: fraction.length,
    };
  });
  if (parsed.some((value) => value === null)) return null;
  const scale = Math.max(0, ...parsed.map((value) => value.scale));
  const total = parsed.reduce(
    (sum, value) => sum + value.coefficient * (10n ** BigInt(scale - value.scale)),
    0n,
  );
  const negative = total < 0n;
  const digits = (negative ? -total : total).toString().padStart(scale + 1, "0");
  const whole = scale === 0 ? digits : digits.slice(0, -scale);
  const fraction = scale === 0 ? "" : digits.slice(-scale).replace(/0+$/, "");
  return `${negative && total !== 0n ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

function venueTimestampMs(value) {
  const raw = positiveSafeIntegerOrNull(value);
  if (raw === null) return null;
  const milliseconds = raw < 10_000_000_000 ? raw * 1_000 : raw;
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

function nonnegativeIntegerOrNull(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value.trim()))) {
    return null;
  }
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function positiveSafeIntegerOrNull(value) {
  const number = nonnegativeIntegerOrNull(value);
  return number !== null && number > 0 ? number : null;
}

function unsignedDecimalIntegerText(value) {
  const text = typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === "string"
      ? value.trim()
      : "";
  return /^(?:0|[1-9]\d*)$/.test(text) && text.length <= 64 ? text : null;
}

function rateBps(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number * 10_000 : null;
}
