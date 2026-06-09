export type TradingPlatformClass =
  | "hyperliquid_style_market"
  | "solana_perps_market"
  | "solana_swap_aggregator"
  | "coinbase_style_provider";

export type TradingActionKind =
  | "idle"
  | "sign_in"
  | "use_phoenix_vault"
  | "connect_phoenix_byo"
  | "arm_phoenix"
  | "verify_phoenix"
  | "use_jupiter_vault"
  | "connect_jupiter_byo"
  | "arm_jupiter"
  | "verify_jupiter"
  | "use_hyperliquid_vault"
  | "connect_hyperliquid_byo"
  | "arm_hyperliquid"
  | "verify_hyperliquid"
  | "allocate_coinbase_omnibus"
  | "connect_coinbase_byo"
  | "arm_coinbase"
  | "verify_coinbase"
  | "preview"
  | "place_trade"
  | "accept_visibility"
  | "wait_for_privacy"
  | "blocked";

export type TradingActionTone = "primary" | "success" | "warn" | "danger" | "neutral";
export type TradingStatusTone = "good" | "warn" | "bad" | "neutral";

export interface TradingNextAction {
  kind: TradingActionKind;
  label: string;
  description: string;
  tone: TradingActionTone;
  disabled?: boolean;
  secondary?: TradingNextAction;
}

export type VenueStepStatus = "done" | "current" | "pending" | "warn" | "blocked";

export interface VenueReadinessStep {
  id: "venue" | "access" | "guardrails" | "privacy" | "submit";
  label: string;
  value: string;
  status: VenueStepStatus;
}

export interface MarketFeedFreshnessInput {
  status?: string | null;
  fetchedAt?: string | null;
  stale?: boolean | null;
  nowMs?: number;
}

export interface MarketFeedFreshness {
  label: string;
  tone: TradingStatusTone;
}

export type OrderTicketField = "size" | "price" | "slippage";
export type OrderTicketStatusLabel = "Needs fields" | "Ready" | "Checked";
export type LiveTradingVenue = "hyperliquid" | "phoenix" | "jupiter" | "coinbase";
export type LiveReadinessStatus =
  | "signed_out"
  | "connect_account"
  | "use_with_ghola"
  | "market_stale"
  | "worker_unavailable"
  | "needs_funds"
  | "check_connection"
  | "ready_to_preview"
  | "ready_to_place_capped_trade"
  | "live_submit_locked"
  | "blocked";

export interface OrderTicketDisplayState {
  statusLabel: OrderTicketStatusLabel;
  statusTone: TradingStatusTone;
  fieldHints: Partial<Record<OrderTicketField, string[]>>;
  generalHints: string[];
  primaryBlockerText?: string;
}

export interface LiveReadinessDisplayState {
  venue: LiveTradingVenue;
  venueLabel: string;
  status: LiveReadinessStatus;
  statusLabel: string;
  statusTone: TradingStatusTone;
  blockerCode: string | null;
  blockerLabel: string | null;
  nextActionLabel: string;
  receiptSummary: string;
  broadcastPerformed: false;
  proofCommitments: {
    certificateCommitment?: string | null;
    verificationCommitment?: string | null;
    readinessCommitment?: string | null;
  };
}

export interface TradingVenueStateInput {
  connected: boolean;
  armed: boolean;
  verified?: boolean;
  accountReady?: boolean;
  needsFunds?: boolean;
  workerUnavailable?: boolean;
  accessLabel?: string;
  pooledAvailable?: boolean;
}

export interface TradingUiStateInput {
  authenticated: boolean;
  actionClass: string;
  platformClass: string;
  liveHyperliquidFlow?: boolean;
  hasPreview: boolean;
  submitted?: boolean;
  canApprovePrivate: boolean;
  canApproveDegraded: boolean;
  waiting: boolean;
  blocked: boolean;
  phoenix: TradingVenueStateInput;
  jupiter: TradingVenueStateInput;
  hyperliquid: TradingVenueStateInput;
  coinbase: TradingVenueStateInput;
}

export function isTradingPlatform(platformClass: string): platformClass is TradingPlatformClass {
  return platformClass === "hyperliquid_style_market" ||
    platformClass === "solana_perps_market" ||
    platformClass === "solana_swap_aggregator" ||
    platformClass === "coinbase_style_provider";
}

export function deriveLiveReadinessDisplay(input: {
  venue: LiveTradingVenue;
  authenticated: boolean;
  marketStatus?: string | null;
  marketStale?: boolean | null;
  connected: boolean;
  armed: boolean;
  verified?: boolean;
  hasPreview?: boolean;
  canSubmit?: boolean;
  needsFunds?: boolean;
  workerUnavailable?: boolean;
  liveSubmitEnabled?: boolean;
  blocked?: boolean;
  blockerCode?: string | null;
  certificateCommitment?: string | null;
  verificationCommitment?: string | null;
  readinessCommitment?: string | null;
}): LiveReadinessDisplayState {
  const venueLabel = liveVenueLabel(input.venue);
  const staleMarket = input.marketStale === true || input.marketStatus === "stale" || input.marketStatus === "blocked";
  const status: LiveReadinessStatus =
    !input.authenticated ? "signed_out"
    : input.blocked ? "blocked"
    : input.workerUnavailable ? "worker_unavailable"
    : staleMarket ? "market_stale"
    : !input.connected ? "connect_account"
    : !input.armed ? "use_with_ghola"
    : input.needsFunds ? "needs_funds"
    : !input.verified ? "check_connection"
    : !input.hasPreview ? "ready_to_preview"
    : input.canSubmit ? "ready_to_place_capped_trade"
    : input.liveSubmitEnabled === false ? "live_submit_locked"
    : "ready_to_place_capped_trade";
  const blockerCode = input.blockerCode || blockerCodeForStatus(status);
  return {
    venue: input.venue,
    venueLabel,
    status,
    statusLabel: liveStatusLabel(status),
    statusTone: liveStatusTone(status),
    blockerCode,
    blockerLabel: blockerCode ? blockerLabelForStatus(status, venueLabel) : null,
    nextActionLabel: liveNextActionLabel(status),
    receiptSummary: liveReceiptSummary(status, venueLabel),
    broadcastPerformed: false,
    proofCommitments: {
      certificateCommitment: input.certificateCommitment ?? null,
      verificationCommitment: input.verificationCommitment ?? null,
      readinessCommitment: input.readinessCommitment ?? null,
    },
  };
}

export function deriveTradingNextAction(input: TradingUiStateInput): TradingNextAction {
  if (input.actionClass !== "trade_on_platform" || !isTradingPlatform(input.platformClass)) {
    return action("idle", "Choose a trade", "Pick a venue and order before continuing.", "neutral", true);
  }
  if (!input.authenticated) {
    return action("sign_in", "Sign in to trade", "Create or unlock your Ghola account, then connect scoped venue access.", "primary");
  }

  if (input.platformClass === "solana_perps_market") {
    const venue = input.phoenix;
    if (!venue.connected) {
      return {
        ...action("connect_phoenix_byo", "Connect Phoenix authority", "Import a dedicated Phoenix trading authority for capped live orders.", "primary"),
        secondary: action(
          "use_phoenix_vault",
          venue.pooledAvailable ? "Use Ghola pool" : "Ghola pool unavailable",
          venue.pooledAvailable
            ? "Use a Ghola-provided Phoenix authority for capped live orders."
            : "Connect your own Phoenix authority until a Ghola Phoenix pool is configured.",
          "neutral",
          !venue.pooledAvailable,
        ),
      };
    }
    if (!venue.armed) {
      return action("arm_phoenix", "Create agent", "Bind the Phoenix authority to Ghola's capped execution policy.", "primary");
    }
    if (!venue.verified) {
      return action("verify_phoenix", "Check connection", phoenixVerificationCopy(venue), "primary");
    }
    return previewAction(input, "Phoenix");
  }

  if (input.platformClass === "solana_swap_aggregator") {
    const venue = input.jupiter;
    if (!venue.connected) {
      return {
        ...action("connect_jupiter_byo", "Connect swap authority", "Import a dedicated Solana swap authority for route checks and capped swaps.", "primary"),
        secondary: action(
          "use_jupiter_vault",
          venue.pooledAvailable ? "Use Ghola pool" : "Ghola pool unavailable",
          venue.pooledAvailable
            ? "Use a Ghola-provided swap authority for capped route execution."
            : "Connect your own swap authority until a Ghola Jupiter pool is configured.",
          "neutral",
          !venue.pooledAvailable,
        ),
      };
    }
    if (!venue.armed) {
      return action("arm_jupiter", "Create agent", "Bind the Jupiter authority to Ghola's capped execution policy.", "primary");
    }
    if (!venue.verified) {
      return action("verify_jupiter", "Check connection", jupiterVerificationCopy(venue), "primary");
    }
    return previewAction(input, "Jupiter");
  }

  if (input.platformClass === "hyperliquid_style_market") {
    const venue = input.hyperliquid;
    if (!venue.connected) {
      return {
        ...action(
          "connect_hyperliquid_byo",
          "Connect API wallet",
          "Import a scoped Hyperliquid API wallet for capped live orders.",
          "primary",
        ),
        secondary: action(
          "use_hyperliquid_vault",
          venue.pooledAvailable ? "Use Ghola pool" : "Ghola pool unavailable",
          venue.pooledAvailable
            ? "Use a Ghola-provided Hyperliquid account for capped live orders."
            : "Connect a scoped API wallet until a Ghola Hyperliquid pool is configured.",
          "neutral",
          !venue.pooledAvailable,
        ),
      };
    }
    if (!venue.armed) {
      return action("arm_hyperliquid", "Create agent", "Bind the selected account to Ghola's capped execution policy.", "primary");
    }
    if (input.liveHyperliquidFlow && (!venue.verified || venue.accountReady === false)) {
      return action("verify_hyperliquid", "Check connection", hyperliquidVerificationCopy(venue), "primary");
    }
    return previewAction(input, "Hyperliquid");
  }

  const venue = input.coinbase;
  if (!venue.connected) {
    return {
      ...action("connect_coinbase_byo", "Connect Coinbase key", "Import a scoped Coinbase Advanced API key for capped live orders.", "primary"),
      secondary: action(
        "allocate_coinbase_omnibus",
        venue.pooledAvailable ? "Use Ghola pool" : "Ghola pool unavailable",
        venue.pooledAvailable
          ? "Use a Ghola partner pool for capped Coinbase orders."
          : "Connect a scoped Coinbase key until the partner pool is configured.",
        "neutral",
        !venue.pooledAvailable,
      ),
    };
  }
  if (!venue.armed) {
    return action("arm_coinbase", "Create agent", "Bind Coinbase access to Ghola's capped execution policy.", "primary");
  }
  if (!venue.verified) {
    return action("verify_coinbase", "Check connection", coinbaseVerificationCopy(venue), "primary");
  }
  return previewAction(input, "Coinbase");
}

export function deriveVenueReadinessSteps(input: TradingUiStateInput): VenueReadinessStep[] {
  const venue = activeVenue(input);
  const platform = platformLabel(input.platformClass);
  const requiresVerification = input.platformClass === "solana_perps_market" ||
    input.platformClass === "solana_swap_aggregator" ||
    input.platformClass === "coinbase_style_provider" ||
    (input.platformClass === "hyperliquid_style_market" && input.liveHyperliquidFlow === true);
  const privacyStatus = privacyStepStatus(input, venue, requiresVerification);
  return [
    {
      id: "venue",
      label: "Venue",
      value: platform,
      status: isTradingPlatform(input.platformClass) ? "done" : "current",
    },
    {
      id: "access",
      label: "Access",
      value: accessStepValue(input, venue, platform),
      status: venue.connected ? "done" : "current",
    },
    {
      id: "guardrails",
      label: "Guardrails",
      value: !input.authenticated ? "Sign in first" : venue.armed ? "Armed" : venue.connected ? "Create agent" : "Waiting for access",
      status: !venue.connected ? "pending" : venue.armed ? "done" : "current",
    },
    {
      id: "privacy",
      label: "Privacy",
      value: privacyStatus.value,
      status: privacyStatus.status,
    },
    {
      id: "submit",
      label: "Submit",
      value: submitStepValue(input),
      status: submitStepStatus(input),
    },
  ];
}

export function phoenixOrderbookClickSide(bookSide: "bid" | "ask"): "buy" | "sell" {
  return bookSide === "ask" ? "buy" : "sell";
}

export function deriveMarketFeedFreshness(input: MarketFeedFreshnessInput): MarketFeedFreshness {
  const status = String(input.status || "").trim();
  const age = relativeAge(input.fetchedAt, input.nowMs);
  const lastGood = age ? `last good ${age}` : "";
  if (status === "blocked") return { label: "Blocked", tone: "bad" };
  if (status === "live" && input.stale !== true) {
    return { label: age ? `Live · updated ${age}` : "Live", tone: "good" };
  }
  if (status === "fallback_polling") {
    return { label: lastGood ? `Polling · ${lastGood}` : "Polling", tone: "warn" };
  }
  if (status === "reconnecting") {
    return { label: lastGood ? `Reconnecting · ${lastGood}` : "Reconnecting", tone: "warn" };
  }
  if (status === "connecting") {
    return { label: lastGood ? `Reconnecting · ${lastGood}` : "Connecting", tone: "warn" };
  }
  if (status === "stale" || input.stale === true) {
    return { label: lastGood ? `Stale · ${lastGood}` : "Stale", tone: "warn" };
  }
  if (!status) return { label: "Waiting for data", tone: "neutral" };
  return { label: status, tone: "neutral" };
}

export function deriveOrderTicketDisplayState(input: {
  errors: string[];
  hasPreview?: boolean;
}): OrderTicketDisplayState {
  const fieldHints: Partial<Record<OrderTicketField, string[]>> = {};
  const generalHints: string[] = [];
  for (const error of input.errors) {
    const field = orderTicketFieldForError(error);
    if (!field) {
      pushUnique(generalHints, error);
      continue;
    }
    const hints = fieldHints[field] ?? [];
    pushUnique(hints, error);
    fieldHints[field] = hints;
  }
  if (input.errors.length > 0) {
    return {
      statusLabel: "Needs fields",
      statusTone: "warn",
      fieldHints,
      generalHints,
      primaryBlockerText: "Fix order fields before preview",
    };
  }
  return {
    statusLabel: input.hasPreview ? "Checked" : "Ready",
    statusTone: "good",
    fieldHints,
    generalHints,
  };
}

function previewAction(input: TradingUiStateInput, venueLabel: string): TradingNextAction {
  if (!input.hasPreview) {
    return action("preview", "Preview intent", `Check what ${venueLabel}, Ghola, and public rails can see.`, "primary");
  }
  if (input.blocked) {
    return action("blocked", "Blocked", "This path is too leaky to submit from Private Mode.", "danger", true);
  }
  if (input.waiting) {
    return action("wait_for_privacy", "Wait for privacy", "Queue the trade until the anonymity set is ready.", "primary");
  }
  if (input.canApprovePrivate) {
    return action("place_trade", "Place capped trade", "Approve the checked order and send only the sealed execution instruction.", "success");
  }
  if (input.canApproveDegraded) {
    return action("accept_visibility", "Accept visibility and place capped trade", "Continue only if you accept the lower privacy path.", "warn");
  }
  return action("preview", "Preview intent again", "Refresh the visibility check before approving.", "primary");
}

function action(
  kind: TradingActionKind,
  label: string,
  description: string,
  tone: TradingActionTone,
  disabled = false,
): TradingNextAction {
  return { kind, label, description, tone, disabled };
}

function activeVenue(input: TradingUiStateInput): TradingVenueStateInput {
  if (input.platformClass === "solana_perps_market") return input.phoenix;
  if (input.platformClass === "solana_swap_aggregator") return input.jupiter;
  if (input.platformClass === "hyperliquid_style_market") return input.hyperliquid;
  if (input.platformClass === "coinbase_style_provider") return input.coinbase;
  return { connected: false, armed: false };
}

function platformLabel(platformClass: string) {
  if (platformClass === "solana_perps_market") return "Phoenix";
  if (platformClass === "solana_swap_aggregator") return "Jupiter";
  if (platformClass === "hyperliquid_style_market") return "Hyperliquid";
  if (platformClass === "coinbase_style_provider") return "Coinbase";
  return "Select venue";
}

function accessStepValue(input: TradingUiStateInput, venue: TradingVenueStateInput, platform: string): string {
  if (!input.authenticated) return "Sign in required";
  if (venue.workerUnavailable) return "Worker unavailable";
  if (venue.needsFunds) return "Needs funds";
  if (venue.connected) return venue.accessLabel || "Connected";
  return `Connect scoped ${platform} access`;
}

function privacyStepStatus(
  input: TradingUiStateInput,
  venue: TradingVenueStateInput,
  requiresVerification: boolean,
): { value: string; status: VenueStepStatus } {
  if (!input.authenticated) return { value: "Sign in required", status: "pending" };
  if (!venue.connected) return { value: "Connect account", status: "pending" };
  if (!venue.armed) return { value: "Create agent", status: "pending" };
  if (requiresVerification && !venue.verified) {
    if (venue.workerUnavailable) return { value: "Worker unavailable", status: "warn" };
    if (venue.needsFunds) return { value: "Needs funds", status: "warn" };
    return { value: "Check connection", status: "current" };
  }
  if (!input.hasPreview) return { value: "Ready to preview", status: "current" };
  if (input.blocked) return { value: "Blocked", status: "blocked" };
  if (input.waiting) return { value: "Waiting", status: "warn" };
  if (input.canApproveDegraded) return { value: "Visibility accepted", status: "warn" };
  return { value: "Checked", status: "done" };
}

function submitStepValue(input: TradingUiStateInput) {
  if (input.submitted) return "Receipt ready";
  if (input.blocked) return "Blocked";
  if (input.waiting) return "Queued path";
  if (input.canApprovePrivate || input.canApproveDegraded) return "Ready";
  return "Pending";
}

function submitStepStatus(input: TradingUiStateInput): VenueStepStatus {
  if (input.submitted) return "done";
  if (input.blocked) return "blocked";
  if (input.waiting) return "warn";
  if (input.canApprovePrivate || input.canApproveDegraded) return "current";
  return "pending";
}

function phoenixVerificationCopy(venue: TradingVenueStateInput) {
  if (venue.workerUnavailable) return "Worker unavailable. Retry the no-submit check before approval.";
  if (venue.needsFunds) return "Needs funds. Add venue collateral, then check again.";
  return "Build a Phoenix order packet without broadcasting it.";
}

function jupiterVerificationCopy(venue: TradingVenueStateInput) {
  if (venue.workerUnavailable) return "Worker unavailable. Retry the no-submit check before approval.";
  if (venue.needsFunds) return "Needs funds. Add swap authority funds, then check again.";
  return "Build a Jupiter swap transaction without submitting it.";
}

function hyperliquidVerificationCopy(venue: TradingVenueStateInput) {
  if (venue.workerUnavailable) return "Worker unavailable. Retry the no-submit check before approval.";
  if (venue.needsFunds) return "Needs funds. Add venue collateral, then check the Hyperliquid account again.";
  return "Build a capped Hyperliquid order request without sending it.";
}

function coinbaseVerificationCopy(venue: TradingVenueStateInput) {
  if (venue.workerUnavailable) return "Worker unavailable. Retry the Coinbase readiness check before approval.";
  if (venue.needsFunds) return "Needs funds. Add provider account funds, then check again.";
  return "Build a Coinbase order request without submitting it.";
}

function liveVenueLabel(venue: LiveTradingVenue): string {
  if (venue === "hyperliquid") return "Hyperliquid";
  if (venue === "phoenix") return "Phoenix";
  if (venue === "jupiter") return "Jupiter";
  return "Coinbase";
}

function liveStatusLabel(status: LiveReadinessStatus): string {
  if (status === "signed_out") return "Sign in required";
  if (status === "connect_account") return "Connect account";
  if (status === "use_with_ghola") return "Create agent";
  if (status === "market_stale") return "Market stale";
  if (status === "worker_unavailable") return "Worker unavailable";
  if (status === "needs_funds") return "Needs funds";
  if (status === "check_connection") return "Check connection";
  if (status === "ready_to_preview") return "Ready to preview";
  if (status === "ready_to_place_capped_trade") return "Ready to place capped trade";
  if (status === "live_submit_locked") return "Live submit locked";
  return "Blocked";
}

function liveStatusTone(status: LiveReadinessStatus): TradingStatusTone {
  if (status === "ready_to_preview" || status === "ready_to_place_capped_trade") return "good";
  if (status === "blocked" || status === "worker_unavailable") return "bad";
  if (status === "signed_out" || status === "connect_account" || status === "use_with_ghola") return "neutral";
  return "warn";
}

function blockerCodeForStatus(status: LiveReadinessStatus): string | null {
  if (status === "signed_out") return "signed_out";
  if (status === "connect_account") return "venue_access_required";
  if (status === "use_with_ghola") return "agent_not_armed";
  if (status === "market_stale") return "market_stale";
  if (status === "worker_unavailable") return "worker_unavailable";
  if (status === "needs_funds") return "needs_funds";
  if (status === "check_connection") return "no_submit_check_required";
  if (status === "live_submit_locked") return "live_submit_locked";
  if (status === "blocked") return "blocked";
  return null;
}

function blockerLabelForStatus(status: LiveReadinessStatus, venueLabel: string): string {
  if (status === "signed_out") return "Sign in before connecting a live venue.";
  if (status === "connect_account") return `Connect ${venueLabel} access before preview.`;
  if (status === "use_with_ghola") return `Bind ${venueLabel} access to Ghola guardrails.`;
  if (status === "market_stale") return "Wait for a fresh market snapshot before preview.";
  if (status === "worker_unavailable") return "Worker unavailable. Retry the no-submit check.";
  if (status === "needs_funds") return "Add funds, then check the live path again.";
  if (status === "check_connection") return "Run the no-submit readiness check before approval.";
  if (status === "live_submit_locked") return "Live submit remains locked until every gate passes.";
  return "This path is blocked before submit.";
}

function liveNextActionLabel(status: LiveReadinessStatus): string {
  if (status === "signed_out") return "Sign in to connect account";
  if (status === "connect_account") return "Connect account";
  if (status === "use_with_ghola") return "Create agent";
  if (status === "check_connection" || status === "worker_unavailable" || status === "needs_funds") return "Check connection";
  if (status === "ready_to_preview") return "Preview intent";
  if (status === "ready_to_place_capped_trade") return "Place capped trade";
  if (status === "market_stale") return "Wait for market data";
  return "Live submit locked";
}

function liveReceiptSummary(status: LiveReadinessStatus, venueLabel: string): string {
  if (status === "ready_to_place_capped_trade") {
    return `${venueLabel} readiness passed. No broadcast happened during the check.`;
  }
  if (status === "ready_to_preview") {
    return `${venueLabel} access is checked. Build a preview before any live submit.`;
  }
  if (status === "check_connection") {
    return `${venueLabel} access is armed, but the no-submit check has not passed yet.`;
  }
  if (status === "needs_funds") return `${venueLabel} needs funds before a capped live attempt.`;
  if (status === "worker_unavailable") return `${venueLabel} readiness could not reach the worker.`;
  if (status === "market_stale") return `${venueLabel} market data is stale; no submit is available.`;
  return `${venueLabel} live submit is locked before broadcast.`;
}

function relativeAge(fetchedAt: string | null | undefined, nowMs = Date.now()): string | null {
  if (!fetchedAt) return null;
  const observed = Date.parse(fetchedAt);
  if (!Number.isFinite(observed)) return null;
  const elapsed = Math.max(0, nowMs - observed);
  if (elapsed < 1_000) return "now";
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1_000)}s ago`;
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  return `${Math.floor(elapsed / 3_600_000)}h ago`;
}

function orderTicketFieldForError(error: string): OrderTicketField | null {
  const normalized = error.toLowerCase();
  if (normalized.includes("slippage")) return "slippage";
  if (
    normalized.includes("size") ||
    normalized.includes("amount") ||
    normalized.includes("notional") ||
    normalized.includes("live order") ||
    normalized.includes("capped")
  ) {
    return "size";
  }
  if (normalized.includes("price")) return "price";
  return null;
}

function pushUnique(target: string[], value: string) {
  if (!target.includes(value)) target.push(value);
}
