import { createHash } from "node:crypto";

export function revenueEvidenceEvent({
  session,
  proposal,
  receipt,
  revenueQuote,
  executorId,
  tickId,
  workOrderCommitment,
  now = new Date(),
}) {
  const createdAt = iso(now);
  const quote = revenueQuote || null;
  const status = revenueStatus(quote);
  return {
    version: 1,
    evidence_kind: "autopilot_order_revenue_v1",
    revenue_status: status,
    collection_status: quote?.collection_status || "not_configured",
    revenue_model: quote?.revenue_model || "none",
    venue_id: proposal?.venue_id || receipt?.venue_id || null,
    operation_class: proposal?.operation_class || receipt?.operation_class || null,
    market: proposal?.market || null,
    fee_bps: quote?.fee_bps || 0,
    notional_bucket: quote?.notional_usd != null
      ? trim(quote.notional_usd)
      : proposal?.notional_usd != null
        ? trim(proposal.notional_usd)
        : "0",
    expected_fee_bucket: quote?.fee_bucket || "0",
    fee_currency: "USD",
    fee_recipient: quote?.fee_recipient || null,
    fee_recipient_commitment: quote?.fee_recipient_commitment || null,
    work_order_commitment: workOrderCommitment || receipt?.work_order_commitment || null,
    autopilot_session_id: session?.autopilot_session_id || null,
    agent_controller_id: session?.agent_controller_id || null,
    policy_commitment: session?.session_policy?.policy_commitment || proposal?.policy_commitment || null,
    tick_id: tickId || null,
    executor_id: executorId || null,
    provider_ref_commitment: receipt?.provider_ref_commitment || null,
    result_commitment: receipt?.result_commitment || null,
    final_proof_commitment: receipt?.final_proof
      ? commitment("final_proof", receipt.final_proof)
      : null,
    venue_signature_commitment: receipt?.final_proof?.signature_commitment || null,
    onchain_collection_proof: receipt?.final_proof?.final_venue_execution_proven === true,
    created_at: createdAt,
  };
}

export function finalizeRevenueEvidenceEvent(event, {
  previousEventHash = null,
  sequence = null,
} = {}) {
  const base = {
    ...event,
    revenue_event_id: undefined,
    event_hash: undefined,
    previous_event_hash: previousEventHash || null,
    ledger_sequence: Number.isInteger(sequence) && sequence > 0 ? sequence : null,
  };
  const eventHash = `sha256_${sha256Hex(stableJson(base))}`;
  return {
    ...base,
    revenue_event_id: event.revenue_event_id || `revevt_${eventHash.slice("sha256_".length, "sha256_".length + 32)}`,
    event_hash: eventHash,
  };
}

export function revenueEvidenceStatement(events = [], { now = new Date() } = {}) {
  const sorted = [...events].sort((a, b) =>
    Number(a.ledger_sequence || 0) - Number(b.ledger_sequence || 0) ||
      String(a.created_at || "").localeCompare(String(b.created_at || ""))
  );
  const expected = sorted.filter((event) =>
    ["expected", "collected", "routed"].includes(event.revenue_status)
  );
  const totals = {
    expected_fee_bucket: trim(sum(expected.map((event) => event.expected_fee_bucket))),
    event_count: sorted.length,
    expected_revenue_event_count: expected.length,
  };
  const byVenue = {};
  const byStatus = {};
  for (const event of sorted) {
    const venue = event.venue_id || "unknown";
    const status = event.revenue_status || "unknown";
    byVenue[venue] ||= { venue_id: venue, event_count: 0, expected_fee_bucket: "0" };
    byVenue[venue].event_count += 1;
    if (["expected", "collected", "routed"].includes(status)) {
      byVenue[venue].expected_fee_bucket = trim(
        Number(byVenue[venue].expected_fee_bucket || 0) +
          Number(event.expected_fee_bucket || 0)
      );
    }
    byStatus[status] = (byStatus[status] || 0) + 1;
  }
  const chain = hashChainStatus(sorted);
  const generatedAt = iso(now);
  const statementSeed = {
    event_hashes: sorted.map((event) => event.event_hash).filter(Boolean),
    totals,
    chain_head: chain.head_event_hash,
    generated_at: generatedAt,
  };
  return {
    version: 1,
    statement_kind: "ghola_revenue_evidence_statement_v1",
    generated_at: generatedAt,
    totals,
    by_venue: Object.values(byVenue),
    by_status: byStatus,
    hash_chain: chain,
    statement_commitment: commitment("revenue_statement", statementSeed),
  };
}

export function verifyRevenueEvidenceEvent(event) {
  if (!event?.event_hash) return false;
  const rebuilt = finalizeRevenueEvidenceEvent({
    ...event,
    revenue_event_id: undefined,
    event_hash: undefined,
  }, {
    previousEventHash: event.previous_event_hash || null,
    sequence: event.ledger_sequence || null,
  });
  return rebuilt.event_hash === event.event_hash;
}

function revenueStatus(quote) {
  if (!quote) return "not_configured";
  if (quote.collection_status === "dry_run_quoted") return "dry_run";
  if (quote.collection_status === "routed_in_jupiter_order") return "expected";
  return "expected";
}

function hashChainStatus(events) {
  let previous = events[0]?.previous_event_hash || null;
  let valid = true;
  for (const event of events) {
    if ((event.previous_event_hash || null) !== previous) valid = false;
    if (!verifyRevenueEvidenceEvent(event)) valid = false;
    previous = event.event_hash || null;
  }
  return {
    valid,
    event_count: events.length,
    starts_after_event_hash: events[0]?.previous_event_hash || null,
    first_event_hash: events[0]?.event_hash || null,
    head_event_hash: previous,
  };
}

function commitment(prefix, value) {
  return `${prefix}_${sha256Hex(stableJson(value)).slice(0, 48)}`;
}

function sha256Hex(value) {
  return createHash("sha256").update(String(value)).digest("hex");
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

function sum(values) {
  return values.reduce((acc, value) => {
    const parsed = Number.parseFloat(String(value ?? "0"));
    return acc + (Number.isFinite(parsed) ? parsed : 0);
  }, 0);
}

function trim(value) {
  const parsed = Number.parseFloat(String(value ?? "0"));
  return (Number.isFinite(parsed) ? parsed : 0)
    .toFixed(8)
    .replace(/0+$/, "")
    .replace(/\.$/, "");
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}
