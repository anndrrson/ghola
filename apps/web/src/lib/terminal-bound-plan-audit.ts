import {
  tradeOrderPlanMarketContextFresh,
  validateTradeOrderPlan,
  type TradeOrderPlan,
  type TradeOrderPlanBindingEnvelope,
} from "./trade-order-plan";

export type TerminalBoundPlanAuditStatus =
  | "unbound"
  | "active"
  | "inactive"
  | "changed"
  | "expired"
  | "market_stale"
  | "current_plan_unavailable";

export type TerminalBoundPlanAuditField =
  | "venue"
  | "network"
  | "product"
  | "side"
  | "notional"
  | "base_size"
  | "entry"
  | "slippage"
  | "risk_budget"
  | "all_in_loss"
  | "fee_assumption"
  | "buffer_assumption"
  | "invalidation"
  | "strategy"
  | "trigger"
  | "exit"
  | "horizon"
  | "trigger_level"
  | "interval"
  | "order_policy";

export interface TerminalBoundPlanAuditSnapshot {
  planDigest: string;
  issuedAt: string;
  expiresAt: string;
  orderPlan: TradeOrderPlan;
}

export interface TerminalBoundPlanDifference {
  field: TerminalBoundPlanAuditField;
  label: string;
  boundValue: string;
  currentValue: string;
}

export interface TerminalBoundPlanAudit {
  status: TerminalBoundPlanAuditStatus;
  snapshot: TerminalBoundPlanAuditSnapshot | null;
  differences: TerminalBoundPlanDifference[];
  expired: boolean;
  marketStale: boolean;
}

export function captureTerminalBoundPlanAudit(
  binding: TradeOrderPlanBindingEnvelope,
): TerminalBoundPlanAuditSnapshot | null {
  const validation = validateTradeOrderPlan(binding.order_plan, { requireFresh: false });
  if (!validation.ok || !/^sha256:[a-f0-9]{64}$/.test(binding.plan_digest)) return null;
  if (!canonicalIso(binding.issued_at) || !canonicalIso(binding.expires_at)) return null;
  if (Date.parse(binding.expires_at) <= Date.parse(binding.issued_at)) return null;
  return {
    planDigest: binding.plan_digest,
    issuedAt: binding.issued_at,
    expiresAt: binding.expires_at,
    orderPlan: clonePlan(validation.plan),
  };
}

export function terminalBoundPlanAuditEqual(
  left: TerminalBoundPlanAudit,
  right: TerminalBoundPlanAudit,
): boolean {
  if (
    left.status !== right.status
    || left.expired !== right.expired
    || left.marketStale !== right.marketStale
    || left.snapshot?.planDigest !== right.snapshot?.planDigest
    || left.snapshot?.issuedAt !== right.snapshot?.issuedAt
    || left.snapshot?.expiresAt !== right.snapshot?.expiresAt
    || left.differences.length !== right.differences.length
  ) return false;
  return left.differences.every((difference, index) => {
    const candidate = right.differences[index];
    return difference.field === candidate?.field
      && difference.boundValue === candidate.boundValue
      && difference.currentValue === candidate.currentValue;
  });
}

export function deriveTerminalBoundPlanAudit(input: {
  snapshot: TerminalBoundPlanAuditSnapshot | null;
  currentPlan: TradeOrderPlan | null;
  active: boolean;
  nowMs?: number;
}): TerminalBoundPlanAudit {
  if (!input.snapshot) {
    return { status: "unbound", snapshot: null, differences: [], expired: false, marketStale: false };
  }
  const nowMs = input.nowMs ?? Date.now();
  const expiresAtMs = Date.parse(input.snapshot.expiresAt);
  const expired = !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs;
  const marketStale = !tradeOrderPlanMarketContextFresh(input.snapshot.orderPlan, nowMs);
  const differences = input.currentPlan
    ? terminalBoundPlanDifferences(input.snapshot.orderPlan, input.currentPlan)
    : [];
  const status: TerminalBoundPlanAuditStatus = !input.currentPlan
    ? "current_plan_unavailable"
    : differences.length > 0
      ? "changed"
      : expired
        ? "expired"
        : marketStale
          ? "market_stale"
          : input.active
            ? "active"
            : "inactive";
  return { status, snapshot: input.snapshot, differences, expired, marketStale };
}

export function terminalBoundPlanDifferences(
  bound: TradeOrderPlan,
  current: TradeOrderPlan,
): TerminalBoundPlanDifference[] {
  const values: Array<[TerminalBoundPlanAuditField, string, string, string]> = [
    ["venue", "Venue", bound.venue_id, current.venue_id],
    ["network", "Network", bound.network, current.network],
    ["product", "Product", bound.product, current.product],
    ["side", "Side", bound.side, current.side],
    ["notional", "Order value", bound.quote_notional_usd, current.quote_notional_usd],
    ["base_size", "Base size", bound.base_size, current.base_size],
    ["entry", "Limit entry", bound.limit_price, current.limit_price],
    ["slippage", "Slippage", `${bound.max_slippage_bps} bp`, `${current.max_slippage_bps} bp`],
    ["risk_budget", "Loss budget", bound.risk_envelope?.risk_budget_usd ?? "legacy · unbound", current.risk_envelope?.risk_budget_usd ?? "legacy · unbound"],
    ["all_in_loss", "All-in loss", bound.risk_envelope?.all_in_loss_usd ?? "legacy · unbound", current.risk_envelope?.all_in_loss_usd ?? "legacy · unbound"],
    ["fee_assumption", "Fee assumption", costEvidenceValue(bound, "fee"), costEvidenceValue(current, "fee")],
    ["buffer_assumption", "Execution buffer", costEvidenceValue(bound, "buffer"), costEvidenceValue(current, "buffer")],
    ["invalidation", "Plan invalidation", bound.stop_intent.stop_level, current.stop_intent.stop_level],
    ["strategy", "Strategy", bound.agent_mandate.strategy_profile, current.agent_mandate.strategy_profile],
    ["trigger", "Entry trigger", bound.agent_mandate.entry_trigger, current.agent_mandate.entry_trigger],
    ["exit", "Exit rule", bound.agent_mandate.exit_rule, current.agent_mandate.exit_rule],
    ["horizon", "Horizon", bound.agent_mandate.time_horizon, current.agent_mandate.time_horizon],
    ["trigger_level", "Trigger level", bound.agent_mandate.trigger_level ?? "—", current.agent_mandate.trigger_level ?? "—"],
    ["interval", "Interval", bound.market_context.interval, current.market_context.interval],
    ["order_policy", "Order policy", policyValue(bound), policyValue(current)],
  ];
  return values
    .filter(([, , boundValue, currentValue]) => boundValue !== currentValue)
    .map(([field, label, boundValue, currentValue]) => ({ field, label, boundValue, currentValue }));
}

function policyValue(plan: TradeOrderPlan) {
  return `${plan.order_type.toUpperCase()} ${plan.time_in_force.toUpperCase()} · ${plan.execution_policy.reduce_only ? "reduce only" : "exposure"}`;
}

function costEvidenceValue(plan: TradeOrderPlan, field: "fee" | "buffer") {
  if (!plan.risk_envelope) return "legacy · unbound";
  const value = field === "fee" ? plan.risk_envelope.fee_bps : plan.risk_envelope.buffer_bps;
  const evidenceAt = field === "fee" ? plan.risk_envelope.fee_evidence_at : plan.risk_envelope.buffer_evidence_at;
  return `${value} bp${evidenceAt ? ` · ${evidenceAt}` : " · legacy time"}`;
}

function canonicalIso(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function clonePlan(plan: TradeOrderPlan): TradeOrderPlan {
  return {
    ...plan,
    stop_intent: { ...plan.stop_intent },
    agent_mandate: { ...plan.agent_mandate },
    execution_policy: { ...plan.execution_policy },
    ...(plan.risk_envelope ? { risk_envelope: { ...plan.risk_envelope } } : {}),
    market_context: { ...plan.market_context },
  };
}
