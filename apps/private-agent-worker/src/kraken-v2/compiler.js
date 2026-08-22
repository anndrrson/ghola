import { krakenCommitment } from "./commitment.js";
import { USD_ASSET_ID } from "./types.js";

const EPSILON = 1e-8;

export function compileAllocationPlan({
  mandate,
  intents,
  snapshot,
  frozenSleeves = {},
  now = new Date(),
}) {
  assertSnapshot(snapshot);
  const activeIntents = latestIntentBySleeve(intents, mandate, now);
  const missingSleeves = mandate.sleeves
    .filter((sleeve) => !activeIntents.has(sleeve.sleeve_id) && !frozenSleeves[sleeve.sleeve_id])
    .map((sleeve) => sleeve.sleeve_id);
  if (missingSleeves.length > 0) {
    return compilationResult({
      mandate,
      snapshot,
      intents: [...activeIntents.values()],
      status: "blocked",
      reasonCodes: ["sleeve_allocation_missing"],
      pausedSleeves: missingSleeves,
      targets: {},
      deltas: [],
      now,
    });
  }

  const managedNavUsd = calculateManagedNav(snapshot);
  const targetNotional = { [USD_ASSET_ID]: 0 };
  const sleeveTargets = {};
  for (const sleeve of mandate.sleeves) {
    const frozen = frozenSleeves[sleeve.sleeve_id];
    if (frozen) {
      sleeveTargets[sleeve.sleeve_id] = {
        status: "frozen",
        target_notional_usd: { ...frozen.target_notional_usd },
      };
      addTargets(targetNotional, frozen.target_notional_usd);
      continue;
    }
    const intent = activeIntents.get(sleeve.sleeve_id);
    const sleeveCapital = managedNavUsd * sleeve.capital_weight_bps / 10_000;
    const targets = {};
    for (const [asset, weightBps] of Object.entries(intent.weights_bps)) {
      targets[asset] = sleeveCapital * weightBps / 10_000;
    }
    sleeveTargets[sleeve.sleeve_id] = {
      status: "active",
      intent_idempotency_key: intent.idempotency_key,
      sequence: intent.sequence,
      target_notional_usd: targets,
    };
    addTargets(targetNotional, targets);
  }

  const effective = effectiveNotional(snapshot);
  const assets = new Set([
    ...Object.keys(targetNotional),
    ...Object.keys(effective),
  ]);
  const deltas = [];
  for (const asset of [...assets].sort()) {
    if (asset === USD_ASSET_ID) continue;
    const targetUsd = targetNotional[asset] || 0;
    const effectiveUsd = effective[asset] || 0;
    const deltaUsd = targetUsd - effectiveUsd;
    const driftBps = managedNavUsd > EPSILON
      ? Math.round(Math.abs(deltaUsd) / managedNavUsd * 10_000)
      : targetUsd > 0 ? 10_000 : 0;
    const belowMandateBand = driftBps < mandate.limits.drift_threshold_bps;
    const belowMinimumOrder = Math.abs(deltaUsd) < Number(mandate.limits.min_order_usd);
    deltas.push({
      canonical_instrument_id: asset,
      target_notional_usd: decimal(targetUsd),
      confirmed_notional_usd: decimal(snapshot.positions?.[asset]?.notional_usd || 0),
      pending_order_notional_usd: decimal(snapshot.open_orders?.[asset]?.signed_notional_usd || 0),
      effective_notional_usd: decimal(effectiveUsd),
      delta_notional_usd: decimal(deltaUsd),
      side: deltaUsd >= 0 ? "buy" : "sell",
      drift_bps: driftBps,
      executable: !belowMandateBand && !belowMinimumOrder,
      no_trade_reason: belowMandateBand
        ? "inside_drift_band"
        : belowMinimumOrder ? "below_min_order" : null,
    });
  }

  const executable = deltas.filter((delta) => delta.executable);
  executable.sort((a, b) => {
    if (a.side !== b.side) return a.side === "sell" ? -1 : 1;
    return Math.abs(Number(b.delta_notional_usd)) - Math.abs(Number(a.delta_notional_usd));
  });
  return compilationResult({
    mandate,
    snapshot,
    intents: [...activeIntents.values()],
    status: executable.length > 0 ? "executable" : "no_op",
    reasonCodes: executable.length > 0 ? [] : ["portfolio_inside_mandate_bounds"],
    pausedSleeves: Object.keys(frozenSleeves),
    targets: targetNotional,
    sleeveTargets,
    deltas,
    now,
  });
}

export function calculateManagedNav(snapshot) {
  return Number(snapshot.usd_balance || 0) +
    Object.values(snapshot.positions || {})
      .reduce((sum, position) => sum + Number(position.notional_usd || 0), 0);
}

export function latestIntentBySleeve(intents, mandate, now = new Date()) {
  const allowed = new Set(mandate.sleeves.map((sleeve) => sleeve.sleeve_id));
  const selected = new Map();
  for (const intent of intents || []) {
    if (!allowed.has(intent.sleeve_id)) continue;
    if (Date.parse(intent.effective_at) > now.getTime()) continue;
    if (Date.parse(intent.expires_at) <= now.getTime()) continue;
    const current = selected.get(intent.sleeve_id);
    if (!current || intent.sequence > current.sequence) selected.set(intent.sleeve_id, intent);
  }
  return selected;
}

function effectiveNotional(snapshot) {
  const result = {};
  for (const [asset, position] of Object.entries(snapshot.positions || {})) {
    result[asset] = Number(position.notional_usd || 0);
  }
  for (const [asset, order] of Object.entries(snapshot.open_orders || {})) {
    result[asset] = (result[asset] || 0) + Number(order.signed_notional_usd || 0);
  }
  return result;
}

function compilationResult({
  mandate,
  snapshot,
  intents,
  status,
  reasonCodes,
  pausedSleeves,
  targets,
  sleeveTargets = {},
  deltas,
  now,
}) {
  const seed = {
    mandate_id: mandate.mandate_id,
    connection_id: mandate.connection_id,
    snapshot_commitment: snapshot.snapshot_commitment,
    intents: intents.map((intent) => ({
      sleeve_id: intent.sleeve_id,
      sequence: intent.sequence,
      idempotency_key: intent.idempotency_key,
    })),
    status,
    reason_codes: reasonCodes,
    targets,
    sleeve_targets: sleeveTargets,
    deltas,
  };
  return {
    version: 1,
    compiler_version: "ghola-kraken-allocation-compiler-v1",
    compilation_commitment: krakenCommitment("compilation", seed),
    mandate_id: mandate.mandate_id,
    connection_id: mandate.connection_id,
    snapshot_commitment: snapshot.snapshot_commitment,
    status,
    reason_codes: reasonCodes,
    paused_sleeves: pausedSleeves,
    target_notional_usd: mapDecimals(targets),
    sleeve_targets: sleeveTargets,
    deltas,
    created_at: now.toISOString(),
  };
}

function assertSnapshot(snapshot) {
  if (!snapshot || snapshot.completeness !== "complete") {
    throw new Error("portfolio snapshot must be complete");
  }
  if (!snapshot.snapshot_commitment) {
    throw new Error("portfolio snapshot commitment is required");
  }
}

function addTargets(target, input) {
  for (const [asset, value] of Object.entries(input || {})) {
    target[asset] = (target[asset] || 0) + Number(value || 0);
  }
}

function mapDecimals(value) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decimal(item)]));
}

function decimal(value) {
  const number = Math.abs(Number(value)) < EPSILON ? 0 : Number(value);
  return number.toFixed(8).replace(/\.?0+$/, "") || "0";
}
