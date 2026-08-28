import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { didKeyFromVerifying, openSealedBundle } from "../crypto/envelope.js";
import { fundingSigningIdentity } from "./shielded_funding_attestation.js";

const ALLOWED = new Set(["read", "limit_order", "cancel", "reconcile"]);
const OWNER_ONLY = ["withdraw", "transfer", "leverage", "margin", "account_config", "api_key_rotation"];
const SAFE_COMMITMENT = /^[A-Za-z0-9_.:-]{8,240}$/;
const UINT48_MAX = 281_474_976_710_655;
const GOLDILOCKS_MODULUS = 0xffffffff00000001n;

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

export async function verifyLighterCredential({ credential, runner = defaultRunner }) {
  assertLighterPilotMode(credential, "read");
  const result = await runner({ action: "credential", credential, timeout_ms: timeoutMs() });
  if (result?.credential_verified !== true || result?.account_read !== true || result?.transaction_broadcast !== false) {
    throw new LighterExecutionError("lighter credential verification failed", 502, "venue_access_required");
  }
  return {
    can_read: true,
    can_trade: true,
    can_withdraw: false,
    secure_withdrawal_to_owner_possible: true,
    non_owner_fund_movement_possible: false,
    venue_native_trade_only: false,
    account: sanitizeAccount(result.account),
  };
}

export async function readLighterWithdrawalRouteQuote({
  credential,
  account_state_commitment: accountStateCommitment,
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
    || decimal(result?.normal_withdrawal_fee_usdc) !== 0) {
    throw new LighterExecutionError("lighter withdrawal route verification failed", 502, "venue_access_required");
  }
  const minimum = decimalToMicro(result.minimum_withdrawal_usdc, "ceiling");
  const maximum = decimalToMicro(result.maximum_withdrawal_usdc, "floor");
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
  });
}

export async function verifyLighterNoSubmit({ credential, instruction, clientOrderIndex, runner = defaultRunner }) {
  assertLighterPilotMode(credential, "read");
  const order = normalizeOrder(instruction, clientOrderIndex);
  const result = await runner({ action: "verify", credential, order, timeout_ms: timeoutMs() });
  if (result?.credential_verified !== true || result?.order_packet_built !== true || result?.transaction_broadcast !== false) {
    throw new LighterExecutionError("lighter no-submit verification failed", 502, "connector_submit_failed");
  }
  return normalizedVerification(result, order);
}

export async function submitLighterExecution({ credential, instruction, clientOrderIndex, runner = defaultRunner }) {
  const operationClass = instruction?.operation_class;
  assertLighterPilotMode(credential, operationClass);
  if (operationClass === "reconcile") {
    const target = instruction.reconcile?.target_client_order_index;
    return reconcileLighterExecution({
      credential,
      clientOrderIndex: integer(target, "lighter reconcile target is invalid"),
      market: instruction.reconcile?.target_market || instruction.reconcile?.market || instruction.reconcile?.product_id,
      runner,
    });
  }
  if (operationClass === "cancel") {
    const cancel = instruction.cancel || {};
    const result = await runner({
      action: "cancel",
      credential,
      market: String(cancel.market || "").toUpperCase(),
      client_order_index: integer(cancel.client_order_index, "lighter cancel target is invalid"),
      timeout_ms: timeoutMs(),
    });
    return normalizedSubmit(result, cancel.client_order_index, "cancelled");
  }
  const order = normalizeOrder(instruction, clientOrderIndex);
  let result;
  try {
    result = await runner({ action: "submit", credential, order, timeout_ms: timeoutMs() });
  } catch (error) {
    throw new LighterExecutionError(
      "lighter submission outcome is ambiguous; reconcile exact client order index",
      error?.status || 502,
      "submission_ambiguous",
    );
  }
  return normalizedSubmit(result, clientOrderIndex, "submitted");
}

export async function submitAndReconcileLighterExecution({
  credential,
  instruction,
  clientOrderIndex,
  runner = defaultRunner,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  env = process.env,
}) {
  const reconcileOnly = instruction?.operation_class === "reconcile";
  const reconciliationClientOrderIndex = reconcileOnly
    ? integer(instruction?.reconcile?.target_client_order_index, "lighter reconcile target is invalid")
    : integer(clientOrderIndex, "lighter client order index is invalid");
  const reconciliationMarket = reconcileOnly
    ? instruction?.reconcile?.target_market || instruction?.reconcile?.market || instruction?.reconcile?.product_id
    : instruction?.order?.market;
  let submitted = reconcileOnly ? {
    status: "outcome_unknown",
    provider_ref_seed: { venue: "lighter", client_order_index: reconciliationClientOrderIndex, tx_hash: null },
    result_seed: { kind: "lighter_reconcile_started" },
    fills: [],
    final_proof: null,
  } : null;
  let submissionResponseAmbiguous = false;
  if (!reconcileOnly) {
    try {
      submitted = await submitLighterExecution({ credential, instruction, clientOrderIndex, runner });
    } catch (error) {
      if (error?.code !== "submission_ambiguous") throw error;
      submissionResponseAmbiguous = true;
      submitted = {
        status: "outcome_unknown",
        provider_ref_seed: { venue: "lighter", client_order_index: reconciliationClientOrderIndex, tx_hash: null },
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
        runner,
      });
      if (reconciled.final_proof?.target_client_order_matched === true) {
        exactOrderObserved = true;
        last = reconciled;
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
  return {
    ...result,
    provider_ref_seed: {
      ...result.provider_ref_seed,
      submission_tx_hash: submitted.provider_ref_seed?.tx_hash || null,
    },
    reconciliation: {
      ...reconciliation,
      target_client_order_only: true,
      submission_retry_count: 0,
    },
  };
}

export async function reconcileLighterExecution({ credential, clientOrderIndex, market, runner = defaultRunner }) {
  assertLighterPilotMode(credential, "reconcile");
  const targetClientOrderIndex = integer(clientOrderIndex, "lighter reconcile target is invalid");
  const result = await runner({
    action: "reconcile",
    credential,
    client_order_index: targetClientOrderIndex,
    market: lighterMarket(market),
    timeout_ms: timeoutMs(),
  });
  const candidate = result?.order || null;
  const returnedClientOrderIndex = Number(candidate?.client_order_index);
  const targetMatched = candidate !== null &&
    Number.isSafeInteger(returnedClientOrderIndex) &&
    returnedClientOrderIndex === targetClientOrderIndex;
  const order = targetMatched ? candidate : null;
  const status = orderStatus(order);
  return {
    status,
    provider_ref_seed: {
      venue: "lighter",
      client_order_index: targetClientOrderIndex,
      order_index: order?.order_index ?? null,
      venue_status: order?.status || null,
    },
    result_seed: { kind: "lighter_exact_reconcile", status },
    fills: order && Number(order.filled_base_amount || 0) > 0 ? [{
      size: String(order.filled_base_amount),
      quote_size: String(order.filled_quote_amount || "0"),
      price: averagePrice(order),
      fee: order.fee ?? order.total_fee ?? order.trading_fee ?? null,
      fee_asset: order.fee_asset ?? order.quote_asset ?? null,
    }] : [],
    final_proof: {
      version: 1,
      proof_kind: "lighter_client_order_index_reconciliation_v1",
      status,
      venue_id: "lighter",
      target_client_order_matched: targetMatched,
      broadcast_performed: order !== null,
      final_venue_execution_proven: ["filled", "cancelled", "rejected"].includes(status),
      final_fill_proven: status === "filled",
      filled_base_size: order?.filled_base_amount || "0",
      average_fill_price: order ? averagePrice(order) : "0",
      fee_quote_amount: order?.fee ?? order?.total_fee ?? order?.trading_fee ?? null,
      fee_asset: order?.fee_asset ?? order?.quote_asset ?? null,
      open_order_count: status === "open" ? 1 : 0,
      checked_at: new Date().toISOString(),
    },
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
  const rows = Array.isArray(result?.funding_rows) ? result.funding_rows : [];
  return rows.map((row) => {
    const rawTime = Number(row.timestamp ?? row.time ?? row.funding_timestamp);
    const occurredAt = rawTime > 0 && rawTime < 10_000_000_000 ? rawTime * 1_000 : rawTime;
    const amount = row.change ?? row.funding_payment ?? row.payment ?? row.amount;
    return {
      venue_id: "lighter",
      asset: String(result?.symbol || market || "").toUpperCase(),
      occurred_at_ms: occurredAt,
      amount_quote: String(amount ?? ""),
      quote_asset: String(row.quote_asset || row.asset || "USDC").toUpperCase(),
      settlement_id: String(row.funding_id ?? row.id ?? row.tx_hash ?? `${occurredAt}:${amount}`),
    };
  }).filter((row) => Number.isSafeInteger(row.occurred_at_ms) && /^-?\d+(?:\.\d+)?$/.test(row.amount_quote));
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

function lighterMarket(value) {
  const market = String(value || "").toUpperCase();
  if (!/^[A-Z0-9._-]{1,16}$/.test(market)) throw new LighterExecutionError("lighter market is invalid", 422, "venue_rejected");
  return market;
}

function normalizedVerification(result, order) {
  const account = sanitizeAccount(result.account, result.market);
  return {
    status: account.can_trade && account.available_balance > 0 ? "verified_ready" : "verified_no_funds",
    checks: {
      sdk_checked: true,
      signer_matches_key: true,
      market_data_checked: true,
      account_state_checked: true,
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

function normalizedSubmit(result, clientOrderIndex, fallbackStatus) {
  if (result?.accepted !== true) throw new LighterExecutionError("lighter rejected the transaction", 422, "venue_rejected");
  return {
    status: result.status || fallbackStatus,
    provider_ref_seed: {
      venue: "lighter",
      client_order_index: Number(clientOrderIndex),
      tx_hash: result.tx_hash || null,
    },
    result_seed: { kind: "lighter_sdk_result", status: result.status || fallbackStatus },
    fills: [],
    final_proof: null,
  };
}

function sanitizeAccount(account = {}, market = {}) {
  const positions = Array.isArray(account.positions) ? account.positions : [];
  const nonzero = positions.filter((item) => Number(item.position || 0) !== 0);
  const makerFeeBps = rateBps(market.maker_fee);
  const takerFeeBps = rateBps(market.taker_fee);
  return {
    can_trade: true,
    account_status: Number.isInteger(Number(account.status)) ? Number(account.status) : null,
    available_balance: decimal(account.available_balance),
    margin_balance: decimal(account.total_asset_value ?? account.collateral),
    initial_margin: decimal(account.cross_initial_margin_requirement),
    maintenance_margin: decimal(account.cross_maintenance_margin_requirement),
    position_count: nonzero.length,
    open_order_count: Number(account.pending_order_count || 0),
    maker_fee_bps: makerFeeBps,
    taker_fee_bps: takerFeeBps,
    fee_source: "market_schedule_conservative_upper_bound",
    fees_exact_for_account: false,
    fees_conservative_upper_bound: Number.isFinite(makerFeeBps) && Number.isFinite(takerFeeBps),
  };
}

function orderStatus(order) {
  if (!order) return "outcome_unknown";
  const value = String(order.status || "").toLowerCase();
  if (value === "filled") return "filled";
  if (value === "canceled" || value === "cancelled") return "cancelled";
  if (value === "rejected" || value === "expired") return "rejected";
  if (value === "new" || value === "open" || Number(order.remaining_base_amount || 0) > 0) return "open";
  return Number(order.filled_base_amount || 0) > 0 ? "partially_filled" : "outcome_unknown";
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

function decimal(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function rateBps(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number * 10_000 : null;
}
