import type { TradeOrderPlan, TradeOrderVenueId } from "./trade-order-plan";

export type SignedExecutionMaterialResult =
  | { ok: true; hyperliquid_asset_index?: number }
  | { ok: false; error: string };

export interface SignedExecutionMaterialOptions {
  hyperliquidAssetIndex: number | null;
}

const REQUEST_BASE_KEYS = [
  "csrfToken",
  "venueIds",
  "ensureWallet",
  "executionCredentialHandleCommitmentsByVenue",
  "idempotencyKey",
  "submit",
  "refreshAfterSubmit",
  "fetchFills",
  "cancelIfOpen",
  "tradeOrderPlanBinding",
  "orderIntent",
] as const;
const INTENT_KEYS = [
  "idempotencyKey",
  "venueIds",
  "symbol",
  "productId",
  "side",
  "orderType",
  "timeInForce",
  "network",
  "baseSize",
  "quoteSize",
  "limitPrice",
  "slippageBps",
] as const;
const HYPERLIQUID_ACTION_KEYS = ["type", "orders", "grouping"] as const;
const HYPERLIQUID_ORDER_KEYS = ["a", "b", "p", "s", "r", "t"] as const;
const SIGNATURE_KEYS = ["r", "s", "v"] as const;
const MATERIAL_KEYS = new Set([
  "signedAction",
  "signed_action",
  "signedTransaction",
  "signed_transaction",
  "signedTransactionBase64",
  "signed_transaction_base64",
  "signedPayload",
  "signed_payload",
  "signedMaterial",
  "signed_material",
  "action",
  "actions",
  "transaction",
  "transactions",
  "instruction",
  "instructions",
]);
const HEX_32_BYTES = /^0x[0-9a-fA-F]{64}$/;
const HEX_COMMITMENT = /^[0-9a-f]{64}$/;
const STRICT_POSITIVE_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

/**
 * Validates the browser request for the sealed Hyperliquid worker path.
 * The worker signs only the HMAC-bound plan with the user's sealed trade-only
 * API wallet, so browser-supplied signed actions are intentionally forbidden.
 */
export function assertSealedHyperliquidExecutionRequestMatchesTradeOrderPlan(
  input: unknown,
  plan: TradeOrderPlan,
): SignedExecutionMaterialResult {
  const request = objectValue(input);
  if (!request || plan.venue_id !== "hyperliquid") {
    return invalid("sealed_execution_request_shape_invalid");
  }
  if (!hasExactKeys(request, [...REQUEST_BASE_KEYS, "hyperliquidAccountCommitment"])) {
    return invalid("sealed_execution_request_shape_invalid");
  }
  if (typeof request.csrfToken !== "string" || request.csrfToken.length < 1 || request.csrfToken.length > 512) {
    return invalid("sealed_execution_request_shape_invalid");
  }
  if (request.ensureWallet !== false || singleVenueArray(request.venueIds) !== "hyperliquid") {
    return invalid("sealed_execution_venue_mismatch");
  }
  const intent = objectValue(request.orderIntent);
  if (!intent || !hasExactKeys(intent, INTENT_KEYS) || singleVenueArray(intent.venueIds) !== "hyperliquid") {
    return invalid("sealed_execution_intent_shape_invalid");
  }
  const credentialCommitments = objectValue(request.executionCredentialHandleCommitmentsByVenue);
  if (
    !credentialCommitments ||
    !hasExactKeys(credentialCommitments, ["hyperliquid"]) ||
    !HEX_COMMITMENT.test(String(credentialCommitments.hyperliquid ?? ""))
  ) {
    return invalid("sealed_execution_credential_commitment_invalid");
  }
  if (!HEX_COMMITMENT.test(String(request.hyperliquidAccountCommitment ?? ""))) {
    return invalid("hyperliquid_account_commitment_invalid");
  }
  return { ok: true };
}

/**
 * Parses only the one signed-material envelope the app can validate. This is
 * syntax handling, not execution authorization; the server validator below is
 * the authority.
 */
export function parseSignedExecutionPayload(
  venueId: TradeOrderVenueId,
  value: string,
): Record<string, unknown> {
  const trimmed = value.trim();
  if (!trimmed) return {};
  if (venueId === "phoenix") {
    throw new Error("Phoenix opaque signed transactions are blocked until exact instruction verification is available.");
  }
  if (venueId === "coinbase") {
    throw new Error("Coinbase execution does not accept user-supplied signed material.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("Signed payload must be valid JSON.");
  }
  const record = objectValue(parsed);
  if (!record) throw new Error("Signed payload must be an object.");
  if (hasExactKeys(record, ["signedAction"])) {
    if (!objectValue(record.signedAction)) throw new Error("signedAction must be an object.");
    return record;
  }
  if ("action" in record && "signature" in record) return { signedAction: record };
  throw new Error("Hyperliquid payload must be an exact signedAction envelope.");
}

/**
 * Validates the complete app-execute request so hidden sibling actions cannot
 * bypass the HMAC-bound order intent. Call only with an already verified plan.
 */
export function assertSignedExecutionMaterialMatchesTradeOrderPlan(
  input: unknown,
  plan: TradeOrderPlan,
  options: SignedExecutionMaterialOptions,
): SignedExecutionMaterialResult {
  const request = objectValue(input);
  if (!request) return invalid("signed_execution_request_shape_invalid");

  if (plan.venue_id === "phoenix" && "signedTransactionBase64" in request) {
    return invalid("phoenix_signed_transaction_verifier_unavailable");
  }
  if (plan.venue_id === "coinbase" && hasSignedMaterial(request)) {
    return invalid("coinbase_signed_material_forbidden");
  }

  const venueKeys = plan.venue_id === "hyperliquid"
    ? ["signedAction", "hyperliquidAccountCommitment"]
    : plan.venue_id === "coinbase"
      ? ["coinbaseAccountCommitment"]
      : ["signedTransactionBase64"];
  if (!hasExactKeys(request, [...REQUEST_BASE_KEYS, ...venueKeys])) {
    return invalid("signed_execution_request_shape_invalid");
  }
  if (typeof request.csrfToken !== "string" || request.csrfToken.length < 1 || request.csrfToken.length > 512) {
    return invalid("signed_execution_request_shape_invalid");
  }
  if (request.ensureWallet !== (plan.venue_id === "phoenix")) {
    return invalid("signed_execution_wallet_policy_mismatch");
  }
  const requestVenues = singleVenueArray(request.venueIds);
  if (requestVenues !== plan.venue_id) return invalid("signed_execution_venue_mismatch");

  const intent = objectValue(request.orderIntent);
  if (!intent || !hasExactKeys(intent, INTENT_KEYS) || singleVenueArray(intent.venueIds) !== plan.venue_id) {
    return invalid("signed_execution_intent_shape_invalid");
  }
  const credentialCommitments = objectValue(request.executionCredentialHandleCommitmentsByVenue);
  if (
    !credentialCommitments ||
    !hasExactKeys(credentialCommitments, [plan.venue_id]) ||
    typeof credentialCommitments[plan.venue_id] !== "string" ||
    !HEX_COMMITMENT.test(credentialCommitments[plan.venue_id] as string)
  ) {
    return invalid("signed_execution_credential_commitment_invalid");
  }

  if (plan.venue_id === "phoenix") {
    return invalid("phoenix_signed_transaction_verifier_unavailable");
  }
  if (plan.venue_id === "coinbase") {
    return HEX_COMMITMENT.test(String(request.coinbaseAccountCommitment ?? ""))
      ? { ok: true }
      : invalid("coinbase_account_commitment_invalid");
  }
  if (!HEX_COMMITMENT.test(String(request.hyperliquidAccountCommitment ?? ""))) {
    return invalid("hyperliquid_account_commitment_invalid");
  }
  return validateHyperliquidSignedAction(request.signedAction, plan, options.hyperliquidAssetIndex);
}

/** Browser-side inspection only. The server must additionally bind `a` to its configured asset index. */
export function inspectHyperliquidSignedActionForTradeOrderPlan(
  input: unknown,
  plan: TradeOrderPlan,
): SignedExecutionMaterialResult {
  if (plan.venue_id !== "hyperliquid") return invalid("signed_execution_venue_mismatch");
  const signedAction = objectValue(input);
  const assetIndex = hyperliquidAssetIndex(signedAction);
  if (assetIndex == null) return invalid("hyperliquid_signed_action_shape_invalid");
  return validateHyperliquidSignedAction(signedAction, plan, assetIndex);
}

export function configuredHyperliquidAssetIndex(
  plan: TradeOrderPlan,
  env: Record<string, string | undefined>,
): number | null {
  if (plan.venue_id !== "hyperliquid") return null;
  const key = `GHOLA_HYPERLIQUID_${plan.network.toUpperCase()}_${plan.coin}_ASSET_INDEX`;
  const raw = env[key]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  const index = Number(raw);
  return Number.isSafeInteger(index) ? index : null;
}

function validateHyperliquidSignedAction(
  input: unknown,
  plan: TradeOrderPlan,
  configuredAssetIndex: number | null,
): SignedExecutionMaterialResult {
  const envelope = objectValue(input);
  if (!envelope) return invalid("hyperliquid_signed_action_shape_invalid");
  const hasNetwork = hasExactKeys(envelope, ["action", "nonce", "signature", "network"]);
  const hasMainnetFlag = hasExactKeys(envelope, ["action", "nonce", "signature", "isMainnet"]);
  if (!hasNetwork && !hasMainnetFlag) return invalid("hyperliquid_signed_action_shape_invalid");
  const signedNetwork = hasNetwork
    ? envelope.network
    : envelope.isMainnet === true
      ? "mainnet"
      : envelope.isMainnet === false
        ? "testnet"
        : null;
  if (signedNetwork !== plan.network) return invalid("hyperliquid_signed_action_network_mismatch");
  if (!Number.isSafeInteger(envelope.nonce) || Number(envelope.nonce) <= 0) {
    return invalid("hyperliquid_signed_action_nonce_invalid");
  }
  const signature = objectValue(envelope.signature);
  if (
    !signature ||
    !hasExactKeys(signature, SIGNATURE_KEYS) ||
    typeof signature.r !== "string" ||
    typeof signature.s !== "string" ||
    !HEX_32_BYTES.test(signature.r) ||
    !HEX_32_BYTES.test(signature.s) ||
    (signature.v !== 27 && signature.v !== 28)
  ) {
    return invalid("hyperliquid_signed_action_signature_invalid");
  }

  const action = objectValue(envelope.action);
  if (!action || !hasExactKeys(action, HYPERLIQUID_ACTION_KEYS) || action.type !== "order" || action.grouping !== "na") {
    return invalid("hyperliquid_signed_action_shape_invalid");
  }
  if (!Array.isArray(action.orders) || action.orders.length !== 1) {
    return invalid("hyperliquid_signed_action_order_count_mismatch");
  }
  const order = objectValue(action.orders[0]);
  if (!order || !hasExactKeys(order, HYPERLIQUID_ORDER_KEYS)) {
    return invalid("hyperliquid_signed_order_shape_invalid");
  }
  if (configuredAssetIndex == null || !Number.isSafeInteger(configuredAssetIndex) || configuredAssetIndex < 0) {
    return invalid("hyperliquid_asset_identity_unconfigured");
  }
  if (order.a !== configuredAssetIndex) return invalid("hyperliquid_signed_order_asset_mismatch");
  if (order.b !== (plan.side === "buy")) return invalid("hyperliquid_signed_order_side_mismatch");
  if (order.p !== plan.limit_price) return invalid("hyperliquid_signed_order_limit_price_mismatch");
  if (order.s !== plan.base_size) return invalid("hyperliquid_signed_order_base_size_mismatch");
  if (order.r !== plan.execution_policy.reduce_only) return invalid("hyperliquid_signed_order_reduce_only_mismatch");
  const orderType = objectValue(order.t);
  const limit = objectValue(orderType?.limit);
  const expectedTif = plan.time_in_force === "ioc" ? "Ioc" : "Gtc";
  if (!orderType || !hasExactKeys(orderType, ["limit"]) || !limit || !hasExactKeys(limit, ["tif"]) || limit.tif !== expectedTif) {
    return invalid("hyperliquid_signed_order_tif_mismatch");
  }
  if (!strictPositiveDecimal(order.p) || !strictPositiveDecimal(order.s)) {
    return invalid("hyperliquid_signed_order_decimal_invalid");
  }
  return { ok: true, hyperliquid_asset_index: configuredAssetIndex };
}

function hyperliquidAssetIndex(input: Record<string, unknown> | null): number | null {
  const action = objectValue(input?.action);
  const orders = Array.isArray(action?.orders) ? action.orders : [];
  const order = orders.length === 1 ? objectValue(orders[0]) : null;
  return Number.isSafeInteger(order?.a) && Number(order?.a) >= 0 ? Number(order?.a) : null;
}

function strictPositiveDecimal(value: unknown) {
  return typeof value === "string" && STRICT_POSITIVE_DECIMAL.test(value) && Number(value) > 0 && Number.isFinite(Number(value));
}

function hasSignedMaterial(record: Record<string, unknown>) {
  return Object.keys(record).some((key) => MATERIAL_KEYS.has(key));
}

function singleVenueArray(input: unknown): TradeOrderVenueId | null {
  if (!Array.isArray(input) || input.length !== 1) return null;
  return input[0] === "hyperliquid" || input[0] === "phoenix" || input[0] === "coinbase" ? input[0] : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]) {
  const keys = Object.keys(record);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function invalid(error: string): SignedExecutionMaterialResult {
  return { ok: false, error };
}
