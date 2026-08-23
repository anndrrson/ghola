#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_EVIDENCE_PATH = resolve(
  HERE,
  "../../../deploy/evidence/hyperliquid-mainnet-proof-2026-08-23.json",
);

export function verifyHyperliquidReleaseEvidence(evidence) {
  const failures = [];
  const fail = (condition, code) => {
    if (!condition) failures.push(code);
  };

  fail(evidence?.version === 1, "version_invalid");
  fail(evidence?.kind === "ghola_hyperliquid_mainnet_round_trip_release_proof", "kind_invalid");
  fail(evidence?.network === "mainnet", "mainnet_required");
  fail(evidence?.market === "HYPE", "hype_market_required");
  fail(/^0x[0-9a-f]{40}$/i.test(String(evidence?.owner ?? "")), "owner_invalid");
  fail(/^[0-9a-f]{7,40}$/i.test(String(evidence?.candidate?.web_commit_sha ?? "")), "candidate_sha_invalid");
  fail(/^https:\/\/[^/]+\.vercel\.app$/i.test(String(evidence?.candidate?.preview_url ?? "")), "candidate_url_invalid");

  const requestedNotional = positiveNumber(evidence?.request?.quote_notional_usd);
  const slippage = positiveNumber(evidence?.request?.max_slippage_bps);
  const stop = positiveNumber(evidence?.request?.stop_loss_usd);
  fail(requestedNotional > 0 && requestedNotional <= 50, "public_beta_notional_cap_exceeded");
  fail(slippage > 0 && slippage <= 100, "public_beta_slippage_cap_exceeded");
  fail(stop > 0, "stop_missing");
  fail(evidence?.request?.ambiguity_retry_performed === false, "ambiguity_retry_forbidden");

  const entrySize = positiveNumber(evidence?.entry?.filled_base_size);
  const closeSize = positiveNumber(evidence?.close?.filled_base_size);
  fail(evidence?.entry?.direction === "Open Long", "entry_direction_invalid");
  fail(evidence?.entry?.reduce_only === false, "entry_reduce_only_invalid");
  fail(entrySize > 0, "entry_fill_missing");
  fail(evidence?.protection?.order_type === "Stop Market", "native_stop_required");
  fail(evidence?.protection?.reduce_only === true, "stop_reduce_only_required");
  fail(positiveNumber(evidence?.protection?.trigger_price_usd) === stop, "stop_price_mismatch");
  fail(positiveNumber(evidence?.protection?.base_size) === entrySize, "stop_size_mismatch");
  fail(evidence?.protection?.terminal_status === "reduceOnlyCanceled", "stop_terminal_status_invalid");
  fail(evidence?.close?.direction === "Close Long", "close_direction_invalid");
  fail(evidence?.close?.reduce_only === true, "close_reduce_only_required");
  fail(closeSize === entrySize, "exact_close_size_required");

  const entryAt = timestamp(evidence?.entry?.filled_at);
  const stopOpenedAt = timestamp(evidence?.protection?.opened_at);
  const closeAt = timestamp(evidence?.close?.filled_at);
  const stopTerminalAt = timestamp(evidence?.protection?.terminal_at);
  const finalAt = timestamp(evidence?.final_venue_state?.checked_at);
  fail(entryAt > 0, "entry_timestamp_invalid");
  fail(stopOpenedAt === entryAt, "stop_not_submitted_with_entry");
  fail(closeAt > entryAt, "close_timestamp_invalid");
  fail(stopTerminalAt === closeAt, "stop_not_canceled_with_close");
  fail(finalAt >= closeAt, "final_state_timestamp_invalid");
  fail(evidence?.final_venue_state?.nonzero_positions === 0, "final_position_not_flat");
  fail(evidence?.final_venue_state?.open_orders === 0, "final_open_orders_not_zero");

  const clientOrderIds = [
    evidence?.entry?.client_order_id,
    evidence?.protection?.client_order_id,
    evidence?.close?.client_order_id,
  ];
  fail(clientOrderIds.every((id) => /^0x[0-9a-f]{32}$/i.test(String(id ?? ""))), "client_order_id_invalid");
  fail(new Set(clientOrderIds).size === 3, "client_order_ids_not_unique");

  const expectedCommitment = evidenceCommitment(evidence);
  fail(evidence?.evidence_commitment === expectedCommitment, "evidence_commitment_mismatch");

  if (failures.length > 0) {
    throw new Error(`Hyperliquid release evidence failed: ${[...new Set(failures)].join(", ")}`);
  }
  return {
    ok: true,
    evidence_commitment: expectedCommitment,
    entry_client_order_id: evidence.entry.client_order_id,
    close_client_order_id: evidence.close.client_order_id,
  };
}

export function evidenceCommitment(evidence) {
  const payload = { ...evidence };
  delete payload.evidence_commitment;
  return `hlproof_${createHash("sha256").update(stableJson(payload)).digest("hex")}`;
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}

function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function timestamp(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function main() {
  const evidencePath = resolve(process.env.GHOLA_RELEASE_EVIDENCE_PATH || DEFAULT_EVIDENCE_PATH);
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  const verified = verifyHyperliquidReleaseEvidence(evidence);
  console.log(`[hyperliquid-release-evidence] verified ${verified.evidence_commitment}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
