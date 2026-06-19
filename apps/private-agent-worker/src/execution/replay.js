import { createHash } from "node:crypto";

export function agentControllerId(session) {
  if (session?.agent_controller_id) return session.agent_controller_id;
  return `agentctl_${digest({
    owner_commitment: session?.owner_commitment || "owner_redacted",
    autopilot_session_id: session?.autopilot_session_id || null,
    policy_commitment: session?.session_policy?.policy_commitment || null,
  }).slice(0, 32)}`;
}

export function executorRecord({
  session,
  kind = "order",
  tick_id = null,
  status = "created",
  proposal = {},
  work_order_commitment = null,
  receipt = null,
  parent_executor_id = null,
  close_reason = null,
  now = new Date(),
  extra = {},
}) {
  const createdAt = iso(now);
  const executorId = extra.executor_id || `executor_${digest({
    session: session?.autopilot_session_id || null,
    kind,
    tick_id,
    proposal_commitment: proposal?.proposal_commitment || null,
    work_order_commitment,
    now: createdAt,
  }).slice(0, 32)}`;
  const receiptCommitments = [
    receipt?.receipt_commitment,
    receipt?.result_commitment,
    receipt?.final_proof,
  ].filter(Boolean);
  return {
    version: 1,
    executor_id: executorId,
    agent_controller_id: agentControllerId(session),
    autopilot_session_id: session?.autopilot_session_id || null,
    parent_executor_id,
    kind,
    status,
    lifecycle: lifecycleForStatus(status),
    venue_id: proposal?.venue_id || receipt?.venue_id || null,
    operation_class: proposal?.operation_class || receipt?.operation_class || null,
    market: proposal?.market || null,
    side: proposal?.side || null,
    notional_bucket: proposal?.notional_usd != null ? String(proposal.notional_usd) : null,
    policy_commitment: session?.session_policy?.policy_commitment || proposal?.policy_commitment || null,
    proposal_commitment: proposal?.proposal_commitment || null,
    decision_id: proposal?.decision_id || null,
    work_order_commitment,
    tick_id,
    receipt_commitments: receiptCommitments,
    provider_ref_commitment: receipt?.provider_ref_commitment || null,
    result_commitment: receipt?.result_commitment || null,
    fee_quote_bucket: extra.fee_quote_bucket || "0",
    pnl_quote_bucket: extra.pnl_quote_bucket || "0",
    exposure_notional_bucket: proposal?.notional_usd != null ? String(proposal.notional_usd) : "0",
    close_reason,
    created_at: extra.created_at || createdAt,
    updated_at: createdAt,
    metadata: publicMetadata(extra.metadata || {}),
  };
}

export function tickSnapshot({
  session,
  tick_id = null,
  status = "started",
  market = null,
  positions = [],
  decision = null,
  proposal = null,
  risk_result = null,
  executor_ids = [],
  receipt_commitments = [],
  error = null,
  now = new Date(),
}) {
  const createdAt = iso(now);
  const id = tick_id || `tick_${digest({
    session: session?.autopilot_session_id || null,
    created_at: createdAt,
    market: market?.product_id || market?.market || null,
  }).slice(0, 32)}`;
  const marketPublic = market ? publicMarketSnapshot(market) : null;
  return {
    version: 1,
    tick_id: id,
    agent_controller_id: agentControllerId(session),
    autopilot_session_id: session?.autopilot_session_id || null,
    status,
    policy_commitment: session?.session_policy?.policy_commitment || null,
    strategy_id: session?.session_policy?.strategy_id || session?.strategy?.strategy_id || null,
    decision_model: session?.session_policy?.decision_model || session?.strategy?.decision_model || null,
    market_snapshot_commitment: marketPublic ? commitment("market_snapshot", marketPublic) : null,
    market_snapshot: marketPublic,
    position_snapshot_commitment: commitment("position_snapshot", positions.map(publicPosition)),
    position_count: Array.isArray(positions) ? positions.length : 0,
    decision_id: decision?.decision_id || decision?.record?.decision_id || proposal?.decision_id || null,
    decision_commitment: decision?.decision_commitment || decision?.record?.decision_commitment || null,
    proposal_commitment: proposal?.proposal_commitment || null,
    risk_result: risk_result || null,
    risk_reason: risk_result?.reason || error || null,
    executor_ids,
    receipt_commitments,
    error,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

export function executionMetrics({
  session,
  executors = [],
  ticks = [],
  positions = [],
  now = new Date(),
}) {
  const submitted = executors.filter((item) => ["submitted", "filled", "reconciled"].includes(item.status));
  const failed = executors.filter((item) => ["failed", "rejected"].includes(item.status));
  const open = executors.filter((item) => ["created", "submitted", "open"].includes(item.status));
  const notional = submitted.reduce((sum, item) => sum + numberBucket(item.notional_bucket), 0);
  const exposure = positions.reduce((sum, item) =>
    sum + numberBucket(item.estimated_exposure_notional_usd ?? item.notional_usd ?? item.exposure_notional_bucket),
  0);
  const fee = executors.reduce((sum, item) => sum + numberBucket(item.fee_quote_bucket), 0);
  const pnl = executors.reduce((sum, item) => sum + numberBucket(item.pnl_quote_bucket), 0);
  const latestTick = ticks
    .map((tick) => tick?.updated_at || tick?.created_at)
    .filter(Boolean)
    .sort()
    .at(-1) || null;
  return {
    version: 1,
    agent_controller_id: agentControllerId(session),
    autopilot_session_id: session?.autopilot_session_id || null,
    executor_count: executors.length,
    tick_count: ticks.length,
    open_executor_count: open.length,
    submitted_executor_count: submitted.length,
    failed_executor_count: failed.length,
    rejected_tick_count: ticks.filter((tick) => tick.status === "rejected" || tick.error).length,
    notional_submitted_bucket: trimNumber(notional),
    gross_exposure_bucket: trimNumber(exposure),
    realized_pnl_bucket: trimNumber(pnl),
    fee_bucket: trimNumber(fee),
    last_tick_at: latestTick,
    updated_at: iso(now),
  };
}

export function replayBundle({ session, events = [], executors = [], tick_snapshots = [], positions = [], now = new Date() }) {
  return {
    version: 1,
    session,
    metrics: executionMetrics({ session, executors, ticks: tick_snapshots, positions, now }),
    executors,
    tick_snapshots,
    positions,
    events,
  };
}

function publicMarketSnapshot(market) {
  return {
    product_id: market.product_id || market.market || null,
    price: market.price ?? market.mid ?? null,
    change_24h: market.change_24h ?? null,
    spread_bps: market.spread_bps ?? null,
    live_status: market.live_status || market.source || null,
    fetched_at: market.fetched_at || null,
    stale: market.stale === true,
  };
}

function publicPosition(position) {
  return {
    venue_id: position?.venue_id || null,
    market: position?.market || null,
    side: position?.side || null,
    exposure_notional_bucket: String(
      position?.estimated_exposure_notional_usd ??
        position?.notional_usd ??
        position?.exposure_notional_bucket ??
        "0",
    ),
    updated_at: position?.updated_at || null,
  };
}

function publicMetadata(metadata) {
  const out = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value == null) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  return out;
}

function lifecycleForStatus(status) {
  if (status === "created") return "created";
  if (status === "submitted" || status === "open") return "running";
  if (status === "filled" || status === "reconciled") return "closed";
  if (status === "failed" || status === "rejected" || status === "simulated") return "closed";
  return "created";
}

function commitment(prefix, value) {
  return `${prefix}_${digest(value).slice(0, 48)}`;
}

function digest(value) {
  return createHash("sha256")
    .update(stableJson(value ?? null))
    .digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function iso(value) {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function numberBucket(value) {
  const parsed = Number.parseFloat(String(value ?? "0").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function trimNumber(value) {
  if (!Number.isFinite(value)) return "0";
  return String(Number(value.toFixed(8)));
}
