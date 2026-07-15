import bs58 from "bs58";
import { didKeyFromVerifying, RecipientKind, seal } from "./envelope";
import {
  chooseConfidentialComputeProvider,
  providerReadyForPrivateAgents,
  type ConfidentialComputeProviderStatus,
  type PrivateAgentRuntimeStatus,
} from "./private-agent-runtime";
import { fetchPrivateAgentRuntimeStatus } from "./hyperliquid-vault-seal";

export type PrivateExecutionVenueId = "hyperliquid" | "coinbase_advanced" | "phoenix" | "jupiter";
export type PrivateExecutionOperationClass =
  | "limit_order"
  | "perp_limit_order"
  | "spot_limit_order"
  | "spot_market_order"
  | "preview_order"
  | "swap"
  | "cancel"
  | "reconcile";

export interface PrivateExecutionOrderDraft {
  venue_id: PrivateExecutionVenueId;
  operation_class: PrivateExecutionOperationClass;
  market: string;
  side: "buy" | "sell";
  base_size: string;
  limit_price: string;
  quote_size?: string;
  max_slippage_bps?: string;
  live_order_mode?: "tiny_fill";
  order_type?: "market" | "limit";
  size_mode?: "base" | "quote";
  post_only?: boolean;
  reduce_only?: boolean;
  tif?: "Gtc" | "Ioc" | "Alo" | "gtc" | "ioc" | "fok";
  input_mint?: string;
  output_mint?: string;
  amount?: string;
  routing_mode?: "meta_aggregator" | "router";
  agent_strategy_profile?:
    | "trend_following"
    | "breakout"
    | "reversal"
    | "momentum_continuation"
    | "breakout_retest"
    | "sweep_reclaim"
    | "mean_reversion"
    | "range_trade"
    | "funding_basis"
    | "funding_mark_divergence"
    | "venue_route_edge"
    | "custom";
  agent_entry_trigger?:
    | "preview_now"
    | "break_level"
    | "retest_level"
    | "sweep_reclaim"
    | "book_imbalance"
    | "funding_mark_divergence"
    | "route_edge_threshold"
    | "custom";
  agent_exit_rule?:
    | "manual_approval"
    | "take_profit_stop"
    | "trail_after_profit"
    | "exit_on_invalidation"
    | "time_stop"
    | "reduce_on_risk_flip";
  agent_time_horizon?: "scalp" | "session_trade" | "intraday" | "until_invalidated" | "custom_window";
  agent_trigger_level?: string;
  agent_invalidation_level?: string;
  agent_edge_threshold_bps?: string;
  agent_time_window?: string;
  agent_range_low?: string;
  agent_range_high?: string;
  agent_route_priority?: "best_price" | "fastest" | "most_private";
  agent_strategy_note?: string;
}

interface PrivateExecutionAgentMandate {
  version: 1;
  strategy_profile: NonNullable<PrivateExecutionOrderDraft["agent_strategy_profile"]>;
  entry_trigger: NonNullable<PrivateExecutionOrderDraft["agent_entry_trigger"]>;
  exit_rule: NonNullable<PrivateExecutionOrderDraft["agent_exit_rule"]>;
  time_horizon: NonNullable<PrivateExecutionOrderDraft["agent_time_horizon"]>;
  enforcement: "fail_closed_without_condition_proof";
  trigger_level?: string;
  invalidation_level?: string;
  edge_threshold_bps?: string;
  time_window?: string;
  range_low?: string;
  range_high?: string;
  route_priority?: NonNullable<PrivateExecutionOrderDraft["agent_route_priority"]>;
  strategy_note?: string;
}

export interface PrivateExecutionInstructionBundle {
  alg: "sealed-provider-v1";
  ciphertext: string;
  recipient: string;
  aad: string;
}

export interface BuildPrivateExecutionInstructionBundleOptions {
  ownerWalletAddress: string;
  previewCommitment: string;
  workOrderCommitment?: string | null;
  order: PrivateExecutionOrderDraft;
  signBytes: (bytes: Uint8Array) => Promise<Uint8Array>;
  runtimeStatus?: PrivateAgentRuntimeStatus;
  fetchRuntimeStatus?: () => Promise<PrivateAgentRuntimeStatus>;
  now?: Date;
  ttlMs?: number;
}

export interface BuildPrivateExecutionInstructionBundleResult {
  encrypted_execution_instruction_bundle: PrivateExecutionInstructionBundle;
  recipient: ConfidentialComputeProviderStatus["sealed_recipient"];
  associated_data: string;
}

const MARKET_RE = /^[A-Za-z0-9/_:-]{2,32}$/;
const DECIMAL_RE = /^\d+(?:\.\d+)?$/;
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const AGENT_STRATEGY_PROFILE_VALUES = new Set([
  "trend_following",
  "breakout",
  "reversal",
  "momentum_continuation",
  "breakout_retest",
  "sweep_reclaim",
  "mean_reversion",
  "range_trade",
  "funding_basis",
  "funding_mark_divergence",
  "venue_route_edge",
  "custom",
]);
const AGENT_ROUTE_PRIORITY_VALUES = new Set(["best_price", "fastest", "most_private"]);
const AGENT_ENTRY_TRIGGER_VALUES = new Set([
  "preview_now",
  "break_level",
  "retest_level",
  "sweep_reclaim",
  "book_imbalance",
  "funding_mark_divergence",
  "route_edge_threshold",
  "custom",
]);
const AGENT_EXIT_RULE_VALUES = new Set([
  "manual_approval",
  "take_profit_stop",
  "trail_after_profit",
  "exit_on_invalidation",
  "time_stop",
  "reduce_on_risk_flip",
]);
const AGENT_TIME_HORIZON_VALUES = new Set([
  "scalp",
  "session_trade",
  "intraday",
  "until_invalidated",
  "custom_window",
]);

export function validatePrivateExecutionOrderDraft(draft: PrivateExecutionOrderDraft): string[] {
  const errors: string[] = [];
  if (
    draft.venue_id !== "hyperliquid" &&
    draft.venue_id !== "coinbase_advanced" &&
    draft.venue_id !== "phoenix" &&
    draft.venue_id !== "jupiter"
  ) {
    errors.push("Select a supported venue.");
  }
  errors.push(...validatePrivateExecutionAgentMandate(draft));
  if (draft.venue_id === "jupiter") {
    if (draft.operation_class !== "swap") errors.push("Jupiter only supports private swap instructions.");
    if (!SOLANA_ADDRESS_RE.test(draft.input_mint?.trim() || "")) errors.push("Select a valid input mint.");
    if (!SOLANA_ADDRESS_RE.test(draft.output_mint?.trim() || "")) errors.push("Select a valid output mint.");
    if ((draft.input_mint?.trim() || "") === (draft.output_mint?.trim() || "")) {
      errors.push("Input and output mints must differ.");
    }
    if (!/^\d+$/.test(draft.amount?.trim() || "") || Number(draft.amount) <= 0) {
      errors.push("Enter a Jupiter amount in base units.");
    }
    if (!DECIMAL_RE.test(draft.quote_size?.trim() || "") || Number(draft.quote_size) <= 0) {
      errors.push("Enter a notional bucket amount greater than 0.");
    }
    const slippageBps = draft.max_slippage_bps?.trim() || "50";
    if (!/^\d+$/.test(slippageBps) || Number(slippageBps) < 1 || Number(slippageBps) > 500) {
      errors.push("Set Jupiter slippage between 1 and 500 bps.");
    }
    if (draft.routing_mode && draft.routing_mode !== "meta_aggregator" && draft.routing_mode !== "router") {
      errors.push("Select a valid Jupiter routing mode.");
    }
    return errors;
  }
  if (!MARKET_RE.test(draft.market.trim())) {
    errors.push("Enter a market such as BTC, ETH, BTC-USD, or ETH-USD.");
  }
  if (draft.side !== "buy" && draft.side !== "sell") {
    errors.push("Select buy or sell.");
  }
  const tinyFill =
    (draft.venue_id === "hyperliquid" || draft.venue_id === "phoenix") &&
    draft.live_order_mode === "tiny_fill";
  const orderType = draft.order_type || (tinyFill ? "market" : "limit");
  const sizeMode = draft.size_mode || (draft.quote_size ? "quote" : "base");
  if (tinyFill) {
    const quoteSize = draft.quote_size?.trim() || "";
    const slippageBps = draft.max_slippage_bps?.trim() || "50";
    if (!DECIMAL_RE.test(quoteSize) || Number(quoteSize) <= 0) {
      errors.push("Enter a live order amount greater than $0.");
    } else if (Number(quoteSize) > 25) {
      errors.push("Live orders are capped at $25.");
    }
    if (draft.venue_id === "hyperliquid" && (!/^\d+$/.test(slippageBps) || Number(slippageBps) < 1 || Number(slippageBps) > 100)) {
      errors.push("Set slippage between 1 and 100 bps.");
    }
    if (
      draft.venue_id === "phoenix" &&
      (!DECIMAL_RE.test(draft.limit_price.trim()) || Number(draft.limit_price) <= 0)
    ) {
      errors.push("Enter a Phoenix price limit greater than 0.");
    }
  } else {
    if (orderType !== "market" && orderType !== "limit") {
      errors.push("Select market or limit order.");
    }
    if (draft.post_only && orderType === "market") {
      errors.push("Post-only orders must be limit orders.");
    }
    if (
      draft.venue_id === "phoenix" &&
      orderType === "market" &&
      (!DECIMAL_RE.test(draft.limit_price.trim()) || Number(draft.limit_price) <= 0)
    ) {
      errors.push("Enter a Phoenix market price limit greater than 0.");
    }
    if (!DECIMAL_RE.test(draft.base_size.trim()) || Number(draft.base_size) <= 0) {
      if (sizeMode === "base") errors.push("Enter a base size greater than 0.");
    }
    if (sizeMode === "quote") {
      const quoteSize = draft.quote_size?.trim() || "";
      if (!DECIMAL_RE.test(quoteSize) || Number(quoteSize) <= 0) {
        errors.push("Enter a USD amount greater than 0.");
      }
    }
    if (
      orderType !== "market" &&
      draft.operation_class !== "spot_market_order" &&
      (!DECIMAL_RE.test(draft.limit_price.trim()) || Number(draft.limit_price) <= 0)
    ) {
      errors.push("Enter a limit price greater than 0.");
    }
  }
  return errors;
}

function validatePrivateExecutionAgentMandate(draft: PrivateExecutionOrderDraft): string[] {
  if (!hasAgentMandateFields(draft)) return [];
  const errors: string[] = [];
  const strategyProfile = draft.agent_strategy_profile || "trend_following";
  const entryTrigger = draft.agent_entry_trigger || "preview_now";
  const exitRule = draft.agent_exit_rule || "manual_approval";
  const timeHorizon = draft.agent_time_horizon || "scalp";
  const triggerLevel = draft.agent_trigger_level?.trim() || "";
  const invalidationLevel = draft.agent_invalidation_level?.trim() || "";
  const edgeThresholdBps = draft.agent_edge_threshold_bps?.trim() || "";
  const timeWindow = draft.agent_time_window?.trim() || "";
  const rangeLow = draft.agent_range_low?.trim() || "";
  const rangeHigh = draft.agent_range_high?.trim() || "";
  const routePriority = draft.agent_route_priority?.trim() || "";
  const note = draft.agent_strategy_note?.trim() || "";

  if (!AGENT_STRATEGY_PROFILE_VALUES.has(strategyProfile)) {
    errors.push("Select a supported agent strategy.");
  }
  if (!AGENT_ENTRY_TRIGGER_VALUES.has(entryTrigger)) {
    errors.push("Select a supported agent entry trigger.");
  }
  if (!AGENT_EXIT_RULE_VALUES.has(exitRule)) {
    errors.push("Select a supported agent exit rule.");
  }
  if (!AGENT_TIME_HORIZON_VALUES.has(timeHorizon)) {
    errors.push("Select a supported agent horizon.");
  }
  if (routePriority && !AGENT_ROUTE_PRIORITY_VALUES.has(routePriority)) {
    errors.push("Select a supported route priority.");
  }
  if (note.length > 240) {
    errors.push("Keep the sealed agent rule under 240 characters.");
  }

  if (needsAgentTriggerLevel(entryTrigger)) {
    if (!DECIMAL_RE.test(triggerLevel) || Number(triggerLevel) <= 0) {
      errors.push("Enter the agent trigger level.");
    }
  } else if (triggerLevel && (!DECIMAL_RE.test(triggerLevel) || Number(triggerLevel) <= 0)) {
    errors.push("Agent trigger level must be a positive number.");
  }

  if (needsAgentEdgeThreshold(strategyProfile, entryTrigger)) {
    if (!/^\d+$/.test(edgeThresholdBps) || Number(edgeThresholdBps) < 1 || Number(edgeThresholdBps) > 500) {
      errors.push("Set the agent edge threshold between 1 and 500 bps.");
    }
  } else if (edgeThresholdBps && (!/^\d+$/.test(edgeThresholdBps) || Number(edgeThresholdBps) < 1 || Number(edgeThresholdBps) > 500)) {
    errors.push("Agent edge threshold must be between 1 and 500 bps.");
  }

  if (needsAgentInvalidationLevel(strategyProfile, exitRule)) {
    if (!DECIMAL_RE.test(invalidationLevel) || Number(invalidationLevel) <= 0) {
      errors.push("Enter the agent invalidation level.");
    }
  } else if (invalidationLevel && (!DECIMAL_RE.test(invalidationLevel) || Number(invalidationLevel) <= 0)) {
    errors.push("Agent invalidation level must be a positive number.");
  }

  if (needsAgentTimeWindow(timeHorizon, exitRule)) {
    if (!timeWindow || timeWindow.length > 64) {
      errors.push("Enter a short agent time window.");
    }
  } else if (timeWindow.length > 64) {
    errors.push("Keep the agent time window under 64 characters.");
  }

  if (strategyProfile === "range_trade") {
    if (!DECIMAL_RE.test(rangeLow) || Number(rangeLow) <= 0) {
      errors.push("Enter the range low.");
    }
    if (!DECIMAL_RE.test(rangeHigh) || Number(rangeHigh) <= 0) {
      errors.push("Enter the range high.");
    }
    if (DECIMAL_RE.test(rangeLow) && DECIMAL_RE.test(rangeHigh) && Number(rangeLow) >= Number(rangeHigh)) {
      errors.push("Range low must be below range high.");
    }
  } else {
    if (rangeLow && (!DECIMAL_RE.test(rangeLow) || Number(rangeLow) <= 0)) {
      errors.push("Range low must be a positive number.");
    }
    if (rangeHigh && (!DECIMAL_RE.test(rangeHigh) || Number(rangeHigh) <= 0)) {
      errors.push("Range high must be a positive number.");
    }
  }

  if ((strategyProfile === "custom" || entryTrigger === "custom") && note.length < 8) {
    errors.push("Describe the custom agent rule.");
  }

  return errors;
}

export async function buildPrivateExecutionInstructionBundle(
  options: BuildPrivateExecutionInstructionBundleOptions,
): Promise<BuildPrivateExecutionInstructionBundleResult> {
  const errors = validatePrivateExecutionOrderDraft(options.order);
  if (errors.length > 0) throw new Error(errors[0]);
  if (!options.previewCommitment.trim() && !options.workOrderCommitment?.trim()) {
    throw new Error("A preview or work-order commitment is required.");
  }
  const runtime = options.runtimeStatus ??
    await (options.fetchRuntimeStatus ?? fetchPrivateAgentRuntimeStatus)();
  const provider = selectedReadyProvider(runtime);
  const recipient = provider?.sealed_recipient;
  if (!recipient) throw new Error("Attested private-agent recipient is unavailable.");
  const recipientX25519 = hexToBytes(recipient.x25519_pub_hex);
  if (recipientX25519.length !== 32) throw new Error("Attested private-agent recipient key is invalid.");
  const ownerDid = solanaAddressToDid(options.ownerWalletAddress);
  if (!ownerDid) throw new Error("Turnkey wallet identity is unavailable.");

  const associatedData = privateExecutionInstructionAssociatedData({
    previewCommitment: options.previewCommitment,
    workOrderCommitment: options.workOrderCommitment || null,
    venueId: options.order.venue_id,
    recipientId: recipient.recipient_id,
  });
  const expiresAt = new Date((options.now ?? new Date()).getTime() + (options.ttlMs ?? 5 * 60 * 1000));
  const order = options.order.venue_id === "jupiter"
    ? {
        market: normalizeMarket(options.order.market || "SOL/USDC", options.order.venue_id),
        side: "buy" as const,
        input_mint: options.order.input_mint?.trim(),
        output_mint: options.order.output_mint?.trim(),
        amount: options.order.amount?.trim(),
        quote_size: options.order.quote_size?.trim(),
        max_slippage_bps: options.order.max_slippage_bps?.trim() || "50",
        routing_mode: options.order.routing_mode || ("meta_aggregator" as const),
      }
    : {
        market: normalizeMarket(options.order.market, options.order.venue_id),
        side: options.order.side,
        ...(options.order.live_order_mode === "tiny_fill"
          ? {
              quote_size: options.order.quote_size?.trim(),
              ...(options.order.venue_id === "hyperliquid"
                ? { max_slippage_bps: options.order.max_slippage_bps?.trim() || "50" }
                : {}),
              ...(options.order.venue_id === "phoenix"
                ? { limit_price: options.order.limit_price.trim() }
                : {}),
              live_order_mode: "tiny_fill" as const,
              tif: "Ioc",
            }
          : {
              order_type: options.order.order_type || "limit",
              size_mode: options.order.size_mode || (options.order.quote_size ? "quote" : "base"),
              ...(options.order.base_size.trim() ? { base_size: options.order.base_size.trim() } : {}),
              ...(options.order.quote_size?.trim() ? { quote_size: options.order.quote_size.trim() } : {}),
          ...(options.order.order_type === "market" && options.order.venue_id !== "phoenix"
            ? {}
            : { limit_price: options.order.limit_price.trim() }),
              tif: options.order.tif || (options.order.venue_id === "coinbase_advanced" ? "gtc" : "Gtc"),
              post_only: options.order.post_only === true,
              reduce_only: options.order.reduce_only === true,
              ...(options.order.max_slippage_bps?.trim() ? { max_slippage_bps: options.order.max_slippage_bps.trim() } : {}),
            }),
      };
  const mandate = privateExecutionAgentMandate(options.order);
  const sealedPlaintext = {
    version: 1,
    kind: "ghola_private_execution_instruction",
    venue_id: options.order.venue_id,
    // Phoenix is a spot orderbook. The worker still accepts the historical
    // solana-perps alias while its internal connector contract migrates.
    operation_class: options.order.venue_id === "phoenix" && options.order.operation_class === "spot_limit_order"
      ? "perp_limit_order"
      : options.order.operation_class,
    expires_at: expiresAt.toISOString(),
    order,
    ...(mandate ? { mandate } : {}),
  };

  const sealedBytes = await seal({
    senderDid: ownerDid,
    recipientId: recipient.recipient_id,
    recipientX25519,
    kind: RecipientKind.ModelBridge,
    associatedData: new TextEncoder().encode(associatedData),
    plaintext: new TextEncoder().encode(JSON.stringify(sealedPlaintext)),
    signBody: options.signBytes,
  });

  return {
    recipient,
    associated_data: associatedData,
    encrypted_execution_instruction_bundle: {
      alg: "sealed-provider-v1",
      ciphertext: bytesToBase64(sealedBytes),
      recipient: recipient.recipient_id,
      aad: associatedData,
    },
  };
}

export function privateExecutionInstructionAssociatedData(input: {
  previewCommitment?: string | null;
  workOrderCommitment?: string | null;
  venueId: PrivateExecutionVenueId;
  recipientId: string;
}) {
  return [
    "ghola/private-execution-instruction-v1",
    input.workOrderCommitment?.trim()
      ? `work_order:${input.workOrderCommitment.trim()}`
      : `preview:${input.previewCommitment?.trim() || "pending"}`,
    `venue:${input.venueId}`,
    `recipient:${input.recipientId}`,
  ].join("|");
}

function normalizeMarket(market: string, venueId: PrivateExecutionVenueId) {
  const normalized = market.trim().toUpperCase();
  if (venueId === "coinbase_advanced" && !normalized.includes("-")) return `${normalized}-USD`;
  if (venueId === "hyperliquid" && normalized.includes("-")) return normalized.split("-")[0];
  if (venueId === "phoenix" && normalized.includes("-")) return normalized.split("-")[0];
  return normalized;
}

function privateExecutionAgentMandate(order: PrivateExecutionOrderDraft): PrivateExecutionAgentMandate | null {
  if (!hasAgentMandateFields(order)) return null;
  const mandate: PrivateExecutionAgentMandate = {
    version: 1,
    strategy_profile: order.agent_strategy_profile || "trend_following",
    entry_trigger: order.agent_entry_trigger || "preview_now",
    exit_rule: order.agent_exit_rule || "manual_approval",
    time_horizon: order.agent_time_horizon || "scalp",
    enforcement: "fail_closed_without_condition_proof",
  };
  const triggerLevel = order.agent_trigger_level?.trim();
  const invalidationLevel = order.agent_invalidation_level?.trim();
  const edgeThresholdBps = order.agent_edge_threshold_bps?.trim();
  const timeWindow = order.agent_time_window?.trim();
  const rangeLow = order.agent_range_low?.trim();
  const rangeHigh = order.agent_range_high?.trim();
  const routePriority = order.agent_route_priority;
  const note = order.agent_strategy_note?.trim();
  if (triggerLevel) mandate.trigger_level = triggerLevel;
  if (invalidationLevel) mandate.invalidation_level = invalidationLevel;
  if (edgeThresholdBps) mandate.edge_threshold_bps = edgeThresholdBps;
  if (timeWindow) mandate.time_window = timeWindow;
  if (rangeLow) mandate.range_low = rangeLow;
  if (rangeHigh) mandate.range_high = rangeHigh;
  if (routePriority) mandate.route_priority = routePriority;
  if (note) mandate.strategy_note = note;
  return mandate;
}

function hasAgentMandateFields(order: PrivateExecutionOrderDraft) {
  return Boolean(
    order.agent_strategy_profile ||
      order.agent_entry_trigger ||
      order.agent_exit_rule ||
      order.agent_time_horizon ||
      order.agent_trigger_level?.trim() ||
      order.agent_invalidation_level?.trim() ||
      order.agent_edge_threshold_bps?.trim() ||
      order.agent_time_window?.trim() ||
      order.agent_range_low?.trim() ||
      order.agent_range_high?.trim() ||
      order.agent_route_priority ||
      order.agent_strategy_note?.trim(),
  );
}

function needsAgentTriggerLevel(entryTrigger: string) {
  return entryTrigger === "break_level" || entryTrigger === "retest_level" || entryTrigger === "sweep_reclaim";
}

function needsAgentEdgeThreshold(strategyProfile: string, entryTrigger: string) {
  return (
    entryTrigger === "book_imbalance" ||
    entryTrigger === "funding_mark_divergence" ||
    entryTrigger === "route_edge_threshold" ||
    strategyProfile === "funding_basis" ||
    strategyProfile === "funding_mark_divergence" ||
    strategyProfile === "venue_route_edge"
  );
}

function needsAgentInvalidationLevel(strategyProfile: string, exitRule: string) {
  return (
    exitRule === "exit_on_invalidation" ||
    exitRule === "reduce_on_risk_flip" ||
    strategyProfile === "reversal" ||
    strategyProfile === "sweep_reclaim"
  );
}

function needsAgentTimeWindow(timeHorizon: string, exitRule: string) {
  return timeHorizon === "custom_window" || exitRule === "time_stop";
}

function selectedReadyProvider(
  runtime: PrivateAgentRuntimeStatus,
): ConfidentialComputeProviderStatus | null {
  const selected = runtime.selected_provider
    ? runtime.providers.find((provider) =>
        provider.id === runtime.selected_provider && providerReadyForPrivateAgents(provider)
      ) ?? null
    : null;
  return selected ?? chooseConfidentialComputeProvider(runtime.providers, runtime.preferred_provider);
}

function solanaAddressToDid(address: string): string | null {
  try {
    const pub = bs58.decode(address);
    if (pub.length !== 32) return null;
    return didKeyFromVerifying(pub);
  } catch {
    return null;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error("invalid hex");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
