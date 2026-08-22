import { createHmac, timingSafeEqual } from "node:crypto";
import { stableJson } from "./commitment.js";
import { KrakenV2ValidationError } from "./types.js";

export const BLOCKED_COUNTRIES = new Set(["US", "CA", "GB", "AU"]);
export const EEA_COUNTRIES = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR",
  "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK",
  "SI", "ES", "SE", "IS", "LI", "NO",
]);

export function enforceJurisdiction(attestation, now = new Date(), verificationSecret = "") {
  if (!attestation || attestation.assertion !== "eligible_non_restricted_user") {
    throw new KrakenV2ValidationError("signed jurisdiction attestation is required", "jurisdiction_required", 403);
  }
  const country = String(attestation.country_code || "").toUpperCase();
  if (BLOCKED_COUNTRIES.has(country)) {
    throw new KrakenV2ValidationError("xStocks are restricted in the asserted country", "jurisdiction_blocked", 403);
  }
  if (EEA_COUNTRIES.has(country)) {
    throw new KrakenV2ValidationError("Kraken xStocks API order books are unavailable for EEA clients", "api_orderbook_ineligible", 403);
  }
  if (now.getTime() - Date.parse(attestation.signed_at) > 24 * 60 * 60 * 1_000) {
    throw new KrakenV2ValidationError("jurisdiction attestation is stale", "jurisdiction_attestation_stale", 403);
  }
  if (verificationSecret) {
    const expected = jurisdictionSignature(attestation, verificationSecret);
    const actual = String(attestation.signature_commitment || "");
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
    ) {
      throw new KrakenV2ValidationError(
        "jurisdiction attestation signature is invalid",
        "jurisdiction_signature_invalid",
        403,
      );
    }
  }
  return { ok: true, country_code: country };
}

export function jurisdictionSignature(attestation, secret) {
  const { signature_commitment: _signature, ...claims } = attestation;
  return `ghjur_v1.${createHmac("sha256", secret)
    .update(stableJson(claims))
    .digest("base64url")}`;
}

export function enforceMandateForCompilation({ mandate, compilation, dailyTurnoverUsd = 0 }) {
  if (mandate.status !== "active") {
    throw new KrakenV2ValidationError("mandate is not active", `mandate_${mandate.status}`, 403);
  }
  if (Date.parse(mandate.expires_at) <= Date.now()) {
    throw new KrakenV2ValidationError("mandate is expired", "mandate_expired", 403);
  }
  const remainingDaily = Math.max(
    0,
    Number(mandate.limits.max_daily_turnover_usd) - Number(dailyTurnoverUsd || 0),
  );
  let availableDaily = remainingDaily;
  const executable = [];
  for (const delta of compilation.deltas.filter((item) => item.executable)) {
    const requested = Math.abs(Number(delta.delta_notional_usd));
    const amount = Math.min(
      requested,
      Number(mandate.limits.max_single_order_usd),
      availableDaily,
    );
    if (amount < Number(mandate.limits.min_order_usd)) continue;
    executable.push({
      ...delta,
      child_order_notional_usd: amount.toFixed(8).replace(/\.?0+$/, ""),
    });
    availableDaily -= amount;
  }
  return {
    ok: executable.length > 0 || compilation.status === "no_op",
    remaining_daily_turnover_usd: remainingDaily,
    executable_deltas: executable.slice(0, mandate.limits.max_orders_per_rebalance),
    truncated: executable.length > mandate.limits.max_orders_per_rebalance,
  };
}

export function detectExternalActivity({ openOrders = [], fills = [], clientOrderPrefix = "ghk-" }) {
  const externalOrders = openOrders.filter((order) =>
    !String(order.client_order_id || order.cl_ord_id || "").startsWith(clientOrderPrefix)
  );
  const externalFills = fills.filter((fill) => {
    const id = String(fill.client_order_id || fill.cl_ord_id || "");
    return id && !id.startsWith(clientOrderPrefix);
  });
  return {
    detected: externalOrders.length > 0 || externalFills.length > 0,
    external_order_count: externalOrders.length,
    external_fill_count: externalFills.length,
  };
}
