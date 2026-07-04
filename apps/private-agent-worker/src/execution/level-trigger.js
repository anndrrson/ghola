import { createHash, randomUUID } from "node:crypto";

// Deterministic directional strategy: watch a user-drawn price level, fire a
// single bounded entry when the level is broken/retested/swept, then monitor
// the invalidation (stop) level and time horizon and close. Mirrors the
// self-contained, dependency-injected contract used by arbitrage.js so the
// autopilot loop can dispatch it the same way.

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DEFAULT_BAND_BPS = 15;
const HORIZON_MS = {
  scalp: 15 * 60_000,
  session_trade: 4 * 60 * 60_000,
  intraday: 12 * 60 * 60_000,
  until_invalidated: null,
  custom_window: 60 * 60_000,
};

export function isLevelTriggerSession(session) {
  return session?.session_policy?.strategy_id === "level_trigger_v1" ||
    session?.strategy?.strategy_id === "level_trigger_v1";
}

// Pure entry evaluator. Returns { triggered, directive, reason }; `directive`
// carries forward multi-tick flags (broke/swept) so retest/sweep work across
// the 30s polling loop and survive a worker restart.
export function evaluateEntryTrigger({ price, mandate, side, directive }) {
  const L = Number(mandate.trigger_level);
  const band = bandFraction(mandate);
  const d = { ...directive };
  const trigger = mandate.entry_trigger;
  if (!Number.isFinite(L) || L <= 0) {
    return { triggered: false, directive: d, reason: "trigger level unavailable" };
  }
  if (trigger === "preview_now") {
    return { triggered: true, directive: d, reason: "immediate entry" };
  }
  if (trigger === "break_level") {
    const triggered = side === "buy" ? price >= L : price <= L;
    return { triggered, directive: d, reason: triggered ? "level broken" : "awaiting level break" };
  }
  if (trigger === "retest_level") {
    if (side === "buy") {
      if (price >= L * (1 + band)) d.broke = true;
      const triggered = d.broke === true && price <= L * (1 + band) && price >= L * (1 - band);
      return { triggered, directive: d, reason: triggered ? "level retested from above" : d.broke ? "awaiting retest" : "awaiting breakout" };
    }
    if (price <= L * (1 - band)) d.broke = true;
    const triggered = d.broke === true && price >= L * (1 - band) && price <= L * (1 + band);
    return { triggered, directive: d, reason: triggered ? "level retested from below" : d.broke ? "awaiting retest" : "awaiting breakdown" };
  }
  if (trigger === "sweep_reclaim") {
    if (side === "buy") {
      if (price <= L * (1 - band)) d.swept = true;
      const triggered = d.swept === true && price >= L;
      return { triggered, directive: d, reason: triggered ? "level swept and reclaimed" : d.swept ? "awaiting reclaim" : "awaiting sweep" };
    }
    if (price >= L * (1 + band)) d.swept = true;
    const triggered = d.swept === true && price <= L;
    return { triggered, directive: d, reason: triggered ? "level swept and reclaimed" : d.swept ? "awaiting reclaim" : "awaiting sweep" };
  }
  return { triggered: false, directive: d, reason: `entry trigger ${trigger} is not supported by the level strategy` };
}

// Pure exit evaluator. Closes on stop (invalidation) or time horizon.
export function evaluateExit({ price, mandate, side, now, directive }) {
  const invalidation = mandate.invalidation_level ? Number(mandate.invalidation_level) : null;
  if (Number.isFinite(invalidation) && invalidation > 0) {
    const stopHit = side === "buy" ? price <= invalidation : price >= invalidation;
    if (stopHit) return { exit: true, reason: "invalidation_level" };
  }
  const deadline = directive.deadline_at ? new Date(directive.deadline_at).getTime() : null;
  if (deadline && Number.isFinite(deadline) && now.getTime() >= deadline) {
    return { exit: true, reason: "time_horizon" };
  }
  return { exit: false, reason: "holding" };
}

export async function runGuardedLevelTriggerTick({
  session,
  state,
  recipient,
  now = new Date(),
  env = process.env,
  fetchImpl = fetch,
  appendEvent,
  executeOrder,
  verifyOrder,
}) {
  const policy = session.session_policy;
  const mandate = policy.agent_mandate || null;
  const side = policy.agent_side === "sell" ? "sell" : "buy";
  const directive = normalizeDirective(session.directive, side, now);

  if (directive.phase === "done") {
    return { ok: false, error: "level_trigger_complete" };
  }
  if (!mandate || !mandate.trigger_level) {
    await appendEvent(state, session, "guardrail", "Level-trigger session is missing a mandate trigger level.", {
      strategy_id: policy.strategy_id,
    }, now);
    return { ok: false, error: "level_trigger_mandate_missing" };
  }

  const venue = readyVenues(session)[0] || policy.venue_allowlist[0];
  if (!venue) {
    await appendEvent(state, session, "guardrail", "No venue is ready for the level-trigger plan.", {}, now);
    return { ok: false, error: "venue_not_ready" };
  }
  const product = primaryProduct(policy);
  const market = await marketPrice({ product, env, fetchImpl, now });
  await appendEvent(state, session, "agent_tick", "Level-trigger evaluated market data.", {
    product_id: product,
    price: market.price,
    live_status: market.live_status,
    phase: directive.phase,
    side,
    trigger_level: mandate.trigger_level,
    invalidation_level: mandate.invalidation_level || null,
    entry_trigger: mandate.entry_trigger,
  }, now);
  if (market.stale || !(Number(market.price) > 0)) {
    return { ok: false, error: "market_data_stale" };
  }
  const price = Number(market.price);

  // ---- Monitoring an open position: watch the stop + time horizon ----
  if (directive.phase === "in_position") {
    const decision = evaluateExit({ price, mandate, side, now, directive });
    if (!decision.exit) {
      await persistDirective(state, session, directive, now);
      return { ok: true, phase: "in_position", action: "hold" };
    }
    return runExit({
      session, state, recipient, now, env, venue, product, side, price, mandate,
      directive, reason: decision.reason, appendEvent, executeOrder,
    });
  }

  // ---- Watching for the entry trigger ----
  const entry = evaluateEntryTrigger({ price, mandate, side, directive });
  Object.assign(directive, entry.directive);
  if (!entry.triggered) {
    await persistDirective(state, session, directive, now);
    await appendEvent(state, session, "agent_watch", entry.reason, {
      price,
      trigger_level: mandate.trigger_level,
      entry_trigger: mandate.entry_trigger,
      broke: directive.broke === true,
      swept: directive.swept === true,
    }, now);
    return { ok: false, error: "entry_not_triggered", phase: "watching" };
  }

  const notional = Math.min(bucketToUsd(policy.max_notional_bucket), remainingDailyNotional(session));
  if (notional <= 0) {
    await appendEvent(state, session, "guardrail", "Daily notional cap is exhausted; no entry attempted.", {
      max_daily_notional_bucket: policy.max_daily_notional_bucket,
    }, now);
    return { ok: false, error: "daily_cap_exhausted" };
  }

  const instruction = instructionForVenue({ venue, product, side, price, notional, policy, now, env });
  const orderMarket = instruction.order?.market || product;
  instruction.mandate = {
    ...mandate,
    condition_proof: mintConditionProof({ session, mandate, venueId: instruction.venue_id, now }),
  };
  const workOrderCommitment = `level_entry_${digest({
    session: session.autopilot_session_id,
    venue,
    product,
    side,
    trigger: mandate.trigger_level,
    now: now.toISOString(),
  })}`;

  await appendEvent(state, session, "proposal", "Level trigger satisfied; bounded entry built with a satisfied condition proof.", {
    venue_id: instruction.venue_id,
    operation_class: instruction.operation_class,
    market: orderMarket,
    side,
    notional_bucket: String(notional),
    entry_trigger: mandate.entry_trigger,
    reason: entry.reason,
  }, now);

  // ---- Live submit gate (shared with the autopilot live flag) ----
  if (env.PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT !== "true") {
    if (directive.proved_once) {
      await persistDirective(state, session, directive, now);
      return { ok: false, error: "awaiting_live_submit", phase: "watching" };
    }
    let receipt;
    try {
      receipt = await verifyOrder({
        venue_id: instruction.venue_id,
        operation_class: instruction.operation_class,
        work_order_commitment: `${workOrderCommitment}_preflight`,
        policy_commitment: policy.policy_commitment,
        session_policy: workerSessionPolicy(session),
        instruction,
        execution: executionForVenue(session, venue),
        recipient,
        state,
      });
    } catch (error) {
      await appendEvent(state, session, "risk_reject", "Level-trigger no-submit verification failed.", {
        error: String(error?.code || error?.message || "no_submit_verification_failed"),
      }, now);
      return { ok: false, error: "no_submit_verification_failed" };
    }
    directive.proved_once = true;
    await persistDirective(state, session, directive, now);
    await appendEvent(state, session, "guardrail", "Live submit gate is disabled; entry proven without broadcasting.", {
      required_env: "PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT=true",
      execution_mode: "no_submit",
      broadcast_performed: false,
    }, now);
    await appendEvent(state, session, "receipt", "Level-trigger no-submit proof recorded.", {
      venue_id: instruction.venue_id,
      status: receipt.status,
      work_order_commitment: receipt.work_order_commitment,
      provider_ref_commitment: receipt.provider_ref_commitment,
      result_commitment: receipt.result_commitment,
      execution_mode: "no_submit",
      broadcast_performed: false,
    }, now);
    return { ok: true, mode: "no_submit", receipt };
  }

  let receipt;
  try {
    receipt = await executeOrder({
      venue_id: instruction.venue_id,
      operation_class: instruction.operation_class,
      work_order_commitment: workOrderCommitment,
      policy_commitment: policy.policy_commitment,
      session_policy: workerSessionPolicy(session),
      instruction,
      execution: executionForVenue(session, venue),
      recipient,
      state,
    });
  } catch (error) {
    await appendEvent(state, session, "risk_reject", "Level-trigger entry submission failed; no position opened.", {
      venue_id: instruction.venue_id,
      error: String(error?.code || error?.message || "entry_submit_failed"),
    }, now);
    await persistDirective(state, session, directive, now);
    return { ok: false, error: "entry_submit_failed" };
  }

  const stored = await state.getAutopilotSession(session.autopilot_session_id) || session;
  directive.phase = "in_position";
  directive.entry_filled = true;
  directive.entry_price = price;
  directive.entry_notional = notional;
  directive.entry_at = now.toISOString();
  directive.deadline_at = deadlineFor(mandate, now);
  stored.directive = directive;
  stored.order_count = Number(stored.order_count || 0) + 1;
  stored.last_execution_at = now.toISOString();
  stored.daily_notional_used_bucket = String(
    Math.min(bucketToUsd(stored.session_policy.max_daily_notional_bucket),
      Number(stored.daily_notional_used_bucket || 0) + notional),
  );
  stored.updated_at = now.toISOString();
  await state.putAutopilotSession(stored);

  await appendEvent(state, stored, "execution", "Level-trigger submitted a bounded live entry.", {
    venue_id: instruction.venue_id,
    operation_class: instruction.operation_class,
    market: orderMarket,
    side,
    notional_bucket: String(notional),
    work_order_commitment: workOrderCommitment,
  }, now);
  await appendEvent(state, stored, "live_order_submitted", "Worker submitted the bounded level-trigger entry.", {
    venue_id: instruction.venue_id,
    operation_class: instruction.operation_class,
    market: orderMarket,
    side,
    notional_bucket: String(notional),
    entry_trigger: mandate.entry_trigger,
    work_order_commitment: workOrderCommitment,
  }, now);
  await appendEvent(state, stored, "receipt", "Venue receipt recorded for level-trigger entry.", {
    venue_id: instruction.venue_id,
    status: receipt.status,
    work_order_commitment: receipt.work_order_commitment,
    provider_ref_commitment: receipt.provider_ref_commitment,
    result_commitment: receipt.result_commitment,
    final_proof: receipt.final_proof || null,
  }, now);
  const position = await state.putAutopilotPosition(session.autopilot_session_id, {
    venue_id: instruction.venue_id,
    market: orderMarket,
    side,
    estimated_exposure_notional_usd: notional,
    last_order_notional_usd: notional,
    last_work_order_commitment: workOrderCommitment,
    source: "level_trigger_entry_receipt",
  });
  await appendEvent(state, stored, "venue_reconcile", "Level-trigger entry reconciled; monitoring stop and horizon.", {
    venue_id: instruction.venue_id,
    status: receipt.status,
    position: publicPosition(position),
    invalidation_level: mandate.invalidation_level || null,
    deadline_at: directive.deadline_at,
  }, now);
  return { ok: true, phase: "in_position", receipt };
}

async function runExit({ session, state, recipient, now, env, venue, product, side, price, mandate, directive, reason, appendEvent, executeOrder }) {
  const exitSide = side === "buy" ? "sell" : "buy";
  const notional = Number(directive.entry_notional) > 0
    ? Number(directive.entry_notional)
    : bucketToUsd(session.session_policy.max_notional_bucket);
  const instruction = instructionForVenue({ venue, product, side: exitSide, price, notional, policy: session.session_policy, now, env });
  if (instruction.order) instruction.order.reduce_only = true;
  const orderMarket = instruction.order?.market || product;
  const workOrderCommitment = `level_exit_${digest({
    session: session.autopilot_session_id,
    venue,
    product,
    reason,
    now: now.toISOString(),
  })}`;

  const liveSubmit = env.PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT === "true";
  let receipt = null;
  if (liveSubmit) {
    try {
      receipt = await executeOrder({
        venue_id: instruction.venue_id,
        operation_class: instruction.operation_class,
        work_order_commitment: workOrderCommitment,
        policy_commitment: session.session_policy.policy_commitment,
        session_policy: workerSessionPolicy(session),
        instruction,
        execution: executionForVenue(session, venue),
        recipient,
        state,
      });
    } catch (error) {
      await appendEvent(state, session, "risk_reject", "Level-trigger exit submission failed; position requires manual review.", {
        reason,
        error: String(error?.code || error?.message || "exit_failed"),
      }, now);
      const flagged = { ...session, status: "paused", execution_enabled: false, updated_at: now.toISOString() };
      flagged.directive = { ...directive, phase: "exit_failed" };
      await state.putAutopilotSession(flagged);
      return { ok: false, error: "exit_failed", reason };
    }
  }

  const stored = await state.getAutopilotSession(session.autopilot_session_id) || session;
  directive.phase = "done";
  directive.exit_reason = reason;
  directive.exit_at = now.toISOString();
  stored.directive = directive;
  stored.status = "done";
  stored.execution_enabled = false;
  stored.next_step = reason === "invalidation_level"
    ? "Stop hit. Plan closed; create a new plan to arm another agent."
    : "Plan completed. Create a new plan to arm another agent.";
  if (liveSubmit) {
    stored.order_count = Number(stored.order_count || 0) + 1;
    stored.last_execution_at = now.toISOString();
  }
  stored.updated_at = now.toISOString();
  await state.putAutopilotSession(stored);

  await appendEvent(state, stored, liveSubmit ? "live_order_submitted" : "guardrail",
    liveSubmit ? "Worker submitted the bounded level-trigger exit." : "Exit condition met but live submit is disabled; plan closed without broadcasting.", {
    venue_id: instruction.venue_id,
    operation_class: instruction.operation_class,
    market: orderMarket,
    side: exitSide,
    notional_bucket: String(notional),
    reason,
    work_order_commitment: workOrderCommitment,
    broadcast_performed: liveSubmit,
  }, now);
  if (receipt) {
    await appendEvent(state, stored, "receipt", "Venue receipt recorded for level-trigger exit.", {
      venue_id: instruction.venue_id,
      status: receipt.status,
      work_order_commitment: receipt.work_order_commitment,
      provider_ref_commitment: receipt.provider_ref_commitment,
      result_commitment: receipt.result_commitment,
    }, now);
  }
  await appendEvent(state, stored, "session_state", `Level-trigger plan closed (${reason}).`, { reason }, now);
  return { ok: true, phase: "done", reason, receipt };
}

function normalizeDirective(directive, side, now) {
  if (directive && typeof directive === "object") {
    return {
      phase: directive.phase || "watching",
      side: directive.side || side,
      broke: directive.broke === true,
      swept: directive.swept === true,
      proved_once: directive.proved_once === true,
      entry_filled: directive.entry_filled === true,
      entry_price: directive.entry_price ?? null,
      entry_notional: directive.entry_notional ?? null,
      entry_at: directive.entry_at || null,
      deadline_at: directive.deadline_at || null,
      armed_at: directive.armed_at || now.toISOString(),
      exit_reason: directive.exit_reason || null,
      exit_at: directive.exit_at || null,
    };
  }
  return {
    phase: "watching",
    side,
    broke: false,
    swept: false,
    proved_once: false,
    entry_filled: false,
    entry_price: null,
    entry_notional: null,
    entry_at: null,
    deadline_at: null,
    armed_at: now.toISOString(),
    exit_reason: null,
    exit_at: null,
  };
}

async function persistDirective(state, session, directive, now) {
  const stored = await state.getAutopilotSession(session.autopilot_session_id) || session;
  stored.directive = directive;
  stored.last_tick_at = now.toISOString();
  stored.updated_at = now.toISOString();
  await state.putAutopilotSession(stored);
}

function mintConditionProof({ session, mandate, venueId, now }) {
  // Market is intentionally omitted: the order market is already bound by the
  // session policy allowlist, and venue order symbols (e.g. mint-derived swap
  // markets) do not round-trip cleanly against the drawn product id.
  return {
    status: "satisfied",
    proof_id: `lvlproof_${digest({ session: session.autopilot_session_id, now: now.toISOString(), nonce: randomUUID() }).slice(0, 24)}`,
    strategy_profile: mandate.strategy_profile,
    entry_trigger: mandate.entry_trigger,
    venue_id: venueId,
    checked_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 90_000).toISOString(),
    evidence_commitment: `lvltrig_${digest({ session: session.autopilot_session_id, trigger: mandate.trigger_level, now: now.toISOString() }).slice(0, 40)}`,
    exit_rule_supported: true,
  };
}

function deadlineFor(mandate, now) {
  const horizon = mandate.time_horizon || "scalp";
  const ms = Object.prototype.hasOwnProperty.call(HORIZON_MS, horizon) ? HORIZON_MS[horizon] : HORIZON_MS.scalp;
  if (!ms) return null;
  return new Date(now.getTime() + ms).toISOString();
}

function bandFraction(mandate) {
  const bps = Number(mandate.edge_threshold_bps);
  const effective = Number.isFinite(bps) && bps > 0 ? bps : DEFAULT_BAND_BPS;
  return effective / 10_000;
}

async function marketPrice({ product, env, fetchImpl, now }) {
  if (env.PRIVATE_AGENT_AUTOPILOT_SIGNAL_MODE === "force") {
    const price = Number(env.PRIVATE_AGENT_AUTOPILOT_FORCE_PRICE || "100");
    return { product_id: product, price, mid: price, live_status: "forced", stale: !(price > 0) };
  }
  const url = `https://api.coinbase.com/api/v3/brokerage/market/products/${encodeURIComponent(product)}`;
  const response = await fetchImpl(url, { cache: "no-store", headers: { "cache-control": "no-cache" } });
  if (!response.ok) throw new Error(`market_snapshot_${response.status}`);
  const body = await response.json();
  const price = numberValue(body.price || body.mid_market_price || body.pricebook?.best_bid);
  return { product_id: product, price, mid: price, live_status: "live", stale: !(Number(price) > 0) };
}

// Pure instruction builder, exported for tests: the hyperliquid order mode
// must track the worker's configured live mode (see comment below).
export function instructionForVenue({ venue, product, side, price, notional, policy, now, env = process.env }) {
  const expiresAt = new Date(now.getTime() + Math.min(5 * 60_000, policy.ttl_ms)).toISOString();
  if (venue === "jupiter") {
    const inputMint = side === "buy" ? USDC_MINT : SOL_MINT;
    const outputMint = side === "buy" ? SOL_MINT : USDC_MINT;
    const amount = side === "buy"
      ? String(Math.max(1, Math.floor(notional * 1_000_000)))
      : String(Math.max(1, Math.floor((notional / price) * 1_000_000_000)));
    return {
      version: 1,
      kind: "ghola_private_execution_instruction",
      venue_id: "jupiter",
      operation_class: "swap",
      expires_at: expiresAt,
      order: {
        input_mint: inputMint,
        output_mint: outputMint,
        amount,
        quote_size: String(notional),
        max_slippage_bps: String(policy.max_slippage_bps),
        routing_mode: "meta_aggregator",
      },
    };
  }
  if (venue === "coinbase_advanced") {
    return {
      version: 1,
      kind: "ghola_private_execution_instruction",
      venue_id: venue,
      operation_class: "spot_market_order",
      expires_at: expiresAt,
      order: {
        market: product,
        side,
        quote_size: String(notional),
        order_type: "market",
        size_mode: "quote",
        tif: "ioc",
      },
    };
  }
  const limit = side === "buy"
    ? price * (1 + policy.max_slippage_bps / 10_000)
    : price * (1 - policy.max_slippage_bps / 10_000);
  const order = {
    market: venueMarketSymbol(venue, product),
    side,
    quote_size: String(notional),
    limit_price: trim(limit),
    order_type: "market",
    size_mode: "quote",
    live_order_mode: "tiny_fill",
    max_slippage_bps: String(policy.max_slippage_bps),
    tif: "Ioc",
  };
  // A tiny_fill-marked order is hard-capped at $50/order by policy even on a
  // full_ticket worker; on full_ticket, omit the marker so the configured
  // full-ticket caps ($1k/order · $5k/day launch gates) govern instead.
  if (venue === "hyperliquid" && env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE === "full_ticket") {
    delete order.live_order_mode;
  }
  return {
    version: 1,
    kind: "ghola_private_execution_instruction",
    venue_id: venue,
    operation_class: venue === "hyperliquid" ? "limit_order" : "perp_limit_order",
    expires_at: expiresAt,
    order,
  };
}

function executionForVenue(session, venue) {
  const access = session.venue_access?.[venue] || {};
  const execution = {
    execution_mode: access.execution_mode || defaultExecutionMode(venue),
    vault_commitment: access.vault_commitment || undefined,
    encrypted_vault_commitment: access.encrypted_vault_commitment || undefined,
    encrypted_execution_vault: access.encrypted_execution_vault || undefined,
    allocation_commitment: access.allocation_commitment || undefined,
    managed_allocation_commitment: access.managed_allocation_commitment || undefined,
    omnibus_allocation: access.omnibus_allocation || undefined,
    autopilot_session_id: session.autopilot_session_id,
  };
  if (venue === "hyperliquid" && access.allocation_commitment && !execution.managed_allocation_commitment) {
    execution.managed_allocation_commitment = access.allocation_commitment;
  }
  return execution;
}

function workerSessionPolicy(session) {
  const policy = session.session_policy;
  return {
    policy_commitment: policy.policy_commitment,
    strategy_id: policy.strategy_id,
    venue_allowlist: policy.venue_allowlist,
    market_allowlist: policy.market_allowlist,
    max_notional_bucket: policy.max_notional_bucket,
    max_position_notional_bucket: policy.max_position_notional_bucket,
    max_daily_notional_bucket: policy.max_daily_notional_bucket,
    max_order_count: policy.max_order_count,
    max_slippage_bps: policy.max_slippage_bps,
    allowed_order_types: policy.allowed_order_types,
    kill_switch: policy.kill_switch === true || session.status === "killed",
    expires_at: session.expires_at,
  };
}

function readyVenues(session) {
  return session.session_policy.venue_allowlist
    .filter((venue) => session.venue_access?.[venue]?.status === "ready");
}

function primaryProduct(policy) {
  const markets = (policy.market_allowlist || []).map(normalizeMarket);
  const product = markets.find((market) => market.endsWith("-USD")) || markets[0] || "SOL-USD";
  return ["BTC-USD", "ETH-USD", "SOL-USD"].includes(product) ? product : "SOL-USD";
}

function publicPosition(position) {
  return {
    venue_id: position.venue_id || null,
    market: position.market || null,
    side: position.side || null,
    estimated_exposure_notional_bucket: String(position.estimated_exposure_notional_usd ?? position.notional_usd ?? "0"),
    last_order_notional_bucket: String(position.last_order_notional_usd ?? "0"),
    last_work_order_commitment: position.last_work_order_commitment || null,
    source: position.source || "level_trigger_state",
    updated_at: position.updated_at || null,
  };
}

function normalizeMarket(value) {
  const upper = String(value || "").trim().toUpperCase();
  if (upper === "SOL" || upper === "SOLANA" || upper === "SOL/USDC" || upper === "SOL-USDC") return "SOL-USD";
  if (upper === "BTC" || upper === "BITCOIN") return "BTC-USD";
  if (upper === "ETH" || upper === "ETHEREUM") return "ETH-USD";
  return upper;
}

function baseMarket(productId) {
  return String(productId || "SOL-USD").split("-")[0].split("/")[0].toUpperCase();
}

function venueMarketSymbol(venue, productId) {
  const base = baseMarket(productId);
  if (venue === "phoenix") return `${base}-PERP`;
  if (venue === "backpack") return `${base}_USDC_PERP`;
  return base;
}

function defaultExecutionMode(venue) {
  if (venue === "coinbase_advanced") return "partner_omnibus";
  return "ghola_pooled";
}

function remainingDailyNotional(session) {
  return Math.max(0, bucketToUsd(session.session_policy.max_daily_notional_bucket) - Number(session.daily_notional_used_bucket || 0));
}

function bucketToUsd(value) {
  const number = Number.parseFloat(String(value || "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function numberValue(value) {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function trim(value) {
  return Number(value).toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 48);
}
