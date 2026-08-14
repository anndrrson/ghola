"use client";

import dynamic from "next/dynamic";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  KeyRound,
  LockKeyhole,
  Play,
  RefreshCcw,
  ShieldCheck,
  SlidersHorizontal,
  Wallet,
} from "lucide-react";
import { AuthModal, type AuthMode } from "@/components/AuthModal";
import {
  GholaMarketChart,
  type GholaChartStudyId,
  type GholaReplayContext,
} from "@/components/private-account/GholaMarketChart";
import { ArmAgentButton } from "@/components/trade/ArmAgentButton";
import { ConnectHyperliquidButton } from "@/components/trade/ConnectHyperliquidButton";
import { TerminalAlertCenter } from "@/components/trade/TerminalAlertCenter";
import { TerminalAgentActivity } from "@/components/trade/TerminalAgentActivity";
import { TerminalBookPressureTape } from "@/components/trade/TerminalBookPressureTape";
import { TerminalBoundPlanAudit } from "@/components/trade/TerminalBoundPlanAudit";
import { TerminalChartAlertLevels } from "@/components/trade/TerminalChartAlertLevels";
import { TerminalColumnResizeHandle } from "@/components/trade/TerminalColumnResizeHandle";
import { TerminalEntryPriceStager } from "@/components/trade/TerminalEntryPriceStager";
import { TerminalEntryOutcomeMatrix } from "@/components/trade/TerminalEntryOutcomeMatrix";
import { TerminalEntryTargetSurface } from "@/components/trade/TerminalEntryTargetSurface";
import { formatTerminalDecimalValue, TerminalDecimalInput, type TerminalDecimalInputProps } from "@/components/trade/TerminalDecimalInput";
import { TerminalExecutionFlightCheck } from "@/components/trade/TerminalExecutionFlightCheck";
import { TerminalHeader } from "@/components/trade/TerminalHeader";
import { TerminalInvalidationPlanner } from "@/components/trade/TerminalInvalidationPlanner";
import { TerminalLiquidityLadder } from "@/components/trade/TerminalLiquidityLadder";
import { TerminalLiquidityStress } from "@/components/trade/TerminalLiquidityStress";
import { TerminalLivePrice } from "@/components/trade/TerminalLivePrice";
import { TerminalLiveExecutionJournal } from "@/components/trade/TerminalLiveExecutionJournal";
import { TerminalLiveSubmitReview } from "@/components/trade/TerminalLiveSubmitReview";
import { TerminalLiveAccountPanel } from "@/components/trade/TerminalLiveAccountBlotter";
import { TerminalLivePortfolioInterlock } from "@/components/trade/TerminalLivePortfolioInterlock";
import { TerminalLocalSafetyStrip } from "@/components/trade/TerminalLocalSafetyStrip";
import {
  TERMINAL_OPEN_PAPER_EVENT,
  TerminalPaperWorkstation,
} from "@/components/trade/TerminalPaperWorkstation";
import { TerminalMarketWatchlist } from "@/components/trade/TerminalMarketWatchlist";
import { TerminalMarketDecisionStack } from "@/components/trade/TerminalMarketDecisionStack";
import { TerminalMarketFeedTelemetry } from "@/components/trade/TerminalMarketFeedTelemetry";
import { TerminalMarketContextRail } from "@/components/trade/TerminalMarketContextRail";
import { TerminalMarketSnapshotMetrics } from "@/components/trade/TerminalMarketSnapshotMetrics";
import { TerminalMarketToolbar } from "@/components/trade/TerminalMarketToolbar";
import { TerminalFundingCarry } from "@/components/trade/TerminalFundingCarry";
import { TerminalPlanPathAnalysis } from "@/components/trade/TerminalPlanPathAnalysis";
import { TerminalPlanPayoffCalibration } from "@/components/trade/TerminalPlanPayoffCalibration";
import { TerminalPlanPathStudy } from "@/components/trade/TerminalPlanPathStudy";
import { TerminalPlanMarketState } from "@/components/trade/TerminalPlanMarketState";
import { TerminalPlanBook } from "@/components/trade/TerminalPlanBook";
import { TerminalRiskBudgetInterlock } from "@/components/trade/TerminalRiskBudgetInterlock";
import { TerminalRewardLadder } from "@/components/trade/TerminalRewardLadder";
import { TerminalRouteCheckControl } from "@/components/trade/TerminalRouteCheckControl";
import { TerminalRouteMatrix } from "@/components/trade/TerminalRouteMatrix";
import { TerminalCrossVenueCarryMatrix } from "@/components/trade/TerminalCrossVenueCarryMatrix";
import { TerminalResponsiveTicketMount } from "@/components/trade/TerminalResponsiveTicketMount";
import { TerminalTradeTape } from "@/components/trade/TerminalTradeTape";
import {
  buildGholaAgentChartOverlays,
  buildGholaExecutableRPlanOverlays,
  decimateCandles,
  frameMidNumber,
  type GholaChartCandle,
  type GholaChartMode,
  type GholaChartOverlay,
  type GholaChartVenue,
  type GholaMarketFrame,
} from "@/lib/ghola-market-chart";
import {
  createPrivateAccountIntent,
  getPublicAgentStartupStatus,
  previewPrivateAccountAction,
  wakePublicAgentWorker,
  type PrivateAccountLiveTradingStatus,
  type PrivateAccountSafeInput,
  type PublicAgentStartupStatus,
  type PublicAgentStartupVenue,
} from "@/lib/private-account-client";
import type { PrivateExecutionOrderDraft } from "@/lib/private-execution-instruction-seal";
import {
  terminalAlertSummaryEqual,
  type TerminalAlertMetric,
  type TerminalAlertSnapshot,
  type TerminalAlertSummary,
  type TerminalSavedPlanAlertRequest,
  type TerminalSavedPlanAlertRemovalRequest,
  type TerminalSavedPlanInventoryItem,
} from "@/lib/terminal-alerts";
import { TERMINAL_ALERT_GUEST_SCOPE, terminalAlertInstrumentScope } from "@/lib/terminal-alert-storage";
import {
  deriveTerminalChartPriceAlerts,
  EMPTY_TERMINAL_CHART_PRICE_ALERT_SNAPSHOT,
  terminalChartPriceAlertSnapshotEqual,
  type TerminalChartPriceAlertSnapshot,
} from "@/lib/terminal-alert-chart";
import type { TerminalCommand, TerminalTicketField } from "@/lib/terminal-command";
import {
  nextTerminalSlippage,
  TERMINAL_TICKET_FIELD_IDS,
  terminalCommandForHotkey,
  terminalKeyboardEventIsEditable,
  terminalModalIsOpen,
  terminalTicketReturnFocusTarget,
  terminalTicketFocusRestoreTarget,
} from "@/lib/terminal-hotkeys";
import { useThumperAuth } from "@/lib/thumper-auth-context";
import { handleTwitterSession } from "@/lib/thumper-api";
import { summarizeCrossVenueHealth } from "@/lib/cross-venue-live-market";
import { useCrossVenueLiveMarket } from "@/lib/use-cross-venue-live-market";
import { useUnifiedLiveMarket } from "@/lib/use-unified-live-market";
import { terminalFrameMatchesSelection } from "@/lib/terminal-market-identity";
import {
  deriveTerminalCertifiedMarketSignals,
  terminalCertifiedBookViewEqual,
  terminalCertifiedIntelligenceViewEqual,
  type TerminalCertifiedMarketSignals,
} from "@/lib/terminal-certified-market-signals";
import {
  TERMINAL_LIVE_STATUS_MAX_AGE_MS,
  terminalByoExecutionReadiness,
  terminalLiveStatusChronologyDecision,
} from "@/lib/terminal-live-readiness";
import { terminalLiveOrderMode } from "@/lib/terminal-live-order-mode";
import {
  deriveTerminalExecutionFlightCheck,
  type TerminalExecutionFlightAction,
} from "@/lib/terminal-execution-flight-check";
import {
  captureTerminalBoundPlanAudit,
  deriveTerminalBoundPlanAudit,
  type TerminalBoundPlanAuditSnapshot,
} from "@/lib/terminal-bound-plan-audit";
import {
  deriveTerminalLiveMarketContext,
  terminalLiveMarketContextBlockerLabel,
  type TerminalLiveMarketContextInput,
} from "@/lib/terminal-live-market-context";
import {
  inspectTerminalLiveExecutionResponse,
  terminalLiveExecutionCanSubmit,
  type TerminalLiveExecutionReceipt as TerminalLiveExecutionReceiptRecord,
} from "@/lib/terminal-live-execution-receipt";
import {
  discardTerminalLiveExecutionPendingEntry,
  externallyReviewTerminalLiveExecutionJournalEntry,
  persistTerminalLiveExecutionJournalEntry,
  readTerminalLiveExecutionJournalStorage,
  serializeTerminalLiveExecutionJournal,
  terminalLiveExecutionJournalSafetyState,
  terminalLiveExecutionJournalSummary,
  terminalLiveExecutionExternalReviewDecision,
  terminalLiveExecutionReviewEvidenceCrossed,
  terminalLiveExecutionJournalEntryFromReceipt,
  terminalLiveExecutionJournalStorageKey,
  terminalLiveExecutionLockStoragePrefix,
  terminalLiveExecutionScopedJournalView,
  terminalLiveExecutionSessionSubjectMatches,
  terminalLiveExecutionSubjectScope,
  terminalLiveExecutionUnknownJournalEntry,
  TERMINAL_LIVE_EXECUTION_LEGACY_JOURNAL_STORAGE_KEY,
  TERMINAL_LIVE_EXECUTION_LEGACY_LOCK_STORAGE_PREFIX,
  type TerminalLiveExecutionJournalEntry,
  type TerminalLiveExecutionJournalStorageStatus,
} from "@/lib/terminal-live-execution-journal";
import {
  deriveTerminalLiveAccountRisk,
  terminalLiveAccountRiskDecisionEqual,
  type TerminalLiveAccountRiskDecision,
} from "@/lib/terminal-live-account-risk";
import {
  terminalLiveExecutionLockBlockerLabel,
  withTerminalLiveExecutionLock,
} from "@/lib/terminal-live-execution-lock";
import {
  terminalLiveDispatchBlockerLabel,
  terminalLiveDispatchGuard,
} from "@/lib/terminal-live-dispatch-guard";
import {
  captureTerminalLiveSubmitReview,
  deriveTerminalLiveSubmitLiquidityEvidence,
  terminalLiveSubmitReviewBlockerLabel,
  terminalLiveSubmitReviewDecision,
  type TerminalLiveSubmitReviewSnapshot,
} from "@/lib/terminal-live-submit-review";
import { deriveTerminalFundingRateSignal, projectTerminalFundingCarry } from "@/lib/terminal-funding-carry";
import { deriveTerminalCrossVenueCarryMatrix } from "@/lib/terminal-cross-venue-carry";
import { deriveTerminalTradeRisk } from "@/lib/trading-terminal-metrics";
import { deriveTerminalLiquidityStress } from "@/lib/terminal-liquidity-stress";
import { terminalTradePrintStageDecision } from "@/lib/terminal-trade-impulse";
import {
  terminalCommandMutatesTradePlan,
  terminalPlanMutationDecision,
} from "@/lib/terminal-plan-mutation-lock";
import {
  deriveTerminalInvalidationPlan,
  terminalInvalidationCandidateMatches,
  type TerminalInvalidationAtrMultiplier,
} from "@/lib/terminal-invalidation-planner";
import { deriveTerminalMarketFieldAuthority } from "@/lib/terminal-market-field-authority";
import { deriveTerminalPriceAuthority } from "@/lib/terminal-price-authority";
import {
  terminalPositionPreviewStatus,
  terminalPositionPreviewStatusCopy,
  type TerminalPositionPreviewStatus,
} from "@/lib/terminal-position-preview-state";
import {
  deriveTerminalEntryPriceStages,
  terminalEntryPriceStageBlockerLabel,
  type TerminalEntryPriceMode,
} from "@/lib/terminal-entry-price-staging";
import {
  deriveTerminalEntryOutcomeMatrix,
  terminalEntrySizeRecommendation,
  type TerminalEntryOutcomeBook,
  type TerminalEntryOutcomeMode,
  type TerminalEntrySizeRecommendation,
} from "@/lib/terminal-entry-outcome-matrix";
import {
  deriveTerminalEntryTargetSurface,
  terminalEntryTargetStageSelection,
} from "@/lib/terminal-entry-target-surface";
import {
  floorTerminalNotionalUsd,
  sizeTerminalPositionForRisk,
  type TerminalPositionSizing,
} from "@/lib/terminal-position-sizing";
import { deriveTerminalRiskBudgetInterlock } from "@/lib/terminal-risk-budget-interlock";
import { deriveTerminalPlanLossEnvelope } from "@/lib/terminal-plan-loss-envelope";
import { analyzeTerminalScenario } from "@/lib/terminal-scenario-analysis";
import { analyzeTerminalPlanPath } from "@/lib/terminal-plan-path-analysis";
import { studyTerminalPlanPathHorizons } from "@/lib/terminal-plan-path-study";
import { deriveTerminalPlanPayoffCalibration } from "@/lib/terminal-plan-payoff-calibration";
import {
  deriveTerminalPlanRestoreDecision,
  terminalPlanBookIdentityKey,
  type TerminalPlanBookIdentity,
  type TerminalPlanDraft,
  type TerminalPlanSnapshot,
} from "@/lib/terminal-plan-book";
import {
  deriveTerminalRewardLadder,
  terminalRewardTargetPrice,
  type TerminalRewardMultiple,
} from "@/lib/terminal-reward-ladder";
import {
  deriveTerminalPlanMarketState,
  terminalPlanMarketStateBlockerLabel,
} from "@/lib/terminal-plan-market-state";
import { deriveTerminalVenueBasis } from "@/lib/terminal-venue-comparison";
import {
  deriveTerminalRouteDecision,
  terminalRouteAnalysisFrames,
  type TerminalRouteCandidate,
} from "@/lib/terminal-route-decision";
import { terminalRouteStageTarget } from "@/lib/terminal-route-staging";
import { deriveTerminalRouteImprovement } from "@/lib/terminal-route-alert";
import { deriveTerminalAllInRouteModel, terminalRouteCostEvidence } from "@/lib/terminal-route-cost-policy";
import { useTerminalRouteCostPolicy } from "@/lib/use-terminal-route-cost-policy";
import { terminalPlanChartRenderInputsEqual } from "@/lib/terminal-plan-chart-render";
import type { TerminalPaperMarketTarget } from "@/lib/terminal-paper-risk-desk";
import type {
  TerminalWatchlistInstrument,
  TerminalWatchlistSource,
  TerminalWatchlistVenue,
} from "@/lib/terminal-market-watchlist";
import {
  defaultTerminalWorkspace,
  inspectTerminalWorkspace,
  serializeTerminalWorkspace,
  terminalWorkspaceConcurrentConflict,
  terminalWorkspaceStorageKey,
  TERMINAL_MARKET_RAIL_WIDTH_PX,
  TERMINAL_SIDE_COLUMNS_MAX_PX,
  TERMINAL_TICKET_WIDTH_PX,
  TERMINAL_WORKSPACE_VERSION,
  validateTerminalWorkspace,
  type TerminalWorkspace,
} from "@/lib/terminal-workspace";
import {
  buildTradeOrderPlan,
  tradeOrderPlanIntentMatches,
  tradeOrderPlanMarketContextFresh,
  tradeOrderPlanIdempotencyKey,
  tradeOrderPlanSlippageBound,
  type TradeOrderPlan,
  type TradeOrderPlanBindingEnvelope,
} from "@/lib/trade-order-plan";
import {
  inspectHyperliquidSignedActionForTradeOrderPlan,
  parseSignedExecutionPayload,
} from "@/lib/signed-execution-material";
import {
  createTerminalSingleFlightPoller,
  terminalPolledValueForSubject,
} from "@/lib/terminal-single-flight-poller";
import { focusTerminalSurfaceWhenReady } from "@/lib/terminal-surface-focus";

type VenueId = "hyperliquid" | "phoenix" | "coinbase";
type Side = "buy" | "sell";
type ChartInterval = "1m" | "5m" | "15m" | "1h";
type LiveExecutionState =
  | { status: "idle" }
  | { status: "working"; stage: "session" | "linking" | "submitting" }
  | { status: "done"; receipt: TerminalLiveExecutionReceiptRecord }
  | { status: "unknown"; message: string }
  | { status: "error"; message: string };
type WorkerWakeState = "idle" | "waking" | "ready" | "error";

const TERMINAL_CHART_MODES: GholaChartMode[] = ["candles", "line", "depth", "compare"];
const TERMINAL_STATUS_POLL_INTERVAL_MS = 15_000;
const TERMINAL_STATUS_REQUEST_TIMEOUT_MS = 10_000;
const MOBILE_TICKET_TRIGGER_ID = "terminal-mobile-ticket-trigger";
const TICKET_FIELD_LABELS: Record<TerminalTicketField, string> = {
  notional: "Order value",
  entry: "Limit entry",
  invalidation: "Plan invalidation",
  risk_budget: "Modeled loss budget",
};
const EMPTY_ALERT_SUMMARY: TerminalAlertSummary = Object.freeze({
  scope: null,
  activeCount: 0,
  primaryActiveLabel: null,
  unreadCount: 0,
  latestUnreadLabel: null,
  latestTriggeredAt: null,
});

function ticketFieldLabel(field: TerminalTicketField) {
  return TICKET_FIELD_LABELS[field];
}

type EntryTrigger =
  | "preview_now"
  | "break_level"
  | "retest_level"
  | "sweep_reclaim"
  | "book_imbalance"
  | "funding_mark_divergence"
  | "route_edge_threshold"
  | "custom";
type StrategyProfile =
  | "trend_following"
  | "breakout"
  | "reversal"
  | "mean_reversion"
  | "range_trade"
  | "funding_basis"
  | "custom";
type Horizon = "scalp" | "session_trade" | "intraday" | "until_invalidated";
type StopRule =
  | "manual_approval"
  | "take_profit_stop"
  | "trail_after_profit"
  | "exit_on_invalidation";

const VENUES: Array<{
  id: VenueId;
  label: string;
  markets: string[];
  defaultMarket: string;
  chartVenue: GholaChartVenue;
}> = [
  {
    id: "hyperliquid",
    label: "Hyperliquid",
    markets: ["BTC", "ETH", "SOL", "HYPE"],
    defaultMarket: "BTC",
    chartVenue: "hyperliquid",
  },
  {
    id: "phoenix",
    label: "Phoenix",
    markets: ["SOL"],
    defaultMarket: "SOL",
    chartVenue: "phoenix",
  },
  {
    id: "coinbase",
    label: "Coinbase",
    markets: ["BTC", "ETH", "SOL"],
    defaultMarket: "BTC",
    chartVenue: "coinbase",
  },
];

function venueProductLabel(venueId: VenueId, market: string) {
  return venueId === "coinbase" ? `${market}-USD` : `${market}-PERP`;
}

const FALLBACK_BASE_PRICE: Record<string, number> = { BTC: 63_500, ETH: 3_000, SOL: 158, HYPE: 40 };

function amountBucket(notional: number): PrivateAccountSafeInput["amount_bucket"] {
  if (notional <= 5) return "5";
  if (notional <= 10) return "10";
  if (notional <= 25) return "25";
  if (notional <= 50) return "50";
  return "100";
}

const STRATEGIES: Array<{ id: StrategyProfile; label: string; condition: string }> = [
  { id: "trend_following", label: "Trend follow", condition: "higher high + pullback" },
  { id: "breakout", label: "Breakout", condition: "breaks level with spread ok" },
  { id: "reversal", label: "Reversal", condition: "sweep rejects and reclaims" },
  { id: "mean_reversion", label: "Mean reversion", condition: "returns to marked range" },
  { id: "range_trade", label: "Range fade", condition: "near range edge" },
  { id: "funding_basis", label: "Funding basis", condition: "basis edge >= threshold" },
  { id: "custom", label: "Custom", condition: "custom rule" },
];

const ENTRY_TRIGGERS: Array<{ id: EntryTrigger; label: string }> = [
  { id: "preview_now", label: "Enter now" },
  { id: "break_level", label: "Breaks level" },
  { id: "retest_level", label: "Retests level" },
  { id: "sweep_reclaim", label: "Reclaims level" },
  { id: "book_imbalance", label: "Book shifts" },
  { id: "funding_mark_divergence", label: "Funding edge" },
  { id: "route_edge_threshold", label: "Route improves" },
  { id: "custom", label: "Custom rule" },
];

// How each trigger reads inside the mandate: the chip term, then the
// connective that links it to the entry price.
const TRIGGER_PHRASES: Record<EntryTrigger, { term: string; connective: string }> = {
  preview_now: { term: "enter now", connective: "at" },
  break_level: { term: "enter on a break", connective: "of" },
  retest_level: { term: "enter on a retest", connective: "of" },
  sweep_reclaim: { term: "enter on a reclaim", connective: "of" },
  book_imbalance: { term: "enter on a book shift", connective: "near" },
  funding_mark_divergence: { term: "enter on a funding edge", connective: "near" },
  route_edge_threshold: { term: "enter when the route improves", connective: "near" },
  custom: { term: "enter on a custom rule", connective: "at" },
};

const HORIZONS: Array<{ id: Horizon; label: string }> = [
  { id: "scalp", label: "Scalp" },
  { id: "session_trade", label: "Session" },
  { id: "intraday", label: "Intraday" },
  { id: "until_invalidated", label: "Until invalidated" },
];

const STOP_RULES: Array<{ id: StopRule; label: string }> = [
  { id: "manual_approval", label: "Manual approval" },
  { id: "take_profit_stop", label: "TP / invalidation" },
  { id: "trail_after_profit", label: "Trail profit" },
  { id: "exit_on_invalidation", label: "Invalidation exit" },
];

// Triggers that are coherent with each trade idea. The first entry is the
// playbook default applied when an idea is chosen manually.
const TRIGGERS_FOR: Record<StrategyProfile, EntryTrigger[]> = {
  trend_following: ["preview_now", "break_level", "retest_level", "book_imbalance", "custom"],
  breakout: ["break_level", "retest_level", "book_imbalance", "custom"],
  reversal: ["sweep_reclaim", "retest_level", "custom"],
  mean_reversion: ["retest_level", "sweep_reclaim", "preview_now", "custom"],
  range_trade: ["retest_level", "sweep_reclaim", "custom"],
  funding_basis: ["funding_mark_divergence", "route_edge_threshold", "custom"],
  custom: [
    "preview_now",
    "break_level",
    "retest_level",
    "sweep_reclaim",
    "book_imbalance",
    "funding_mark_divergence",
    "route_edge_threshold",
    "custom",
  ],
};

const STOP_DEFAULT_PCT = 0.0075;
const MAX_TRADE_NOTIONAL_USD = 100;
const MIN_TRADE_NOTIONAL_USD = 1;
const NOTIONAL_DRAFT_BOUNDS = { min: MIN_TRADE_NOTIONAL_USD, max: MAX_TRADE_NOTIONAL_USD, maxFractionDigits: 2 } as const;
const RISK_BUDGET_DRAFT_BOUNDS = { min: 0.01, max: MAX_TRADE_NOTIONAL_USD, maxFractionDigits: 2 } as const;
const HIGH_PRICE_DRAFT_BOUNDS = { min: 0.1, max: 1_000_000_000_000, maxFractionDigits: 1 } as const;
const LOW_PRICE_DRAFT_BOUNDS = { min: 0.01, max: 1_000_000_000_000, maxFractionDigits: 2 } as const;
type TicketDecimalField = "notional" | "risk_budget" | "entry" | "invalidation";
const TICKET_DECIMAL_FIELD_ORDER: TicketDecimalField[] = ["notional", "entry", "invalidation", "risk_budget"];
const ReplayExecutionLab = dynamic(
  () => import("@/components/trade/ReplayExecutionLab").then((module) => module.ReplayExecutionLab),
  {
    ssr: false,
    loading: () => <div role="status" className="mt-3 rounded border border-amber-300/25 bg-[#070a10] px-3 py-3 text-[10px] text-amber-100">Opening local Replay Execution Lab…</div>,
  },
);

export default function TradePage() {
  const thumperAuth = useThumperAuth();
  const { setAuth } = thumperAuth;
  const authenticatedSubject = thumperAuth.authenticated ? thumperAuth.user?.id ?? null : null;
  const liveExecutionSubjectScope = useMemo(
    () => terminalLiveExecutionSubjectScope(authenticatedSubject),
    [authenticatedSubject],
  );
  const traderPersistenceScope = thumperAuth.loading
    ? null
    : thumperAuth.authenticated
      ? liveExecutionSubjectScope
      : TERMINAL_ALERT_GUEST_SCOPE;
  const routeCostPolicy = useTerminalRouteCostPolicy(traderPersistenceScope);
  const routeCostPolicyRef = useRef(routeCostPolicy);
  routeCostPolicyRef.current = routeCostPolicy;
  const workspaceStorageKey = terminalWorkspaceStorageKey(traderPersistenceScope);
  const router = useRouter();
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>("signup");
  const [venueId, setVenueId] = useState<VenueId>("hyperliquid");
  const [hyperliquidNetwork, setHyperliquidNetwork] = useState<"mainnet" | "testnet">("mainnet");
  const [marketSel, setMarketSel] = useState("BTC");
  const [chartInterval, setChartInterval] = useState<ChartInterval>("5m");
  const [chartSurface, setChartSurface] = useState<"terminal" | "plan">("terminal");
  const [chartMode, setChartMode] = useState<GholaChartMode>("candles");
  const [chartStudies, setChartStudies] = useState<GholaChartStudyId[]>(["vwap"]);
  const [replayScenario, setReplayScenario] = useState<{
    active: boolean;
    frame: GholaMarketFrame | null;
    context: GholaReplayContext | null;
  }>({ active: false, frame: null, context: null });
  const [liveStatus, setLiveStatus] = useState<PrivateAccountLiveTradingStatus | null>(null);
  const [liveStatusReceivedAt, setLiveStatusReceivedAt] = useState<number | null>(null);
  const [liveStatusSubject, setLiveStatusSubject] = useState<string | null>(null);
  const [workerReady, setWorkerReady] = useState(false);
  const [workerLabel, setWorkerLabel] = useState("checking");
  const [workerWakeState, setWorkerWakeState] = useState<WorkerWakeState>("idle");
  const [agentStartup, setAgentStartup] = useState<PublicAgentStartupStatus | null>(null);
  const [agentStartupSubject, setAgentStartupSubject] = useState<string | null>(null);
  const [agentStartupFailed, setAgentStartupFailed] = useState(false);
  const [agentWakeState, setAgentWakeState] = useState<WorkerWakeState>("idle");
  const [agentWakeMessage, setAgentWakeMessage] = useState<string | null>(null);
  const [strategy, setStrategy] = useState<StrategyProfile>("trend_following");
  const [entryTrigger, setEntryTrigger] = useState<EntryTrigger>("preview_now");
  const [horizon, setHorizon] = useState<Horizon>("scalp");
  const [stopRule, setStopRule] = useState<StopRule>("manual_approval");
  const [side, setSide] = useState<Side>("buy");
  const [notional, setNotional] = useState(10);
  const scopedLiveStatus = terminalPolledValueForSubject(
    liveStatus,
    liveStatusSubject,
    authenticatedSubject,
  );
  const scopedLiveStatusReceivedAt = terminalPolledValueForSubject(
    liveStatusReceivedAt,
    liveStatusSubject,
    authenticatedSubject,
  );
  const scopedAgentStartup = terminalPolledValueForSubject(
    agentStartup,
    agentStartupSubject,
    authenticatedSubject,
  );
  const [ticketDecimalBlocks, setTicketDecimalBlocks] = useState<Record<TicketDecimalField, boolean>>({
    notional: false,
    risk_budget: false,
    entry: false,
    invalidation: false,
  });
  const ticketDecimalDraftBlocked = Object.values(ticketDecimalBlocks).some(Boolean);
  const [riskBudgetUsd, setRiskBudgetUsd] = useState(1);
  const riskBudgetUsdRef = useRef(riskBudgetUsd);
  const [slippageBps, setSlippageBps] = useState(50);
  const [entryPrice, setEntryPrice] = useState<number | null>(null);
  const [entryPinned, setEntryPinned] = useState(false);
  const [stopPrice, setStopPrice] = useState<number | null>(null);
  const [stopPinned, setStopPinned] = useState(false);
  const [targetRewardMultiple, setTargetRewardMultiple] = useState<TerminalRewardMultiple>(2);
  const [ideaManual, setIdeaManual] = useState(false);
  const [triggerManual, setTriggerManual] = useState(false);
  const [stopRuleManual, setStopRuleManual] = useState(false);
  const [preview, setPreview] = useState<
    | { status: "idle" }
    | { status: "working" }
    | { status: "done"; commitment: string; planBinding: TradeOrderPlanBindingEnvelope }
    | { status: "error"; message: string }
  >({ status: "idle" });
  const [boundPlanAuditSnapshot, setBoundPlanAuditSnapshot] = useState<TerminalBoundPlanAuditSnapshot | null>(null);
  const [liveSubmitReview, setLiveSubmitReview] = useState<TerminalLiveSubmitReviewSnapshot | null>(null);
  const [liveExecution, setLiveExecution] = useState<LiveExecutionState>({ status: "idle" });
  const [liveExecutionJournal, setLiveExecutionJournal] = useState<readonly TerminalLiveExecutionJournalEntry[]>([]);
  const liveExecutionJournalRef = useRef<readonly TerminalLiveExecutionJournalEntry[]>([]);
  const [liveExecutionJournalStorageStatus, setLiveExecutionJournalStorageStatus] = useState<TerminalLiveExecutionJournalStorageStatus>("loading");
  const liveExecutionJournalStorageStatusRef = useRef<TerminalLiveExecutionJournalStorageStatus>("loading");
  const [liveExecutionJournalLoadedScope, setLiveExecutionJournalLoadedScope] = useState<string | null>(null);
  const liveExecutionJournalSubjectScopeRef = useRef<string | null>(null);
  if (liveExecutionJournalSubjectScopeRef.current !== liveExecutionSubjectScope) {
    liveExecutionJournalSubjectScopeRef.current = liveExecutionSubjectScope;
    liveExecutionJournalRef.current = [];
    liveExecutionJournalStorageStatusRef.current = "loading";
  }
  const scopedLiveExecutionJournalView = terminalLiveExecutionScopedJournalView({
    subjectScope: liveExecutionSubjectScope,
    loadedScope: liveExecutionJournalLoadedScope,
    entries: liveExecutionJournal,
    storageStatus: liveExecutionJournalStorageStatus,
  });
  const scopedLiveExecutionJournal = scopedLiveExecutionJournalView.entries;
  const scopedLiveExecutionJournalStorageStatus = scopedLiveExecutionJournalView.storageStatus;
  const previewRequestIdRef = useRef(0);
  const previewInFlightRef = useRef(false);
  const liveExecutionInFlightRef = useRef(false);
  const liveExecutionEpochRef = useRef(0);
  const currentOrderPlanRef = useRef<TradeOrderPlan | null>(null);
  const [liveAccountRiskDecision, setLiveAccountRiskDecision] = useState<TerminalLiveAccountRiskDecision | null>(null);
  const liveAccountRiskDecisionRef = useRef<TerminalLiveAccountRiskDecision | null>(null);
  const mobileTicketReturnFocusRef = useRef<HTMLElement | null>(null);
  const mobileTicketTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileTicketCloseRef = useRef<HTMLButtonElement>(null);
  const mobileTicketRef = useRef<HTMLElement>(null);
  const restoreMobileTicketFocusRef = useRef(true);
  const paperSurfaceFocusAbortRef = useRef<AbortController | null>(null);
  const [signedPayloadText, setSignedPayloadText] = useState("");
  const [bookOpen, setBookOpen] = useState(true);
  const [bookView, setBookView] = useState<"ladder" | "book">("ladder");
  const [marketRailWidthPx, setMarketRailWidthPx] = useState<number>(TERMINAL_MARKET_RAIL_WIDTH_PX.default);
  const [ticketWidthPx, setTicketWidthPx] = useState<number>(TERMINAL_TICKET_WIDTH_PX.default);
  const [routeCheckOpen, setRouteCheckOpen] = useState(false);
  const [marketRestartKey, setMarketRestartKey] = useState(0);
  const [accountStreamRestartKey, setAccountStreamRestartKey] = useState(0);
  const [mobileTicketOpen, setMobileTicketOpen] = useState(false);
  const [openRow, setOpenRow] = useState<string | null>(null);
  // Default closed: hydration and an unresolved host can never expose a wake
  // or live-submit path. Production is enabled only after the browser host is
  // positively identified as non-local.
  const [localPreview, setLocalPreview] = useState(true);
  const [keyboardMessage, setKeyboardMessage] = useState("");
  const allowTerminalPlanMutation = useCallback(() => {
    const decision = terminalPlanMutationDecision(liveExecutionInFlightRef.current);
    if (decision.allowed) return true;
    setKeyboardMessage(decision.message);
    return false;
  }, []);
  const previousExecutionSubjectRef = useRef(authenticatedSubject);
  useEffect(() => () => paperSurfaceFocusAbortRef.current?.abort(), []);
  useLayoutEffect(() => {
    if (previousExecutionSubjectRef.current === authenticatedSubject) return;
    previousExecutionSubjectRef.current = authenticatedSubject;
    previewRequestIdRef.current += 1;
    liveExecutionEpochRef.current += 1;
    setPreview({ status: "idle" });
    setBoundPlanAuditSnapshot(null);
    setSignedPayloadText("");
    setLiveExecution({ status: "idle" });
  }, [authenticatedSubject]);
  const [alertSummary, setAlertSummary] = useState<TerminalAlertSummary>(EMPTY_ALERT_SUMMARY);
  const [chartPriceAlerts, setChartPriceAlerts] = useState<TerminalChartPriceAlertSnapshot>(EMPTY_TERMINAL_CHART_PRICE_ALERT_SNAPSHOT);
  const [savedPlanWatchRequest, setSavedPlanWatchRequest] = useState<TerminalSavedPlanAlertRequest | null>(null);
  const [savedPlanRemovalRequest, setSavedPlanRemovalRequest] = useState<TerminalSavedPlanAlertRemovalRequest | null>(null);
  const [savedPlanInventory, setSavedPlanInventory] = useState<readonly TerminalSavedPlanInventoryItem[] | null>(null);
  const [watchedSavedPlanIds, setWatchedSavedPlanIds] = useState<readonly string[]>([]);
  const savedPlanWatchSequenceRef = useRef(0);
  const [workspaceLoadedStorageKey, setWorkspaceLoadedStorageKey] = useState<string | null>(null);
  const [workspaceStorageBlocked, setWorkspaceStorageBlocked] = useState(false);
  const [workspaceStorageConflict, setWorkspaceStorageConflict] = useState(false);
  const workspaceExpectedRawRef = useRef<string | null>(null);
  const currentWorkspace = useMemo<TerminalWorkspace>(() => ({
    version: TERMINAL_WORKSPACE_VERSION,
    venue: venueId,
    market: marketSel as TerminalWorkspace["market"],
    network: hyperliquidNetwork,
    interval: chartInterval,
    chartSurface,
    chartMode,
    chartStudies,
    side,
    notionalUsd: notional,
    riskBudgetUsd,
    slippageBps: slippageBps as 25 | 50 | 100,
    targetRewardMultiple,
    bookOpen,
    bookView,
    marketRailWidthPx,
    ticketWidthPx,
  }), [bookOpen, bookView, chartInterval, chartMode, chartStudies, chartSurface, hyperliquidNetwork, marketRailWidthPx, marketSel, notional, riskBudgetUsd, side, slippageBps, targetRewardMultiple, ticketWidthPx, venueId]);
  const currentWorkspaceRef = useRef(currentWorkspace);
  currentWorkspaceRef.current = currentWorkspace;
  const applyWorkspaceState = useCallback((saved: TerminalWorkspace, message?: string) => {
    previewRequestIdRef.current += 1;
    liveExecutionEpochRef.current += 1;
    setVenueId(saved.venue);
    setMarketSel(saved.market);
    setHyperliquidNetwork(saved.network);
    setChartInterval(saved.interval);
    setChartSurface(saved.chartSurface);
    setChartMode(saved.chartMode);
    setChartStudies(saved.chartStudies);
    setSide(saved.side);
    setNotional(saved.notionalUsd);
    riskBudgetUsdRef.current = saved.riskBudgetUsd;
    setRiskBudgetUsd(saved.riskBudgetUsd);
    setSlippageBps(saved.slippageBps);
    setTargetRewardMultiple(saved.targetRewardMultiple);
    setBookOpen(saved.bookOpen);
    setBookView(saved.bookView);
    setMarketRailWidthPx(saved.marketRailWidthPx);
    setTicketWidthPx(saved.ticketWidthPx);
    setEntryPrice(null);
    setEntryPinned(false);
    setStopPrice(null);
    setStopPinned(false);
    setPreview({ status: "idle" });
    setBoundPlanAuditSnapshot(null);
    setLiveExecution({ status: "idle" });
    setSignedPayloadText("");
    setReplayScenario({ active: false, frame: null, context: null });
    setRouteCheckOpen(false);
    if (message) setKeyboardMessage(message);
  }, []);
  const captureWorkspace = useCallback((): TerminalWorkspace => ({
    ...currentWorkspaceRef.current,
    chartStudies: [...currentWorkspaceRef.current.chartStudies],
  }), []);
  const loadWorkspace = useCallback((input: TerminalWorkspace) => {
    if (liveExecutionInFlightRef.current) return false;
    const saved = validateTerminalWorkspace(input);
    if (!saved) {
      setKeyboardMessage("Workspace load blocked: saved state is invalid");
      return false;
    }
    applyWorkspaceState(
      saved,
      `Workspace ${saved.market} ${saved.interval} loaded · bound preview, signature, replay, and pinned levels cleared; no order submitted`,
    );
    return true;
  }, [applyWorkspaceState]);
  const resetBlockedWorkspaceStorage = useCallback(() => {
    if (
      !workspaceStorageBlocked
      || workspaceStorageConflict
      || !workspaceStorageKey
      || !window.confirm("Replace unreadable saved workspace data with the current safe layout? This cannot be undone.")
    ) return;
    try {
      const serialized = serializeTerminalWorkspace(currentWorkspaceRef.current);
      window.localStorage.setItem(workspaceStorageKey, serialized);
      workspaceExpectedRawRef.current = serialized;
      setWorkspaceStorageBlocked(false);
      setWorkspaceStorageConflict(false);
      setKeyboardMessage("Workspace storage reset with the current safe layout; no order submitted.");
    } catch {
      setKeyboardMessage("Workspace storage remains unavailable; original data was not replaced.");
    }
  }, [workspaceStorageBlocked, workspaceStorageConflict, workspaceStorageKey]);
  const resolveWorkspaceStorageConflict = useCallback((source: "stored" | "local") => {
    if (!workspaceStorageConflict || !workspaceStorageKey) return;
    if (liveExecutionInFlightRef.current) {
      setKeyboardMessage("Workspace conflict recovery waits for the current live execution request to settle.");
      return;
    }
    const confirmation = source === "stored"
      ? "Use the workspace currently stored by the other tab? This tab's concurrent layout changes will be discarded."
      : "Replace the other tab's stored workspace with this tab's complete current layout?";
    if (!window.confirm(confirmation)) return;
    try {
      if (source === "stored") {
        const raw = window.localStorage.getItem(workspaceStorageKey);
        const inspection = inspectTerminalWorkspace(raw);
        if (inspection.status !== "ready") throw new Error("terminal_workspace_conflict_target_invalid");
        workspaceExpectedRawRef.current = raw;
        applyWorkspaceState(inspection.workspace);
      } else {
        const serialized = serializeTerminalWorkspace(currentWorkspaceRef.current);
        window.localStorage.setItem(workspaceStorageKey, serialized);
        workspaceExpectedRawRef.current = serialized;
      }
      setWorkspaceStorageBlocked(false);
      setWorkspaceStorageConflict(false);
      setKeyboardMessage(source === "stored"
        ? "Loaded the workspace stored by the other tab; preview, signature, replay, and pinned levels were cleared."
        : "This tab's complete workspace replaced the conflicting stored version; no order submitted.");
    } catch {
      setKeyboardMessage("Workspace conflict recovery failed. Automatic layout writes remain locked.");
    }
  }, [applyWorkspaceState, workspaceStorageConflict, workspaceStorageKey]);
  const handleLiveAccountRiskDecision = useCallback((next: TerminalLiveAccountRiskDecision) => {
    const current = liveAccountRiskDecisionRef.current;
    const reviewEvidenceCrossed = next.accountStreamCurrent && terminalLiveExecutionReviewEvidenceCrossed(
      liveExecutionJournalRef.current,
      current?.accountStreamObservedAtMs ?? null,
      next.accountStreamObservedAtMs,
    );
    liveAccountRiskDecisionRef.current = next;
    if (terminalLiveAccountRiskDecisionEqual(current, next) && !reviewEvidenceCrossed) return;
    liveExecutionEpochRef.current += 1;
    setLiveAccountRiskDecision(next);
  }, []);
  const handleInspectLiveAccountMarket = useCallback((target: { market: string; network: "mainnet" | "testnet" }) => {
    if (liveExecutionInFlightRef.current) {
      setKeyboardMessage("Account-market navigation waits for the current live execution to settle.");
      return;
    }
    const hyperliquid = VENUES.find((item) => item.id === "hyperliquid");
    if (
      venueId !== "hyperliquid"
      || target.network !== hyperliquidNetwork
      || !hyperliquid?.markets.includes(target.market)
    ) {
      setKeyboardMessage("Account-market navigation blocked: the row no longer matches the selected Hyperliquid account context.");
      return;
    }
    if (marketSel === target.market) {
      setKeyboardMessage(`${target.market} is already selected. No order submitted.`);
      return;
    }
    previewRequestIdRef.current += 1;
    liveExecutionEpochRef.current += 1;
    setMarketSel(target.market);
    setEntryPrice(null);
    setEntryPinned(false);
    setStopPrice(null);
    setStopPinned(false);
    setPreview({ status: "idle" });
    setBoundPlanAuditSnapshot(null);
    setLiveExecution({ status: "idle" });
    setSignedPayloadText("");
    setReplayScenario({ active: false, frame: null, context: null });
    setKeyboardMessage(`Inspecting ${target.market} on Hyperliquid ${target.network}; bound preview, signature, replay, and pinned levels cleared. Awaiting fresh market data. No order submitted.`);
  }, [hyperliquidNetwork, marketSel, venueId]);
  const handleAlertSummaryChange = useCallback((next: TerminalAlertSummary) => {
    setAlertSummary((current) => terminalAlertSummaryEqual(current, next) ? current : next);
  }, []);
  const handleChartPriceAlertsChange = useCallback((next: TerminalChartPriceAlertSnapshot) => {
    setChartPriceAlerts((current) => terminalChartPriceAlertSnapshotEqual(current, next) ? current : next);
  }, []);
  const openTerminalAlertManager = useCallback(() => {
    window.dispatchEvent(new Event("ghola:open-alerts"));
    document.getElementById("terminal-alerts")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);
  const updateLiveExecutionJournalStorageStatus = useCallback((next: TerminalLiveExecutionJournalStorageStatus) => {
    liveExecutionJournalStorageStatusRef.current = next;
    setLiveExecutionJournalStorageStatus(next);
  }, []);
  const recordLiveExecutionJournalEntry = useCallback((
    entry: TerminalLiveExecutionJournalEntry,
    subjectScope = liveExecutionJournalSubjectScopeRef.current,
  ) => {
    if (!subjectScope) {
      updateLiveExecutionJournalStorageStatus("blocked");
      return false;
    }
    const persisted = persistTerminalLiveExecutionJournalEntry(window.localStorage, subjectScope, entry);
    if (subjectScope === liveExecutionJournalSubjectScopeRef.current) {
      if (!persisted.ok) {
        updateLiveExecutionJournalStorageStatus("blocked");
      } else {
        liveExecutionJournalRef.current = persisted.entries;
        setLiveExecutionJournal(persisted.entries);
      }
    }
    return persisted.ok;
  }, [updateLiveExecutionJournalStorageStatus]);
  const discardLiveExecutionPendingEntry = useCallback((
    planDigest: string,
    subjectScope = liveExecutionJournalSubjectScopeRef.current,
  ) => {
    if (!subjectScope) return false;
    const discarded = discardTerminalLiveExecutionPendingEntry(window.localStorage, subjectScope, planDigest);
    if (subjectScope === liveExecutionJournalSubjectScopeRef.current) {
      if (!discarded.ok) {
        updateLiveExecutionJournalStorageStatus("blocked");
      } else {
        liveExecutionJournalRef.current = discarded.entries;
        setLiveExecutionJournal(discarded.entries);
      }
    }
    return discarded.ok;
  }, [updateLiveExecutionJournalStorageStatus]);
  const recheckLiveExecutionJournalSafety = useCallback(() => {
    if (liveExecutionJournalStorageStatusRef.current !== "ready") {
      return liveExecutionJournalStorageStatusRef.current;
    }
    try {
      const subjectScope = liveExecutionJournalSubjectScopeRef.current;
      if (!subjectScope) return "blocked" as const;
      const stored = readTerminalLiveExecutionJournalStorage(window.localStorage, subjectScope);
      return terminalLiveExecutionJournalSafetyState(stored.status, stored.entries);
    } catch {
      return "blocked" as const;
    }
  }, []);
  const handleRiskBudgetChange = useCallback((value: number) => {
    if (!allowTerminalPlanMutation()) return;
    riskBudgetUsdRef.current = value;
    previewRequestIdRef.current += 1;
    liveExecutionEpochRef.current += 1;
    setRiskBudgetUsd(value);
  }, [allowTerminalPlanMutation]);
  const handleTicketDecimalStatus = useCallback((field: TicketDecimalField, status: "settled" | "valid" | "incomplete" | "invalid") => {
    const blocked = status === "incomplete" || status === "invalid";
    setTicketDecimalBlocks((current) => current[field] === blocked ? current : { ...current, [field]: blocked });
    if (blocked) {
      previewRequestIdRef.current += 1;
      liveExecutionEpochRef.current += 1;
      setPreview((current) => current.status === "idle" ? current : { status: "idle" });
      setSignedPayloadText("");
    }
  }, []);
  const handleRiskBudgetDraftStatus = useCallback(
    (status: "settled" | "valid" | "incomplete" | "invalid") => handleTicketDecimalStatus("risk_budget", status),
    [handleTicketDecimalStatus],
  );
  const handleApplyRiskSizedNotional = useCallback((value: number) => {
    if (!allowTerminalPlanMutation()) return;
    if (!Number.isFinite(value) || value < MIN_TRADE_NOTIONAL_USD) return;
    const bounded = floorTerminalNotionalUsd(Math.min(
      MAX_TRADE_NOTIONAL_USD,
      Math.max(MIN_TRADE_NOTIONAL_USD, value),
    ));
    if (bounded == null) return;
    previewRequestIdRef.current += 1;
    liveExecutionEpochRef.current += 1;
    setNotional(bounded);
  }, [allowTerminalPlanMutation]);
  const selectVenue = useCallback((nextVenueId: VenueId) => {
    if (!allowTerminalPlanMutation()) return;
    const nextVenue = VENUES.find((item) => item.id === nextVenueId) ?? VENUES[0];
    setVenueId(nextVenue.id);
    setMarketSel(nextVenue.defaultMarket);
    setEntryPinned(false);
    setStopPinned(false);
  }, [allowTerminalPlanMutation]);
  const selectMarket = useCallback((nextMarket: string) => {
    if (!allowTerminalPlanMutation()) return;
    setMarketSel(nextMarket);
    setEntryPinned(false);
    setStopPinned(false);
  }, [allowTerminalPlanMutation]);
  const selectInterval = useCallback((nextInterval: ChartInterval) => {
    if (!allowTerminalPlanMutation()) return;
    setChartInterval(nextInterval);
  }, [allowTerminalPlanMutation]);
  const handleWatchlistSelect = useCallback((nextVenueId: TerminalWatchlistVenue, nextInstrument: TerminalWatchlistInstrument) => {
    if (liveExecutionInFlightRef.current) {
      setKeyboardMessage("Scanner navigation waits for the current live execution request to settle.");
      return;
    }
    const nextVenue = VENUES.find((candidate) => candidate.id === nextVenueId);
    if (!nextVenue?.markets.includes(nextInstrument)) {
      setKeyboardMessage("Scanner navigation blocked: the selected venue does not support that instrument.");
      return;
    }
    previewRequestIdRef.current += 1;
    liveExecutionEpochRef.current += 1;
    setVenueId(nextVenueId);
    setMarketSel(nextInstrument);
    setEntryPrice(null);
    setEntryPinned(false);
    setStopPrice(null);
    setStopPinned(false);
    setTicketDecimalBlocks({ notional: false, risk_budget: false, entry: false, invalidation: false });
    setPreview({ status: "idle" });
    setBoundPlanAuditSnapshot(null);
    setSignedPayloadText("");
    setLiveExecution({ status: "idle" });
    setReplayScenario({ active: false, frame: null, context: null });
    setRouteCheckOpen(false);
    setKeyboardMessage(`Loading ${nextInstrument} on ${nextVenue.label}; execution bindings and pinned levels cleared. Awaiting fresh certification; no order submitted.`);
  }, []);
  const selectPaperMarkMarket = useCallback((target: TerminalPaperMarketTarget) => {
    if (liveExecutionInFlightRef.current) {
      setKeyboardMessage("PAPER mark recovery waits for the current live execution to settle. Retry when execution is idle.");
      return false;
    }
    const nextVenue = VENUES.find((item) => item.id === target.venueId);
    const exactTarget = Boolean(
      nextVenue &&
      nextVenue.markets.includes(target.market) &&
      venueProductLabel(target.venueId, target.market) === target.product &&
      (target.venueId === "hyperliquid" || target.network === "mainnet"),
    );
    if (!nextVenue || !exactTarget) {
      setKeyboardMessage("PAPER mark recovery blocked: unsupported persisted market identity.");
      return false;
    }
    previewRequestIdRef.current += 1;
    liveExecutionEpochRef.current += 1;
    setVenueId(target.venueId);
    setMarketSel(target.market);
    if (target.venueId === "hyperliquid") setHyperliquidNetwork(target.network);
    setEntryPrice(null);
    setEntryPinned(false);
    setStopPrice(null);
    setStopPinned(false);
    setPreview({ status: "idle" });
    setBoundPlanAuditSnapshot(null);
    setLiveExecution({ status: "idle" });
    setSignedPayloadText("");
    setReplayScenario({ active: false, frame: null, context: null });
    setKeyboardMessage(`Loading ${target.product} on ${target.venueId} ${target.network}. Awaiting a fresh PAPER mark; pinned levels and bound preview cleared. No order submitted.`);
    return true;
  }, []);
  const inspectTerminalPlanIdentity = useCallback((identity: TerminalPlanBookIdentity) => {
    if (liveExecutionInFlightRef.current) return false;
    const nextVenue = VENUES.find((candidate) => candidate.id === identity.venue);
    const nextMarket = nextVenue?.markets.find((candidate) => venueProductLabel(identity.venue, candidate) === identity.product);
    const supported = Boolean(
      nextVenue
      && nextMarket
      && (identity.venue === "hyperliquid" || identity.network === "mainnet"),
    );
    if (!nextVenue || !nextMarket || !supported) return false;
    previewRequestIdRef.current += 1;
    liveExecutionEpochRef.current += 1;
    setVenueId(nextVenue.id);
    setMarketSel(nextMarket);
    setChartInterval(identity.interval);
    if (identity.venue === "hyperliquid") setHyperliquidNetwork(identity.network);
    setEntryPrice(null);
    setEntryPinned(false);
    setStopPrice(null);
    setStopPinned(false);
    setPreview({ status: "idle" });
    setBoundPlanAuditSnapshot(null);
    setSignedPayloadText("");
    setLiveExecution({ status: "idle" });
    setReplayScenario({ active: false, frame: null, context: null });
    setKeyboardMessage(`Inspecting ${identity.product} on ${identity.venue} ${identity.network} ${identity.interval}; execution bindings and pinned levels cleared. Awaiting fresh certification; no plan restored or order submitted.`);
    return true;
  }, []);
  const venue = VENUES.find((item) => item.id === venueId) ?? VENUES[0];
  const liveOrderMode = useMemo(() => terminalLiveOrderMode(venue.id), [venue.id]);
  const productLabel = venueProductLabel(venue.id, marketSel);
  const unifiedMarket = useUnifiedLiveMarket({
    venue: venue.id,
    market: marketSel,
    interval: chartInterval,
    hyperliquidNetwork,
    restartKey: marketRestartKey,
  });
  const selectedLiveFrame = terminalFrameMatchesSelection(unifiedMarket.frame, {
    venue: venue.id,
    market: marketSel,
    interval: chartInterval,
  }) ? unifiedMarket.frame : null;
  const frame = useMemo(
    () => selectedLiveFrame ?? (
      unifiedMarket.loading ? null : fallbackFrame(venue, marketSel, chartInterval)
    ),
    [chartInterval, marketSel, selectedLiveFrame, unifiedMarket.loading, venue],
  );
  const loadingMarket = unifiedMarket.loading;
  const marketError = unifiedMarket.error;
  const compareWorkspaceActive = chartSurface === "terminal" && chartMode === "compare";
  const routeFeedsEnabled = compareWorkspaceActive || routeCheckOpen;
  const crossVenueMarket = useCrossVenueLiveMarket({
    currentVenue: venue.id,
    market: marketSel,
    interval: chartInterval,
    hyperliquidNetwork,
    enabled: routeFeedsEnabled,
  });
  const compareFrames = crossVenueMarket.comparisonFrames;
  const venueHealth = useMemo(
    () => summarizeCrossVenueHealth(venue.id, unifiedMarket, crossVenueMarket.health),
    [crossVenueMarket.health, unifiedMarket, venue.id],
  );
  const marketFeedPeerGrades = useMemo(() => routeFeedsEnabled
    ? venueHealth.health
      .filter((item) => item.venue !== venue.id)
      .map((item) => ({ venue: item.venue, grade: item.telemetry.healthGrade }))
    : [], [routeFeedsEnabled, venue.id, venueHealth.health]);
  const watchlistSources = useMemo<TerminalWatchlistSource[]>(() => {
    const telemetryCapturedAtMs = Date.now();
    const primary = selectedLiveFrame ? [{
      frame: selectedLiveFrame,
      status: unifiedMarket.status,
      stale: unifiedMarket.stale,
      provenance: "public_live" as const,
      healthGrade: unifiedMarket.telemetry.healthGrade,
      transport: unifiedMarket.transport,
      componentAgesMs: unifiedMarket.telemetry.componentAgesMs,
      telemetryCapturedAtMs,
    }] : [];
    const peers = compareFrames.flatMap((peerFrame) => {
      const health = venueHealth.health.find((item) => item.venue === peerFrame.venue);
      return health ? [{
        frame: peerFrame,
        status: health.sourceStatus,
        stale: health.stale,
        provenance: "public_live" as const,
        healthGrade: health.telemetry.healthGrade,
        transport: health.sourceStatus === "live"
          ? "websocket" as const
          : health.sourceStatus === "fallback_polling"
            ? "polling" as const
            : null,
        componentAgesMs: health.telemetry.componentAgesMs,
        telemetryCapturedAtMs,
      }] : [];
    });
    return [...primary, ...peers];
  }, [compareFrames, selectedLiveFrame, unifiedMarket.stale, unifiedMarket.status, unifiedMarket.telemetry, unifiedMarket.transport, venueHealth.health]);

  const applyAgentStartup = useCallback((startup: PublicAgentStartupStatus) => {
    setAgentStartup(startup);
    setAgentStartupSubject(authenticatedSubject);
    if (!startup.runtime.ready) return;
    setAgentWakeState("ready");
    setAgentWakeMessage((message) =>
      message?.startsWith("Starting secure worker") ? startup.runtime.message : message
    );
    setWorkerReady(true);
    setWorkerLabel("attested");
  }, [authenticatedSubject]);
  const handleReplayFrameChange = useCallback((
    nextFrame: GholaMarketFrame | null,
    active: boolean,
    context: GholaReplayContext | null,
  ) => {
    const scopedFrame = active ? nextFrame : null;
    const scopedContext = active ? context : null;
    setReplayScenario((current) => (
      current.active === active && current.frame === scopedFrame && current.context === scopedContext
        ? current
        : { active, frame: scopedFrame, context: scopedContext }
    ));
  }, []);
  const scenarioReplayActive = replayScenario.active;
  const [liveComponentExpiryTickAt, setLiveComponentExpiryTickAt] = useState(() => Date.now());
  const liveReceiptAtMs = Date.parse(unifiedMarket.telemetry.lastReceiptAt ?? "");
  const liveObservationNowMs = useMemo(
    () => Math.max(
      liveComponentExpiryTickAt,
      Number.isFinite(liveReceiptAtMs) ? liveReceiptAtMs : Date.now(),
    ),
    [liveComponentExpiryTickAt, liveReceiptAtMs],
  );
  useEffect(() => {
    const refreshObservationClock = () => {
      if (!document.hidden) setLiveComponentExpiryTickAt(Date.now());
    };
    document.addEventListener("visibilitychange", refreshObservationClock);
    window.addEventListener("focus", refreshObservationClock);
    return () => {
      document.removeEventListener("visibilitychange", refreshObservationClock);
      window.removeEventListener("focus", refreshObservationClock);
    };
  }, []);
  const liveMarketContextInput: TerminalLiveMarketContextInput = {
    frame: selectedLiveFrame,
    venue: venue.id,
    network: venue.id === "hyperliquid" ? hyperliquidNetwork : "mainnet",
    market: marketSel,
    interval: chartInterval,
    status: unifiedMarket.status,
    controllerStale: unifiedMarket.stale,
    maxAgeMs: marketFreshnessLimitMs(chartInterval),
  };
  const liveMarketContextInputRef = useRef(liveMarketContextInput);
  liveMarketContextInputRef.current = liveMarketContextInput;
  const liveMarketContext = useMemo(() => deriveTerminalLiveMarketContext({
    frame: selectedLiveFrame,
    venue: venue.id,
    network: venue.id === "hyperliquid" ? hyperliquidNetwork : "mainnet",
    market: marketSel,
    interval: chartInterval,
    status: unifiedMarket.status,
    controllerStale: unifiedMarket.stale,
    maxAgeMs: marketFreshnessLimitMs(chartInterval),
    nowMs: liveObservationNowMs,
  }), [
    chartInterval,
    hyperliquidNetwork,
    liveObservationNowMs,
    marketSel,
    selectedLiveFrame,
    unifiedMarket.stale,
    unifiedMarket.status,
    venue.id,
  ]);
  const fundingRateSignal = useMemo(() => deriveTerminalFundingRateSignal({
    frame: selectedLiveFrame,
    marketState: unifiedMarket,
    source: "unified_live",
    selection: {
      venue: venue.id,
      network: venue.id === "hyperliquid" ? hyperliquidNetwork : "mainnet",
      market: marketSel,
      interval: chartInterval,
    },
    productClass: venue.id === "coinbase" ? "spot" : "perpetual",
    nowMs: liveObservationNowMs,
  }), [chartInterval, hyperliquidNetwork, liveObservationNowMs, marketSel, selectedLiveFrame, unifiedMarket, venue.id]);
  const fundingCarryPreview = useMemo(() => projectTerminalFundingCarry({
    funding: fundingRateSignal,
    productClass: venue.id === "coinbase" ? "spot" : "perpetual",
    side,
    notionalUsd: notional,
  }), [fundingRateSignal, notional, side, venue.id]);
  const priceAuthority = useMemo(() => deriveTerminalPriceAuthority({
    chartFrame: frame,
    liveMarketContext,
  }), [frame, liveMarketContext]);
  const mid = priceAuthority.certifiedMid;
  const marketFieldAuthority = useMemo(() => deriveTerminalMarketFieldAuthority({
    frame: selectedLiveFrame,
    liveMarketContext,
    maxAgeMs: marketFreshnessLimitMs(chartInterval),
    nowMs: liveObservationNowMs,
  }), [chartInterval, liveMarketContext, liveObservationNowMs, selectedLiveFrame]);
  const priceDraftBounds = mid != null && mid >= 1_000 ? HIGH_PRICE_DRAFT_BOUNDS : LOW_PRICE_DRAFT_BOUNDS;
  const certifiedSignals = useMemo(() => deriveTerminalCertifiedMarketSignals({
    frame,
    source: selectedLiveFrame && frame === selectedLiveFrame ? "public_live" : "synthetic",
    selection: {
      venue: venue.id,
      network: venue.id === "hyperliquid" ? hyperliquidNetwork : "mainnet",
      market: marketSel,
      interval: chartInterval,
    },
    status: unifiedMarket.status,
    controllerStale: unifiedMarket.stale,
    componentAgesMs: unifiedMarket.telemetry.componentAgesMs,
    nowMs: liveObservationNowMs,
  }), [
    chartInterval,
    frame,
    hyperliquidNetwork,
    liveObservationNowMs,
    marketSel,
    selectedLiveFrame,
    unifiedMarket.stale,
    unifiedMarket.status,
    unifiedMarket.telemetry.componentAgesMs,
    venue.id,
  ]);
  const certifiedTradeStageRef = useRef({
    identityKey: certifiedSignals.evaluationIdentityKey,
    ready: certifiedSignals.components.trades.ready,
  });
  certifiedTradeStageRef.current = {
    identityKey: certifiedSignals.evaluationIdentityKey,
    ready: certifiedSignals.components.trades.ready,
  };
  const certifiedBookFrame = certifiedSignals.bookFrame;
  const certifiedBookBids = certifiedBookFrame?.bids ?? null;
  const certifiedBookAsks = certifiedBookFrame?.asks ?? null;
  const certifiedBookBestBid = certifiedBookFrame?.bestBid ?? null;
  const certifiedBookBestAsk = certifiedBookFrame?.bestAsk ?? null;
  const certifiedBookInput = useMemo<TerminalEntryOutcomeBook | null>(() => (
    certifiedBookBids && certifiedBookAsks
      ? {
          bids: certifiedBookBids,
          asks: certifiedBookAsks,
          bestBid: certifiedBookBestBid,
          bestAsk: certifiedBookBestAsk,
        }
      : null
  ), [certifiedBookAsks, certifiedBookBestAsk, certifiedBookBestBid, certifiedBookBids]);
  const recheckLiveMarketContext = useCallback(() => deriveTerminalLiveMarketContext({
    ...liveMarketContextInputRef.current,
    nowMs: Date.now(),
  }), []);

  const marketComponentTimestamps = selectedLiveFrame?.componentTimestamps;
  const boundPlanExpiresAtMs = Date.parse(boundPlanAuditSnapshot?.expiresAt ?? "");
  const boundPlanMarketAtMs = Date.parse(boundPlanAuditSnapshot?.orderPlan.market_context.fetched_at ?? "");
  const boundPlanMarketDeadlineMs = boundPlanMarketAtMs
    + (boundPlanAuditSnapshot?.orderPlan.market_context.max_age_ms ?? Number.NaN);
  useEffect(() => {
    const nowMs = Date.now();
    const freshnessMs = marketFreshnessLimitMs(chartInterval);
    const deadlines = [
      marketComponentTimestamps?.quote == null ? null : marketComponentTimestamps.quote + freshnessMs,
      marketComponentTimestamps?.book == null ? null : marketComponentTimestamps.book + freshnessMs,
      marketComponentTimestamps?.trades == null ? null : marketComponentTimestamps.trades + freshnessMs,
      marketComponentTimestamps?.market == null ? null : marketComponentTimestamps.market + freshnessMs,
      marketComponentTimestamps?.candles == null
        ? null
        : marketComponentTimestamps.candles + chartIntervalMs(chartInterval) + freshnessMs,
      fundingRateSignal.available ? fundingRateSignal.expiresAtMs : null,
      boundPlanExpiresAtMs,
      boundPlanMarketDeadlineMs,
    ].filter((deadline): deadline is number => Number.isFinite(deadline) && deadline != null && deadline >= nowMs);
    if (!deadlines.length) return;
    const remainingMs = Math.min(...deadlines) - nowMs;
    const timer = window.setTimeout(
      () => setLiveComponentExpiryTickAt(Date.now()),
      remainingMs + 1,
    );
    return () => window.clearTimeout(timer);
  }, [boundPlanExpiresAtMs, boundPlanMarketDeadlineMs, chartInterval, fundingRateSignal, liveComponentExpiryTickAt, marketComponentTimestamps]);

  useEffect(() => {
    setLocalPreview(isLocalPreviewRuntime());
  }, []);

  useLayoutEffect(() => {
    if (!workspaceStorageKey) {
      applyWorkspaceState(defaultTerminalWorkspace());
      setWorkspaceStorageBlocked(false);
      setWorkspaceStorageConflict(false);
      workspaceExpectedRawRef.current = null;
      setWorkspaceLoadedStorageKey(null);
      return;
    }
    let saved = defaultTerminalWorkspace();
    try {
      const raw = window.localStorage.getItem(workspaceStorageKey);
      workspaceExpectedRawRef.current = raw;
      const inspection = inspectTerminalWorkspace(raw);
      if (inspection.status === "ready") saved = inspection.workspace;
      setWorkspaceStorageBlocked(inspection.status === "blocked");
      setWorkspaceStorageConflict(false);
    } catch {
      setWorkspaceStorageBlocked(true);
      setWorkspaceStorageConflict(false);
    }
    applyWorkspaceState(saved);
    setWorkspaceLoadedStorageKey(workspaceStorageKey);
  }, [applyWorkspaceState, workspaceStorageKey]);

  useEffect(() => {
    if (
      !workspaceStorageKey
      || workspaceLoadedStorageKey !== workspaceStorageKey
      || workspaceStorageBlocked
    ) return;
    try {
      const storedRaw = window.localStorage.getItem(workspaceStorageKey);
      if (storedRaw !== workspaceExpectedRawRef.current) {
        setWorkspaceStorageBlocked(true);
        setWorkspaceStorageConflict(true);
        setKeyboardMessage("Workspace changed in another tab. Automatic layout writes stopped before overwriting it.");
        return;
      }
      const serialized = serializeTerminalWorkspace(currentWorkspace);
      window.localStorage.setItem(workspaceStorageKey, serialized);
      workspaceExpectedRawRef.current = serialized;
    } catch {
      // Keep the workstation usable if storage is unavailable or a transient state is invalid.
    }
  }, [currentWorkspace, workspaceLoadedStorageKey, workspaceStorageBlocked, workspaceStorageKey]);

  useEffect(() => {
    if (!workspaceStorageKey) return;
    const activeKey = workspaceStorageKey;
    function observeWorkspaceStorage(event: StorageEvent) {
      if (event.key !== activeKey) return;
      try {
        if (event.storageArea && event.storageArea !== window.localStorage) return;
      } catch {
        setWorkspaceStorageBlocked(true);
        setKeyboardMessage("Workspace storage became unavailable; automatic layout writes are locked.");
        return;
      }
      const inspection = inspectTerminalWorkspace(event.newValue);
      if (inspection.status !== "ready") {
        setWorkspaceStorageBlocked(true);
        setWorkspaceStorageConflict(false);
        setKeyboardMessage("Workspace storage changed in another tab and is unreadable; original bytes are preserved.");
      } else if (
        liveExecutionInFlightRef.current
        || terminalWorkspaceConcurrentConflict({
          local: currentWorkspaceRef.current,
          previousValue: event.oldValue,
          incoming: inspection.workspace,
        })
      ) {
        setWorkspaceStorageBlocked(true);
        setWorkspaceStorageConflict(true);
        setKeyboardMessage("Concurrent workspace edits detected. Choose which complete layout to keep; no automatic winner was selected.");
      } else {
        workspaceExpectedRawRef.current = event.newValue;
        applyWorkspaceState(
          inspection.workspace,
          "Workspace synchronized from another tab; preview, signature, replay, and pinned levels cleared. No order submitted.",
        );
        setWorkspaceStorageBlocked(false);
        setWorkspaceStorageConflict(false);
      }
    }
    window.addEventListener("storage", observeWorkspaceStorage);
    return () => window.removeEventListener("storage", observeWorkspaceStorage);
  }, [applyWorkspaceState, workspaceStorageKey]);

  useEffect(() => {
    const subjectScope = liveExecutionSubjectScope;
    const journalKey = subjectScope ? terminalLiveExecutionJournalStorageKey(subjectScope) : null;
    const lockPrefix = subjectScope ? terminalLiveExecutionLockStoragePrefix(subjectScope) : null;
    if (!subjectScope || !journalKey || !lockPrefix) {
      liveExecutionJournalRef.current = [];
      setLiveExecutionJournal([]);
      setLiveExecutionJournalLoadedScope(null);
      updateLiveExecutionJournalStorageStatus("loading");
      return;
    }
    liveExecutionJournalRef.current = [];
    setLiveExecutionJournal([]);
    updateLiveExecutionJournalStorageStatus("loading");
    const readStoredJournal = () => {
      const stored = readTerminalLiveExecutionJournalStorage(window.localStorage, subjectScope);
      return stored.status === "ready" ? stored.entries : null;
    };
    const applyStoredJournal = (deletedJournal = false) => {
      setLiveExecutionJournalLoadedScope(subjectScope);
      if (deletedJournal) {
        updateLiveExecutionJournalStorageStatus("blocked");
        return;
      }
      const parsed = readStoredJournal();
      if (!parsed) {
        updateLiveExecutionJournalStorageStatus("blocked");
        return;
      }
      liveExecutionJournalRef.current = parsed;
      setLiveExecutionJournal(parsed);
      updateLiveExecutionJournalStorageStatus("ready");
    };
    try {
      if (window.localStorage.getItem(journalKey) == null) {
        window.localStorage.setItem(
          journalKey,
          serializeTerminalLiveExecutionJournal([]),
        );
      }
      applyStoredJournal();
    } catch {
      updateLiveExecutionJournalStorageStatus("blocked");
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key == null) {
        liveExecutionEpochRef.current += 1;
        updateLiveExecutionJournalStorageStatus("blocked");
        return;
      }
      const journalEvent = event.key === journalKey;
      const lockEvent = event.key?.startsWith(lockPrefix) === true;
      const legacyEvent = event.key === TERMINAL_LIVE_EXECUTION_LEGACY_JOURNAL_STORAGE_KEY
        || event.key.startsWith(TERMINAL_LIVE_EXECUTION_LEGACY_LOCK_STORAGE_PREFIX);
      if (!journalEvent && !lockEvent && !legacyEvent) return;
      liveExecutionEpochRef.current += 1;
      applyStoredJournal(journalEvent && event.newValue == null);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [liveExecutionSubjectScope, updateLiveExecutionJournalStorageStatus]);

  useEffect(() => {
    if (localPreview) {
      setLiveStatus(null);
      setLiveStatusReceivedAt(null);
      setLiveStatusSubject(authenticatedSubject);
      setWorkerReady(false);
      setWorkerLabel("local off");
      setWorkerWakeState("idle");
      return;
    }
    let statusRequestId = 0;
    let latestLiveCheckedAt = Number.NEGATIVE_INFINITY;
    let latestLiveStatus: PrivateAccountLiveTradingStatus | null = null;
    async function refreshLiveStatus(signal: AbortSignal) {
      const res = await fetch("/v1/private-account/live-trading/status", { cache: "no-store", signal });
      if (!res.ok) return null;
      return await res.json() as unknown;
    }
    async function refreshWorkerStatus(signal: AbortSignal) {
      const res = await fetch("/api/private-agent/status", { cache: "no-store", signal });
      if (!res.ok) return null;
      return await res.json() as {
        remote_execution_ready?: boolean;
        providers?: Array<{ id: string; evidence?: { cvm_status?: string } }>;
      };
    }
    function applyWorkerStatus(worker: Awaited<ReturnType<typeof refreshWorkerStatus>>) {
      if (!worker) return;
      setWorkerReady(worker.remote_execution_ready === true);
      const phala = worker.providers?.find((provider) => provider.id === "phala");
      setWorkerLabel(worker.remote_execution_ready ? "attested" : phala?.evidence?.cvm_status || "off");
    }
    function applyLiveStatus(status: unknown, requestId: number) {
      if (requestId !== statusRequestId) return false;
      const decision = terminalLiveStatusChronologyDecision({
        current: latestLiveStatus,
        latestCheckedAtMs: latestLiveCheckedAt,
        candidate: status,
      });
      if (decision.action === "ignore") return false;
      latestLiveCheckedAt = decision.checkedAtMs;
      latestLiveStatus = decision.status;
      setLiveStatus(decision.status);
      if (decision.action === "block") {
        setLiveStatusReceivedAt(null);
        setLiveStatusSubject(authenticatedSubject);
        return false;
      }
      setLiveStatusReceivedAt(Date.now());
      setLiveStatusSubject(authenticatedSubject);
      return true;
    }
    const poller = createTerminalSingleFlightPoller({
      intervalMs: TERMINAL_STATUS_POLL_INTERVAL_MS,
      timeoutMs: TERMINAL_STATUS_REQUEST_TIMEOUT_MS,
      async run(signal) {
        const requestId = ++statusRequestId;
        try {
          const [live, worker] = await Promise.all([
            refreshLiveStatus(signal),
            refreshWorkerStatus(signal),
          ]);
          if (signal.aborted || requestId !== statusRequestId) return;
          applyWorkerStatus(worker);
          if (live) {
            if (applyLiveStatus(live, requestId)) {
              if (latestLiveStatus?.pooled_live_trading_enabled) setWorkerWakeState("ready");
            }
          } else {
            setLiveStatus(null);
            setLiveStatusReceivedAt(null);
            setLiveStatusSubject(authenticatedSubject);
          }
        } catch {
          if (!signal.aborted && requestId === statusRequestId) {
            setLiveStatus(null);
            setLiveStatusReceivedAt(null);
            setLiveStatusSubject(authenticatedSubject);
            setWorkerLabel("unknown");
          }
        }
      },
    });
    poller.start();
    return () => {
      statusRequestId += 1;
      poller.stop();
    };
  }, [authenticatedSubject, localPreview]);

  useEffect(() => {
    if (liveStatusReceivedAt == null) return;
    const remaining = TERMINAL_LIVE_STATUS_MAX_AGE_MS - (Date.now() - liveStatusReceivedAt);
    if (remaining <= 0) {
      setLiveStatus(null);
      setLiveStatusReceivedAt(null);
      return;
    }
    const timer = window.setTimeout(() => {
      setLiveStatus(null);
      setLiveStatusReceivedAt(null);
    }, remaining + 1);
    return () => window.clearTimeout(timer);
  }, [liveStatusReceivedAt]);

  const refreshAgentStartup = useCallback(async () => {
    try {
      const startup = await getPublicAgentStartupStatus();
      applyAgentStartup(startup);
      setAgentStartupFailed(false);
      return startup;
    } catch {
      setAgentStartupFailed(true);
      return null;
    }
  }, [applyAgentStartup]);

  const handleWakeAgentWorker = useCallback(async () => {
    if (agentWakeState === "waking") return;
    if (isLocalPreviewRuntime()) {
      setAgentWakeState("idle");
      setAgentWakeMessage("Secure worker starts are disabled on localhost and local previews.");
      return;
    }
    setAgentWakeState("waking");
    setAgentWakeMessage("Starting secure worker. This can take about a minute.");
    try {
      const wake = await wakePublicAgentWorker();
      setAgentWakeMessage(wake.message);
      setAgentWakeState(wake.ready ? "ready" : wake.status === "warming" ? "waking" : "error");
      if (wake.ready) {
        setWorkerReady(true);
        setWorkerLabel("attested");
      } else if (wake.status === "warming") {
        setWorkerLabel("starting");
      }
      await refreshAgentStartup();
    } catch (error) {
      setAgentWakeState("error");
      setAgentWakeMessage(error instanceof Error ? error.message : "Worker start failed.");
    }
  }, [agentWakeState, refreshAgentStartup]);

  useEffect(() => {
    if (localPreview) {
      setAgentStartup(null);
      setAgentStartupSubject(authenticatedSubject);
      setAgentStartupFailed(false);
      setAgentWakeState("idle");
      setAgentWakeMessage("Secure worker starts are disabled on localhost and local previews.");
      return;
    }
    const poller = createTerminalSingleFlightPoller({
      intervalMs: TERMINAL_STATUS_POLL_INTERVAL_MS,
      timeoutMs: TERMINAL_STATUS_REQUEST_TIMEOUT_MS,
      async run(signal) {
        try {
          const startup = await getPublicAgentStartupStatus({ signal });
          if (signal.aborted) return;
          applyAgentStartup(startup);
          setAgentStartupFailed(false);
        } catch {
          if (!signal.aborted) setAgentStartupFailed(true);
        }
      },
    });
    poller.start();
    return () => poller.stop();
  }, [applyAgentStartup, authenticatedSubject, localPreview, thumperAuth.authenticated]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const flow = params.get("flow");
    if (flow === "coinbase") {
      selectVenue("coinbase");
      return;
    }
    if (flow === "phoenix-live") {
      selectVenue("phoenix");
      return;
    }
    if (flow === "hyperliquid-live" || flow === "trade") {
      selectVenue("hyperliquid");
    }
  }, [selectVenue]);

  useEffect(() => {
    if (!mobileTicketOpen) return;
    const returnFocus = mobileTicketReturnFocusRef.current;
    const ticket = mobileTicketRef.current;
    const ticketTriggerRef = mobileTicketTriggerRef;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    queueMicrotask(() => mobileTicketCloseRef.current?.focus());
    function containTicketFocus(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setMobileTicketOpen(false);
        setOpenRow(null);
        setKeyboardMessage("Order ticket closed");
        return;
      }
      if (event.key !== "Tab" || !ticket) return;
      const focusable = Array.from(ticket.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => element.offsetParent !== null);
      if (!focusable.length) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1) ?? first;
      if (event.shiftKey && (document.activeElement === first || !ticket.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", containTicketFocus);
    return () => {
      document.removeEventListener("keydown", containTicketFocus);
      document.body.style.overflow = previousOverflow;
      const restoreFocus = restoreMobileTicketFocusRef.current;
      restoreMobileTicketFocusRef.current = true;
      if (restoreFocus) {
        mobileTicketReturnFocusRef.current = null;
        queueMicrotask(() => {
          const target = terminalTicketFocusRestoreTarget({
            returnFocus,
            mobileTrigger: ticketTriggerRef.current
              ?? document.getElementById(MOBILE_TICKET_TRIGGER_ID),
            desktopTarget: document.getElementById(TERMINAL_TICKET_FIELD_IDS.notional),
            desktop: window.matchMedia("(min-width: 1280px)").matches,
          });
          target?.focus();
        });
      }
    };
  }, [mobileTicketOpen]);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1280px)");
    function closeMobileTicketOnDesktop(event: MediaQueryListEvent | MediaQueryList) {
      if (event.matches) {
        setOpenRow(null);
        setMobileTicketOpen(false);
      }
    }
    closeMobileTicketOnDesktop(desktop);
    desktop.addEventListener("change", closeMobileTicketOnDesktop);
    return () => desktop.removeEventListener("change", closeMobileTicketOnDesktop);
  }, []);

  useEffect(() => {
    previewRequestIdRef.current += 1;
    liveExecutionEpochRef.current += 1;
    setPreview((current) => (current.status === "idle" ? current : { status: "idle" }));
    setLiveExecution((current) => (
      current.status === "idle" || current.status === "working" ? current : { status: "idle" }
    ));
  }, [venueId, marketSel, hyperliquidNetwork, chartInterval, side, notional, riskBudgetUsd, slippageBps, strategy, entryTrigger, horizon, stopRule, entryPrice, stopPrice, entryPinned, stopPinned, scenarioReplayActive, routeCostPolicy.inspection.raw, routeCostPolicy.inspection.status, routeCostPolicy.loadedStorageKey, routeCostPolicy.nowMs, routeCostPolicy.ready]);

  useEffect(() => {
    liveExecutionEpochRef.current += 1;
    setLiveExecution((current) => (
      current.status === "idle" || current.status === "working" ? current : { status: "idle" }
    ));
  }, [signedPayloadText]);

  const boundPreviewEntry = preview.status === "done" && !entryPinned
    ? Number(preview.planBinding.order_plan.limit_price)
    : null;
  const entryLevel = entryPinned ? entryPrice : boundPreviewEntry ?? mid;
  const stopLevel = stopPinned && stopPrice != null
    ? stopPrice
    : entryLevel != null
      ? side === "buy"
        ? entryLevel * (1 - STOP_DEFAULT_PCT)
        : entryLevel * (1 + STOP_DEFAULT_PCT)
      : null;

  // The agent reads levels off the chart: once the entry is placed, infer the
  // trade idea and trigger from geometry unless the user has overridden them.
  useEffect(() => {
    if (!entryPinned || entryPrice == null || !mid || !certifiedSignals.components.candles.ready) return;
    const interp = interpretGeometry({
      entry: entryPrice,
      mid,
      side,
      candles: selectedLiveFrame?.candles ?? [],
    });
    if (!interp) return;
    if (!ideaManual && strategy !== interp.strategy) setStrategy(interp.strategy);
    if (!triggerManual && entryTrigger !== interp.trigger) setEntryTrigger(interp.trigger);
  }, [certifiedSignals.components.candles.ready, entryPinned, entryPrice, entryTrigger, ideaManual, mid, selectedLiveFrame?.candles, side, strategy, triggerManual]);

  const handleEntryDrag = useCallback((price: number | null) => {
    if (!allowTerminalPlanMutation()) return false;
    previewRequestIdRef.current += 1;
    liveExecutionEpochRef.current += 1;
    setPreview((current) => (current.status === "idle" ? current : { status: "idle" }));
    setLiveExecution((current) => (
      current.status === "idle" || current.status === "working" ? current : { status: "idle" }
    ));
    setSignedPayloadText("");
    setEntryPinned(true);
    setEntryPrice(price);
    return true;
  }, [allowTerminalPlanMutation]);
  const handleStageTradePrice = useCallback((price: number, expectedIdentityKey: string) => {
    const current = certifiedTradeStageRef.current;
    const decision = terminalTradePrintStageDecision({
      streamCertified: current.ready,
      currentIdentityKey: current.identityKey,
      expectedIdentityKey,
      price,
    });
    if (!decision.allowed) {
      setKeyboardMessage("Print staging blocked: the certified trade stream or selected market changed.");
      return;
    }
    if (!handleEntryDrag(decision.price)) return;
    setKeyboardMessage(`Certified print ${formatPrice(decision.price)} staged as the limit entry; preview and signed payload cleared. No order submitted.`);
  }, [handleEntryDrag]);

  const handleStopChange = useCallback((price: number | null) => {
    if (!allowTerminalPlanMutation()) return false;
    previewRequestIdRef.current += 1;
    liveExecutionEpochRef.current += 1;
    setPreview((current) => (current.status === "idle" ? current : { status: "idle" }));
    setLiveExecution((current) => (
      current.status === "idle" || current.status === "working" ? current : { status: "idle" }
    ));
    setSignedPayloadText("");
    setStopPinned(true);
    setStopPrice(price);
    if (!stopRuleManual && stopRule !== "exit_on_invalidation") setStopRule("exit_on_invalidation");
    return true;
  }, [allowTerminalPlanMutation, stopRule, stopRuleManual]);

  function selectIdea(id: StrategyProfile) {
    setStrategy(id);
    setIdeaManual(true);
    const allowed = TRIGGERS_FOR[id];
    if (!allowed.includes(entryTrigger)) setEntryTrigger(allowed[0]);
  }

  function selectTrigger(id: EntryTrigger) {
    setEntryTrigger(id);
    setTriggerManual(true);
  }

  const conditionLevel = useMemo(() => {
    const base = entryLevel;
    if (!base) return null;
    if (entryTrigger === "preview_now") return null;
    // Level-based triggers watch the level the user actually drew.
    if (entryTrigger === "break_level" || entryTrigger === "retest_level" || entryTrigger === "sweep_reclaim" || entryTrigger === "custom") {
      return base;
    }
    if (entryTrigger === "book_imbalance") return base * (side === "buy" ? 1.0015 : 0.9985);
    if (entryTrigger === "funding_mark_divergence") return base * (side === "buy" ? 0.996 : 1.004);
    return base * (side === "buy" ? 1.0025 : 0.9975);
  }, [entryLevel, entryTrigger, side]);

  const orderDraft = useMemo<PrivateExecutionOrderDraft>(() => {
    const price = entryLevel ?? 0;
    return {
      venue_id: liveOrderMode.workerVenueId,
      operation_class: liveOrderMode.operationClass,
      market: productLabel,
      side,
      base_size: liveOrderMode.includeBaseSize
        ? venue.id === "hyperliquid" ? "0.001" : "0.01"
        : "",
      quote_size: String(notional),
      limit_price: price > 0 ? price.toFixed(price >= 1_000 ? 1 : 2) : "",
      max_slippage_bps: String(slippageBps),
      order_type: liveOrderMode.orderType,
      tif: liveOrderMode.timeInForce,
      size_mode: "quote",
      agent_strategy_profile: strategy,
      agent_entry_trigger: entryTrigger,
      agent_exit_rule: stopRule,
      agent_time_horizon: horizon,
      agent_trigger_level: conditionLevel ? conditionLevel.toFixed(conditionLevel >= 1_000 ? 1 : 2) : undefined,
      agent_invalidation_level: stopLevel ? stopLevel.toFixed(stopLevel >= 1_000 ? 1 : 2) : undefined,
      agent_edge_threshold_bps: strategy === "funding_basis" ? "25" : undefined,
      agent_strategy_note: selectedStrategy(STRATEGIES, strategy).condition,
      agent_route_priority: "most_private",
    };
  }, [conditionLevel, entryLevel, entryTrigger, horizon, liveOrderMode, notional, productLabel, side, slippageBps, stopLevel, stopRule, strategy, venue.id]);

  const overlays = useMemo(() => {
    const generated = buildGholaAgentChartOverlays({
      order: orderDraft,
      mid: null,
      previewCommitment: preview.status === "done" ? preview.commitment : null,
      accountReady: thumperAuth.authenticated,
      venueLabel: venue.label,
    });
    const entry = entryLevel;
    return generated.filter((overlay) => {
      // Entry and stop are rendered as draggable lines by the chart itself.
      if (overlay.id === "agent-entry") return false;
      // Drop the condition line when it sits exactly on the drawn entry.
      if (
        overlay.id === "agent-condition-level" &&
        entry != null &&
        overlay.price != null &&
        Math.abs(Number(overlay.price) - entry) <= entry * 0.0001
      ) {
        return false;
      }
      return true;
    });
  }, [entryLevel, orderDraft, preview, thumperAuth.authenticated, venue.label]);

  const safeInput = useMemo<PrivateAccountSafeInput>(() => ({
    action_class: "trade_on_platform",
    platform_class:
      venue.id === "coinbase"
        ? "coinbase_style_provider"
        : venue.id === "phoenix"
          ? "solana_perps_market"
          : "hyperliquid_style_market",
    product_bucket: venue.id === "coinbase" ? "provider" : "perps",
    amount_bucket: amountBucket(notional),
    urgency: "maximum_privacy",
    destination_class: "platform_subaccount",
    asset_bucket:
      marketSel === "BTC" ? "BTC" : marketSel === "ETH" ? "ETH" : marketSel === "SOL" ? "SOL" : "major",
    solver_count_bucket: "1",
  }), [marketSel, notional, venue.id]);

  const selectedLiveFrameVersion = selectedLiveFrame?.version ?? null;
  const liveExecutionReferencePrice = liveMarketContext.allowed
    ? side === "buy" ? liveMarketContext.bestAsk : liveMarketContext.bestBid
    : null;
  const livePlanSlippageBound = tradeOrderPlanSlippageBound({
    side,
    limitPrice: entryLevel,
    executionReferencePrice: liveExecutionReferencePrice,
    maxSlippageBps: slippageBps,
  });
  const selectedRouteCostEvidence = useMemo(() => routeCostPolicy.ready
    ? terminalRouteCostEvidence(routeCostPolicy.inspection, venue.id, routeCostPolicy.nowMs)
    : { status: "unavailable" as const, feeBps: 0, bufferBps: 0, feeConfigured: false, bufferConfigured: false, feeCurrent: false, bufferCurrent: false, feeUpdatedAtMs: null, bufferUpdatedAtMs: null, ageMs: null, expiresAtMs: null },
  [routeCostPolicy.inspection, routeCostPolicy.nowMs, routeCostPolicy.ready, venue.id]);
  const selectedRoundTripCostBps = selectedRouteCostEvidence.status === "ready"
    ? 2 * (selectedRouteCostEvidence.feeBps + selectedRouteCostEvidence.bufferBps)
    : Number.NaN;
  const tradeRisk = useMemo(() => deriveTerminalTradeRisk({
    side,
    notionalUsd: notional,
    entryPrice: entryLevel,
    stopPrice: stopLevel,
    slippageBps,
    spreadBps: liveMarketContext.spreadBps,
  }), [entryLevel, liveMarketContext.spreadBps, notional, side, slippageBps, stopLevel]);
  const planLossEnvelope = useMemo(() => deriveTerminalPlanLossEnvelope({
    notionalUsd: notional,
    stopAndSlippageLossUsd: tradeRisk.maxLossUsd,
    stopAndSlippageRiskBps: tradeRisk.stopDistanceBps == null ? null : tradeRisk.stopDistanceBps + slippageBps,
    riskBudgetUsd,
    maxNotionalUsd: MAX_TRADE_NOTIONAL_USD,
    costEvidence: selectedRouteCostEvidence,
  }), [notional, riskBudgetUsd, selectedRouteCostEvidence, slippageBps, tradeRisk.maxLossUsd, tradeRisk.stopDistanceBps]);
  const orderPlan = useMemo(() => {
    if (
      !entryLevel
      || !stopLevel
      || selectedLiveFrameVersion == null
      || !liveMarketContext.allowed
      || liveExecutionReferencePrice == null
      || !planLossEnvelope.ready
      || planLossEnvelope.stopAndSlippageLossUsd == null
      || planLossEnvelope.roundTripCostLossUsd == null
      || planLossEnvelope.allInLossUsd == null
      || planLossEnvelope.feeBps == null
      || planLossEnvelope.bufferBps == null
      || selectedRouteCostEvidence.feeUpdatedAtMs == null
      || selectedRouteCostEvidence.bufferUpdatedAtMs == null
    ) return null;
    return buildTradeOrderPlan({
      venueId: venue.id,
      network: venue.id === "hyperliquid" ? hyperliquidNetwork : "mainnet",
      coin: marketSel,
      product: productLabel,
      side,
      timeInForce: liveOrderMode.timeInForce,
      quoteNotionalUsd: notional,
      baseSize: notional / entryLevel,
      limitPrice: entryLevel,
      maxSlippageBps: slippageBps,
      stopLevel,
      strategyProfile: strategy,
      entryTrigger,
      exitRule: stopRule,
      timeHorizon: horizon,
      triggerLevel: conditionLevel,
      interval: chartInterval,
      marketFetchedAt: liveMarketContext.quoteFetchedAt,
      executionReferencePrice: liveExecutionReferencePrice,
      frameVersion: selectedLiveFrameVersion,
      riskEnvelope: {
        riskBudgetUsd,
        stopAndSlippageLossUsd: planLossEnvelope.stopAndSlippageLossUsd,
        roundTripCostLossUsd: planLossEnvelope.roundTripCostLossUsd,
        allInLossUsd: planLossEnvelope.allInLossUsd,
        feeBps: planLossEnvelope.feeBps,
        bufferBps: planLossEnvelope.bufferBps,
        feeEvidenceAtMs: selectedRouteCostEvidence.feeUpdatedAtMs,
        bufferEvidenceAtMs: selectedRouteCostEvidence.bufferUpdatedAtMs,
      },
    });
  }, [chartInterval, conditionLevel, entryLevel, entryTrigger, horizon, hyperliquidNetwork, liveExecutionReferencePrice, liveMarketContext.allowed, liveMarketContext.quoteFetchedAt, liveOrderMode.timeInForce, marketSel, notional, planLossEnvelope, productLabel, riskBudgetUsd, selectedLiveFrameVersion, selectedRouteCostEvidence.bufferUpdatedAtMs, selectedRouteCostEvidence.feeUpdatedAtMs, side, slippageBps, stopLevel, stopRule, strategy, venue.id]);
  useLayoutEffect(() => {
    currentOrderPlanRef.current = orderPlan;
  }, [orderPlan]);

  const pendingLiveAccountRisk = useMemo(() => deriveTerminalLiveAccountRisk({
    authenticated: thumperAuth.authenticated,
    subjectScope: liveExecutionSubjectScope,
    selectedVenue: venue.id,
    expectedNetwork: venue.id === "hyperliquid" ? hyperliquidNetwork : "mainnet",
    market: productLabel,
    reduceOnly: orderPlan?.execution_policy.reduce_only ?? false,
    view: null,
  }), [hyperliquidNetwork, liveExecutionSubjectScope, orderPlan?.execution_policy.reduce_only, productLabel, thumperAuth.authenticated, venue.id]);
  const effectiveLiveAccountRisk = liveAccountRiskDecision?.identityKey === pendingLiveAccountRisk.identityKey
    ? liveAccountRiskDecision
    : pendingLiveAccountRisk;
  const liveExecutionJournalSummary = useMemo(() => terminalLiveExecutionJournalSummary(
    scopedLiveExecutionJournalStorageStatus,
    scopedLiveExecutionJournal,
  ), [scopedLiveExecutionJournal, scopedLiveExecutionJournalStorageStatus]);
  const unresolvedLiveExecutionJournalEntry = liveExecutionJournalSummary.primaryUnresolved;
  const externalReviewDecision = unresolvedLiveExecutionJournalEntry
    ? terminalLiveExecutionExternalReviewDecision({
        entry: unresolvedLiveExecutionJournalEntry,
        selectedVenue: venue.id,
        selectedNetwork: venue.id === "hyperliquid" ? hyperliquidNetwork : "mainnet",
        accountStreamCurrent: effectiveLiveAccountRisk.accountStreamCurrent,
        accountStreamObservedAtMs: effectiveLiveAccountRisk.accountStreamObservedAtMs,
      })
    : null;

  function recheckLiveAccountRisk() {
    const current = liveAccountRiskDecisionRef.current;
    return current?.identityKey === pendingLiveAccountRisk.identityKey
      ? current
      : pendingLiveAccountRisk;
  }

  function recheckRiskBudget() {
    const currentMarketContext = recheckLiveMarketContext();
    const currentTradeRisk = deriveTerminalTradeRisk({
      side,
      notionalUsd: notional,
      entryPrice: entryLevel,
      stopPrice: stopLevel,
      slippageBps,
      spreadBps: currentMarketContext.allowed ? currentMarketContext.spreadBps : null,
    });
    const currentCostPolicy = routeCostPolicyRef.current;
    const currentCostEvidence = currentCostPolicy.ready
      ? terminalRouteCostEvidence(currentCostPolicy.inspection, venue.id, Date.now())
      : { status: "unavailable" as const, feeBps: 0, bufferBps: 0, feeConfigured: false, bufferConfigured: false, feeCurrent: false, bufferCurrent: false, feeUpdatedAtMs: null, bufferUpdatedAtMs: null, ageMs: null, expiresAtMs: null };
    const currentEnvelope = deriveTerminalPlanLossEnvelope({
      notionalUsd: notional,
      stopAndSlippageLossUsd: currentTradeRisk.maxLossUsd,
      stopAndSlippageRiskBps: currentTradeRisk.stopDistanceBps == null ? null : currentTradeRisk.stopDistanceBps + slippageBps,
      riskBudgetUsd: riskBudgetUsdRef.current,
      maxNotionalUsd: MAX_TRADE_NOTIONAL_USD,
      costEvidence: currentCostEvidence,
    });
    return deriveTerminalRiskBudgetInterlock({
      riskBudgetUsd: riskBudgetUsdRef.current,
      modeledLossUsd: currentEnvelope.allInLossUsd,
      modeledLossUnavailableReason: currentEnvelope.ready ? undefined : currentEnvelope.reason,
      safeNotionalUsd: currentEnvelope.safeNotionalUsd,
      currentNotionalUsd: notional,
      minimumNotionalUsd: MIN_TRADE_NOTIONAL_USD,
    });
  }

  function recheckPlanMarketState() {
    const currentMarketContext = recheckLiveMarketContext();
    return deriveTerminalPlanMarketState({
      side,
      entryPrice: entryLevel,
      stopPrice: stopLevel,
      bestBid: currentMarketContext.bestBid,
      bestAsk: currentMarketContext.bestAsk,
    });
  }

  function recheckPlanSlippageBound(currentMarketContext: ReturnType<typeof deriveTerminalLiveMarketContext>) {
    const executionReferencePrice = currentMarketContext.allowed
      ? side === "buy" ? currentMarketContext.bestAsk : currentMarketContext.bestBid
      : null;
    return tradeOrderPlanSlippageBound({
      side,
      limitPrice: entryLevel,
      executionReferencePrice,
      maxSlippageBps: slippageBps,
    });
  }

  async function handlePreview() {
    if (previewInFlightRef.current) return;
    if (ticketDecimalDraftBlocked) {
      setPreview({ status: "error", message: "Finish or correct the highlighted ticket value before preview." });
      return;
    }
    if (scenarioReplayActive) {
      setPreview({ status: "error", message: "Exit historical replay before creating a live preview." });
      return;
    }
    if (isLocalPreviewRuntime()) {
      setPreview({ status: "error", message: "Remote privacy previews are disabled in local preview." });
      return;
    }
    const initialMarketContext = recheckLiveMarketContext();
    if (!initialMarketContext.allowed) {
      setPreview({
        status: "error",
        message: `Live preview blocked: ${terminalLiveMarketContextBlockerLabel(initialMarketContext.blocker)}.`,
      });
      return;
    }
    const initialSlippageBound = recheckPlanSlippageBound(initialMarketContext);
    if (!initialSlippageBound.allowed) {
      setPreview({ status: "error", message: livePlanSlippageBlocker(initialSlippageBound.limitOffsetBps, slippageBps) });
      return;
    }
    const initialPlanState = recheckPlanMarketState();
    if (!initialPlanState.allowed) {
      setPreview({ status: "error", message: `Live preview blocked: ${terminalPlanMarketStateBlockerLabel(initialPlanState.blocker)}.` });
      return;
    }
    const riskBudgetRecheck = recheckRiskBudget();
    if (!riskBudgetRecheck.allowed) {
      setPreview({ status: "error", message: riskBudgetRecheck.reason });
      return;
    }
    if (!readyToPreview) {
      setPreview({ status: "error", message: marketDataLive ? "Set a valid entry and plan invalidation." : "Live market data is required for a preview." });
      return;
    }
    if (!orderPlan) {
      setPreview({ status: "error", message: "The exact order plan is invalid or market data is stale." });
      return;
    }
    if (notional < MIN_TRADE_NOTIONAL_USD || notional > MAX_TRADE_NOTIONAL_USD) {
      setPreview({ status: "error", message: `Order value must be $${MIN_TRADE_NOTIONAL_USD}–$${MAX_TRADE_NOTIONAL_USD}.` });
      return;
    }
    const requestId = ++previewRequestIdRef.current;
    previewInFlightRef.current = true;
    setPreview({ status: "working" });
    try {
      const intentRiskRecheck = recheckRiskBudget();
      if (!intentRiskRecheck.allowed) throw new Error(intentRiskRecheck.reason);
      const intentBody = (await createPrivateAccountIntent(safeInput)) as {
        intent_id?: string;
        intent?: { intent_id?: string };
      };
      const intentId = intentBody.intent_id ?? intentBody.intent?.intent_id;
      if (!intentId) throw new Error("Intent was not created");
      const previewRiskRecheck = recheckRiskBudget();
      if (requestId !== previewRequestIdRef.current || !previewRiskRecheck.allowed) {
        throw new Error(previewRiskRecheck.allowed
          ? "The order context changed before preview. Start again."
          : previewRiskRecheck.reason);
      }
      const previewMarketContext = recheckLiveMarketContext();
      if (!previewMarketContext.allowed) {
        throw new Error(`Live preview blocked: ${terminalLiveMarketContextBlockerLabel(previewMarketContext.blocker)}.`);
      }
      const previewSlippageBound = recheckPlanSlippageBound(previewMarketContext);
      if (!previewSlippageBound.allowed) {
        throw new Error(livePlanSlippageBlocker(previewSlippageBound.limitOffsetBps, slippageBps));
      }
      const previewPlanState = recheckPlanMarketState();
      if (!previewPlanState.allowed) {
        throw new Error(`Live preview blocked: ${terminalPlanMarketStateBlockerLabel(previewPlanState.blocker)}.`);
      }
      const previewBody = (await previewPrivateAccountAction({
        intent_id: intentId,
        safe_input: safeInput,
        order_plan: orderPlan,
      })) as {
        preview_commitment?: string;
        preview?: { preview_commitment?: string };
        trade_order_plan_binding?: TradeOrderPlanBindingEnvelope;
      };
      const commitment = previewBody.preview_commitment ?? previewBody.preview?.preview_commitment;
      if (!commitment) throw new Error("Preview returned no commitment");
      const planBinding = previewBody.trade_order_plan_binding;
      if (!planBinding || planBinding.preview_commitment !== commitment) {
        throw new Error("Preview returned no enforceable order-plan binding");
      }
      const auditSnapshot = captureTerminalBoundPlanAudit(planBinding);
      if (!auditSnapshot) throw new Error("Preview returned an invalid order-plan binding");
      const completedMarketContext = recheckLiveMarketContext();
      if (!completedMarketContext.allowed) {
        throw new Error(`Live preview expired while binding: ${terminalLiveMarketContextBlockerLabel(completedMarketContext.blocker)}.`);
      }
      const completedSlippageBound = recheckPlanSlippageBound(completedMarketContext);
      if (!completedSlippageBound.allowed) {
        throw new Error(livePlanSlippageBlocker(completedSlippageBound.limitOffsetBps, slippageBps));
      }
      const completedPlanState = recheckPlanMarketState();
      if (!completedPlanState.allowed) {
        throw new Error(`Live preview expired while binding: ${terminalPlanMarketStateBlockerLabel(completedPlanState.blocker)}.`);
      }
      if (requestId === previewRequestIdRef.current) {
        setBoundPlanAuditSnapshot(auditSnapshot);
        setPreview({ status: "done", commitment, planBinding });
      }
    } catch (error) {
      if (requestId === previewRequestIdRef.current) {
        setPreview({
          status: "error",
          message: error instanceof Error ? error.message : "Preview failed",
        });
      }
    } finally {
      previewInFlightRef.current = false;
    }
  }

  async function handleExecuteLive() {
    if (liveExecutionInFlightRef.current) return;
    if (ticketDecimalDraftBlocked) {
      setLiveExecution({ status: "error", message: "Finish or correct the highlighted ticket value before live execution." });
      return;
    }
    if (scenarioReplayActive) {
      setLiveExecution({ status: "error", message: "Live execution is locked during historical replay." });
      return;
    }
    if (isLocalPreviewRuntime()) {
      setLiveExecution({ status: "error", message: "Live execution is disabled on localhost and local previews." });
      return;
    }
    const initialJournalState = recheckLiveExecutionJournalSafety();
    if (initialJournalState !== "ready") {
      setLiveExecution({ status: "error", message: liveExecutionJournalBlockerLabel(initialJournalState) });
      return;
    }
    if (!thumperAuth.authenticated) {
      openAuth("signin");
      return;
    }
    const initialMarketContext = recheckLiveMarketContext();
    if (!initialMarketContext.allowed) {
      setLiveExecution({
        status: "error",
        message: `Live execution blocked: ${terminalLiveMarketContextBlockerLabel(initialMarketContext.blocker)}.`,
      });
      return;
    }
    const initialSlippageBound = recheckPlanSlippageBound(initialMarketContext);
    if (!initialSlippageBound.allowed) {
      setLiveExecution({ status: "error", message: livePlanSlippageBlocker(initialSlippageBound.limitOffsetBps, slippageBps) });
      return;
    }
    const initialPlanState = recheckPlanMarketState();
    if (!initialPlanState.allowed) {
      setLiveExecution({ status: "error", message: `Live execution blocked: ${terminalPlanMarketStateBlockerLabel(initialPlanState.blocker)}.` });
      return;
    }
    const riskBudgetRecheck = recheckRiskBudget();
    if (!riskBudgetRecheck.allowed) {
      setLiveExecution({ status: "error", message: riskBudgetRecheck.reason });
      return;
    }
    const accountRiskRecheck = recheckLiveAccountRisk();
    if (!accountRiskRecheck.allowed) {
      setLiveExecution({ status: "error", message: accountRiskRecheck.reason });
      return;
    }
    if (preview.status !== "done") {
      setLiveExecution({ status: "error", message: "Run a fresh privacy preview before live execution." });
      return;
    }
    if (!orderPlan || !tradeOrderPlanIntentMatches(orderPlan, preview.planBinding.order_plan)) {
      setLiveExecution({ status: "error", message: "The order or market context changed. Refresh the bound preview." });
      return;
    }
    if (Date.parse(preview.planBinding.expires_at) <= Date.now()) {
      setLiveExecution({ status: "error", message: "The bound preview expired. Refresh it before execution." });
      return;
    }
    if (!tradeOrderPlanMarketContextFresh(preview.planBinding.order_plan)) {
      setLiveExecution({ status: "error", message: "The preview market context is stale. Refresh it before execution." });
      return;
    }
    const exactReadiness = terminalByoExecutionReadiness(
      scopedLiveStatus,
      venue.id,
      scopedLiveStatusReceivedAt,
      orderPlan,
    );
    if (!exactReadiness.allowed) {
      setLiveExecution({ status: "error", message: exactReadiness.message });
      return;
    }
    if (!marketDataLive) {
      setLiveExecution({ status: "error", message: "Live market data is required before execution." });
      return;
    }
    if (!stopOnRiskSide) {
      setLiveExecution({ status: "error", message: "Move the plan invalidation to the risk side of the entry before execution." });
      return;
    }
    if (notional < MIN_TRADE_NOTIONAL_USD || notional > MAX_TRADE_NOTIONAL_USD) {
      setLiveExecution({ status: "error", message: `Order value must be $${MIN_TRADE_NOTIONAL_USD}–$${MAX_TRADE_NOTIONAL_USD}.` });
      return;
    }
    const executionSubjectScope = liveExecutionJournalSubjectScopeRef.current;
    if (!executionSubjectScope) {
      setLiveExecution({ status: "error", message: "Authenticated execution account is unavailable. Sign in again before live execution." });
      return;
    }
    liveExecutionInFlightRef.current = true;
    const executionEpoch = liveExecutionEpochRef.current;
    let submitDispatched = false;
    setLiveExecution({ status: "working", stage: "session" });
    try {
      const signedMaterial = parseSignedExecutionPayload(venue.id, signedPayloadText);
      if (venue.id !== "coinbase" && Object.keys(signedMaterial).length === 0) {
        throw new Error(`${venue.label} requires a signed payload before live submit.`);
      }
      const sessionRiskRecheck = recheckRiskBudget();
      if (!sessionRiskRecheck.allowed) throw new Error(sessionRiskRecheck.reason);
      const sessionAccountRiskRecheck = recheckLiveAccountRisk();
      if (!sessionAccountRiskRecheck.allowed) throw new Error(sessionAccountRiskRecheck.reason);
      const sessionRes = await fetch("/api/trading/session", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
      });
      const sessionBody = await sessionRes.json().catch(() => ({})) as {
        appSession?: { csrfToken?: string; subjectScope?: string };
        error?: string;
      };
      if (!sessionRes.ok || !sessionBody.appSession?.csrfToken) {
        throw new Error(sessionBody.error || "Trading session unavailable");
      }
      if (!terminalLiveExecutionSessionSubjectMatches(executionSubjectScope, sessionBody.appSession.subjectScope)) {
        throw new Error("The authenticated trading account changed. Sign in again and create a new preview.");
      }
      if (executionEpoch !== liveExecutionEpochRef.current || isLocalPreviewRuntime()) {
        throw new Error("The order context changed before submit. Start again.");
      }
      const sessionMarketContext = recheckLiveMarketContext();
      if (!sessionMarketContext.allowed) {
        throw new Error(`Live execution blocked: ${terminalLiveMarketContextBlockerLabel(sessionMarketContext.blocker)}.`);
      }
      const sessionSlippageBound = recheckPlanSlippageBound(sessionMarketContext);
      if (!sessionSlippageBound.allowed) {
        throw new Error(livePlanSlippageBlocker(sessionSlippageBound.limitOffsetBps, slippageBps));
      }
      const sessionPlanState = recheckPlanMarketState();
      if (!sessionPlanState.allowed) {
        throw new Error(`Live execution blocked: ${terminalPlanMarketStateBlockerLabel(sessionPlanState.blocker)}.`);
      }

      setLiveExecution({ status: "working", stage: "linking" });
      const venueIds: VenueId[] = [venue.id];
      const executionBody = await buildLiveExecutionBody({
        csrfToken: sessionBody.appSession.csrfToken,
        venueIds,
        venueId: venue.id,
        webUserId: thumperAuth.user?.id || "web-user",
        market: marketSel,
        productLabel,
        side,
        notional,
        entryPrice: entryLevel,
        slippageBps,
        signedMaterial,
        tradeOrderPlanBinding: preview.planBinding,
      });
      if (executionEpoch !== liveExecutionEpochRef.current || isLocalPreviewRuntime()) {
        throw new Error("The order context changed before submit. Start again.");
      }
      const browserLock = await withTerminalLiveExecutionLock({
        lockManager: typeof navigator === "undefined" ? null : navigator.locks,
        subjectScope: executionSubjectScope,
        task: async () => {
          try {
            const submitRiskRecheck = recheckRiskBudget();
            if (!submitRiskRecheck.allowed) throw new Error(submitRiskRecheck.reason);
            const submitAccountRiskRecheck = recheckLiveAccountRisk();
            if (!submitAccountRiskRecheck.allowed) throw new Error(submitAccountRiskRecheck.reason);
            const submitMarketContext = recheckLiveMarketContext();
            if (!submitMarketContext.allowed) {
              throw new Error(`Live execution blocked: ${terminalLiveMarketContextBlockerLabel(submitMarketContext.blocker)}.`);
            }
            const submitSlippageBound = recheckPlanSlippageBound(submitMarketContext);
            if (!submitSlippageBound.allowed) {
              throw new Error(livePlanSlippageBlocker(submitSlippageBound.limitOffsetBps, slippageBps));
            }
            const submitPlanState = recheckPlanMarketState();
            if (!submitPlanState.allowed) {
              throw new Error(`Live execution blocked: ${terminalPlanMarketStateBlockerLabel(submitPlanState.blocker)}.`);
            }
            const submitJournalState = recheckLiveExecutionJournalSafety();
            const dispatchGuard = terminalLiveDispatchGuard({
              capturedEpoch: executionEpoch,
              currentEpoch: liveExecutionEpochRef.current,
              localPreview: isLocalPreviewRuntime(),
              subjectMatches: terminalLiveExecutionSessionSubjectMatches(executionSubjectScope, liveExecutionJournalSubjectScopeRef.current),
              journalReady: submitJournalState === "ready",
              currentPlan: currentOrderPlanRef.current,
              boundPlan: preview.planBinding.order_plan,
              bindingExpiresAt: preview.planBinding.expires_at,
              nowMs: Date.now(),
            });
            if (!dispatchGuard.allowed) throw new Error(terminalLiveDispatchBlockerLabel(dispatchGuard.blocker));

            const pendingEntry = terminalLiveExecutionUnknownJournalEntry({
              planDigest: preview.planBinding.plan_digest,
              plan: preview.planBinding.order_plan,
              reason: "execution_dispatch_pending",
            });
            if (!pendingEntry || !recordLiveExecutionJournalEntry(pendingEntry, executionSubjectScope)) {
              throw new Error("The pre-dispatch execution lock could not be persisted. No venue request was sent.");
            }
            setLiveExecution({ status: "working", stage: "submitting" });
            submitDispatched = true;
            const executeRes = await fetch("/v1/trading/app/execute", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "same-origin",
              cache: "no-store",
              body: JSON.stringify(executionBody),
            });
            const executeBody = await executeRes.json().catch(() => ({})) as unknown;
            const inspectedResponse = inspectTerminalLiveExecutionResponse({
              httpOk: executeRes.ok,
              body: executeBody,
              expectedPlanDigest: preview.planBinding.plan_digest,
              dispatchEvidence: executeRes.headers.get("x-ghola-execution-dispatch"),
              responsePlanDigest: executeRes.headers.get("x-ghola-execution-plan-digest"),
            });
            if (inspectedResponse.outcome === "rejected") {
              submitDispatched = false;
              if (!terminalLiveExecutionSessionSubjectMatches(executionSubjectScope, liveExecutionJournalSubjectScopeRef.current)) return;
              if (!discardLiveExecutionPendingEntry(preview.planBinding.plan_digest, executionSubjectScope)) {
                setLiveExecution({
                  status: "error",
                  message: "Submit was rejected before dispatch, but the conservative local execution lock could not be cleared. Review the preserved ledger before retrying.",
                });
                return;
              }
              setLiveExecution({
                status: "error",
                message: `Submit rejected before dispatch: ${inspectedResponse.reason.replaceAll("_", " ")}. No venue request was sent; correct the blocker and retry.`,
              });
              return;
            }
            if (inspectedResponse.outcome === "unknown") {
              const journalEntry = terminalLiveExecutionUnknownJournalEntry({
                planDigest: preview.planBinding.plan_digest,
                plan: preview.planBinding.order_plan,
                reason: inspectedResponse.reason,
              });
              if (journalEntry) {
                recordLiveExecutionJournalEntry(journalEntry, executionSubjectScope);
              }
              if (!terminalLiveExecutionSessionSubjectMatches(executionSubjectScope, liveExecutionJournalSubjectScopeRef.current)) return;
              setLiveExecution({
                status: "unknown",
                message: `Submission response could not be verified (${inspectedResponse.reason}; HTTP ${executeRes.status}). Do not resubmit; inspect the account stream and reconcile the original plan.`,
              });
              return;
            }
            submitDispatched = false;
            const journalEntry = terminalLiveExecutionJournalEntryFromReceipt(
              inspectedResponse.receipt,
              preview.planBinding.order_plan,
            );
            if (journalEntry) {
              recordLiveExecutionJournalEntry(journalEntry, executionSubjectScope);
            }
            if (!terminalLiveExecutionSessionSubjectMatches(executionSubjectScope, liveExecutionJournalSubjectScopeRef.current)) return;
            setLiveExecution({ status: "done", receipt: inspectedResponse.receipt });
          } catch (error) {
            if (!submitDispatched) throw error;
            const journalEntry = terminalLiveExecutionUnknownJournalEntry({
              planDigest: preview.planBinding.plan_digest,
              plan: preview.planBinding.order_plan,
              reason: "execution_transport_outcome_unknown",
            });
            if (journalEntry) {
              recordLiveExecutionJournalEntry(journalEntry, executionSubjectScope);
            }
            submitDispatched = false;
            if (!terminalLiveExecutionSessionSubjectMatches(executionSubjectScope, liveExecutionJournalSubjectScopeRef.current)) return;
            setLiveExecution({
              status: "unknown",
              message: "The submit request outcome is unknown. Do not resubmit; inspect the account stream and reconcile the original plan.",
            });
          }
        },
      });
      if (!browserLock.acquired) {
        throw new Error(terminalLiveExecutionLockBlockerLabel(browserLock.blocker));
      }
    } catch (error) {
      if (!terminalLiveExecutionSessionSubjectMatches(executionSubjectScope, liveExecutionJournalSubjectScopeRef.current)) return;
      setLiveExecution({
        status: "error",
        message: error instanceof Error ? error.message : "Live execution failed",
      });
    } finally {
      liveExecutionInFlightRef.current = false;
    }
  }

  function handleOpenLiveSubmitReview() {
    if (!readyToExecute || preview.status !== "done") {
      setLiveExecution({ status: "error", message: "Create a fresh exact preview and resolve every live gate before review." });
      return;
    }
    const review = captureTerminalLiveSubmitReview(preview.planBinding, liveExecutionEpochRef.current);
    if (!review) {
      setLiveExecution({ status: "error", message: "The bound preview could not produce an exact live-order review. Re-bind the plan." });
      return;
    }
    setLiveSubmitReview(review);
  }

  function handleConfirmLiveSubmitReview() {
    const decision = terminalLiveSubmitReviewDecision({
      review: liveSubmitReview,
      currentPlanDigest: preview.status === "done" ? preview.planBinding.plan_digest : null,
      currentPreviewCommitment: preview.status === "done" ? preview.planBinding.preview_commitment : null,
      currentEpoch: liveExecutionEpochRef.current,
      executionReady: readyToExecute,
    });
    if (!decision.allowed) {
      setLiveExecution({ status: "error", message: terminalLiveSubmitReviewBlockerLabel(decision.blocker) });
      return;
    }
    setLiveSubmitReview(null);
    void handleExecuteLive();
  }

  const slippageBand = useMemo(() => {
    const price = entryLevel;
    if (!price) return "Waiting";
    const upper = price * (1 + slippageBps / 10_000);
    const lower = price * (1 - slippageBps / 10_000);
    return `${formatPrice(lower)} to ${formatPrice(upper)}`;
  }, [entryLevel, slippageBps]);

  const liveExecutionReadiness = terminalByoExecutionReadiness(
    scopedLiveStatus,
    venue.id,
    scopedLiveStatusReceivedAt,
    orderPlan,
  );
  const userSignedPayloadRequired = venue.id !== "coinbase";
  const signedPayloadValid = useMemo(() => {
    if (!userSignedPayloadRequired) return true;
    if (venue.id === "phoenix" || !orderPlan) return false;
    try {
      const material = parseSignedExecutionPayload(venue.id, signedPayloadText);
      return inspectHyperliquidSignedActionForTradeOrderPlan(
        material.signedAction,
        orderPlan,
      ).ok;
    } catch {
      return false;
    }
  }, [orderPlan, signedPayloadText, userSignedPayloadRequired, venue.id]);
  const liveWorking = liveExecution.status === "working";
  const stopOnRiskSide = Boolean(
    entryLevel && stopLevel && (side === "buy" ? stopLevel < entryLevel : stopLevel > entryLevel),
  );
  const planMarketState = useMemo(() => deriveTerminalPlanMarketState({
    side,
    entryPrice: entryLevel,
    stopPrice: stopLevel,
    bestBid: liveMarketContext.bestBid,
    bestAsk: liveMarketContext.bestAsk,
  }), [entryLevel, liveMarketContext.bestAsk, liveMarketContext.bestBid, side, stopLevel]);
  const marketDataLive = Boolean(
    !loadingMarket &&
    !marketError &&
    liveMarketContext.allowed,
  );
  const marketStatusValue = loadingMarket
    ? "connecting"
    : unifiedMarket.status === "fallback_polling"
      ? "polling"
      : unifiedMarket.status;
  const marketStatusTone = unifiedMarket.status === "live"
    ? "good" as const
    : unifiedMarket.status === "blocked"
      ? "bad" as const
      : "warn" as const;
  const targetPrice = terminalRewardTargetPrice({
    side,
    entryPrice: entryLevel,
    stopPrice: stopLevel,
    rewardMultiple: targetRewardMultiple,
  });
  const planBookIdentity = useMemo<TerminalPlanBookIdentity>(() => ({
    venue: venue.id,
    network: venue.id === "hyperliquid" ? hyperliquidNetwork : "mainnet",
    product: productLabel,
    interval: chartInterval,
  }), [chartInterval, hyperliquidNetwork, productLabel, venue.id]);
  const certifiedPlanBookReference = certifiedSignals.components.quote.ready
    ? certifiedSignals.referencePrice
    : null;
  const planBookReferenceRef = useRef<number | null>(certifiedPlanBookReference);
  planBookReferenceRef.current = certifiedPlanBookReference;
  const planBookDraftRef = useRef<TerminalPlanDraft | null>(null);
  planBookDraftRef.current = !scenarioReplayActive
    && certifiedPlanBookReference != null
    && entryLevel != null
    && stopLevel != null
    && targetPrice != null
    && stopOnRiskSide
    ? {
        identity: planBookIdentity,
        side,
        entryPrice: entryLevel,
        invalidationPrice: stopLevel,
        targetRewardMultiple,
        notionalUsd: notional,
        riskBudgetUsd,
        slippageBps: slippageBps as 25 | 50 | 100,
        certifiedReferencePrice: certifiedPlanBookReference,
      }
    : null;
  const captureTerminalPlan = useCallback((): TerminalPlanDraft | null => {
    if (liveExecutionInFlightRef.current || !planBookDraftRef.current) return null;
    return { ...planBookDraftRef.current, identity: { ...planBookDraftRef.current.identity } };
  }, []);
  const getPlanBookReferencePrice = useCallback(() => planBookReferenceRef.current, []);
  const planBookRestoreContextRef = useRef({
    identity: planBookIdentity,
    referencePrice: certifiedPlanBookReference,
    replayActive: scenarioReplayActive,
  });
  planBookRestoreContextRef.current = {
    identity: planBookIdentity,
    referencePrice: certifiedPlanBookReference,
    replayActive: scenarioReplayActive,
  };
  const restoreTerminalPlan = useCallback((plan: TerminalPlanSnapshot) => {
    const context = planBookRestoreContextRef.current;
    if (liveExecutionInFlightRef.current || context.replayActive) return false;
    const decision = deriveTerminalPlanRestoreDecision({
      plan,
      identity: context.identity,
      currentReferencePrice: context.referencePrice,
    });
    if (decision.status === "blocked") return false;
    previewRequestIdRef.current += 1;
    liveExecutionEpochRef.current += 1;
    setTicketDecimalBlocks({
      notional: false,
      risk_budget: false,
      entry: false,
      invalidation: false,
    });
    setSide(plan.side);
    setNotional(plan.notionalUsd);
    riskBudgetUsdRef.current = plan.riskBudgetUsd;
    setRiskBudgetUsd(plan.riskBudgetUsd);
    setSlippageBps(plan.slippageBps);
    setEntryPrice(plan.entryPrice);
    setEntryPinned(true);
    setStopPrice(plan.invalidationPrice);
    setStopPinned(true);
    setStopRule("exit_on_invalidation");
    setTargetRewardMultiple(plan.targetRewardMultiple);
    setPreview({ status: "idle" });
    setBoundPlanAuditSnapshot(null);
    setSignedPayloadText("");
    setLiveExecution({ status: "idle" });
    setKeyboardMessage(`${plan.name} restored from the local plan book; preview, signature, and live result cleared. No order submitted.`);
    return true;
  }, []);
  const watchTerminalPlan = useCallback((plan: TerminalPlanSnapshot) => {
    const context = planBookRestoreContextRef.current;
    if (
      liveExecutionInFlightRef.current
      || context.replayActive
      || context.referencePrice == null
      || terminalPlanBookIdentityKey(plan.identity) !== terminalPlanBookIdentityKey(context.identity)
    ) return false;
    const savedTargetPrice = terminalRewardTargetPrice({
      side: plan.side,
      entryPrice: plan.entryPrice,
      stopPrice: plan.invalidationPrice,
      rewardMultiple: plan.targetRewardMultiple,
    });
    if (savedTargetPrice == null) return false;
    savedPlanWatchSequenceRef.current += 1;
    setSavedPlanWatchRequest({
      requestId: `saved-plan:${plan.id}:${savedPlanWatchSequenceRef.current}`,
      planId: plan.id,
      planName: plan.name,
      instrument: plan.identity.product,
      entryPrice: plan.entryPrice,
      targetPrice: savedTargetPrice,
      invalidationPrice: plan.invalidationPrice,
    });
    setKeyboardMessage(`${plan.name} sent to local instrument alerts · no preview or order action`);
    window.requestAnimationFrame(() => window.dispatchEvent(new Event("ghola:open-alerts")));
    return true;
  }, []);
  const unwatchTerminalPlan = useCallback((plan: TerminalPlanSnapshot) => {
    savedPlanWatchSequenceRef.current += 1;
    setSavedPlanRemovalRequest({
      requestId: `saved-plan-remove:${plan.id}:${savedPlanWatchSequenceRef.current}`,
      planId: plan.id,
      planName: plan.name,
      instrument: plan.identity.product,
    });
    setKeyboardMessage(`${plan.name} watch removal requested · triggered history retained`);
    return true;
  }, []);
  const handleSavedPlanInventoryChange = useCallback((inventory: readonly TerminalSavedPlanInventoryItem[] | null) => {
    setSavedPlanInventory((current) => terminalSavedPlanInventoryEqual(current, inventory) ? current : inventory);
  }, []);
  const handleSavedPlanWatchIdsChange = useCallback((planIds: readonly string[]) => {
    setWatchedSavedPlanIds((current) => terminalStringArrayEqual(current, planIds) ? current : planIds);
  }, []);
  const positionSizing = useMemo(() => sizeTerminalPositionForRisk({
    side,
    riskBudgetUsd,
    entryPrice: entryLevel,
    stopPrice: stopLevel,
    slippageBps,
    roundTripCostBps: selectedRoundTripCostBps,
    maxNotionalUsd: MAX_TRADE_NOTIONAL_USD,
  }), [entryLevel, riskBudgetUsd, selectedRoundTripCostBps, side, slippageBps, stopLevel]);
  const certifiedAtr = certifiedSignals.components.candles.ready
    ? certifiedSignals.intelligence.atr
    : null;
  const invalidationPlan = useMemo(() => deriveTerminalInvalidationPlan({
    side,
    entryPrice: entryLevel,
    atr: certifiedAtr,
    notionalUsd: notional,
    riskBudgetUsd,
    slippageBps,
    roundTripCostBps: selectedRoundTripCostBps,
    maxNotionalUsd: MAX_TRADE_NOTIONAL_USD,
  }), [certifiedAtr, entryLevel, notional, riskBudgetUsd, selectedRoundTripCostBps, side, slippageBps]);
  const invalidationPlanRef = useRef(invalidationPlan);
  invalidationPlanRef.current = invalidationPlan;
  const handleStageAtrInvalidation = useCallback((
    multiplier: TerminalInvalidationAtrMultiplier,
    expectedPrice: number,
  ) => {
    if (liveExecutionInFlightRef.current) {
      setKeyboardMessage("ATR invalidation staging waits for the current live execution to settle.");
      return;
    }
    const current = invalidationPlanRef.current;
    if (
      current.status !== "ready"
      || !terminalInvalidationCandidateMatches(current.candidates, multiplier, expectedPrice)
    ) {
      setKeyboardMessage("ATR invalidation staging blocked: certified history or ticket risk inputs changed.");
      return;
    }
    const candidate = current.candidates.find((item) => item.multiplier === multiplier);
    if (!candidate) return;
    handleStopChange(candidate.invalidationPrice);
    setKeyboardMessage(`${multiplier.toFixed(1)} ATR plan invalidation staged at ${formatPrice(candidate.invalidationPrice)}. Bound preview and signature cleared; no order submitted.`);
  }, [handleStopChange]);
  const riskBudgetInterlock = useMemo(() => deriveTerminalRiskBudgetInterlock({
    riskBudgetUsd,
    modeledLossUsd: planLossEnvelope.allInLossUsd,
    modeledLossUnavailableReason: planLossEnvelope.ready ? undefined : planLossEnvelope.reason,
    safeNotionalUsd: planLossEnvelope.safeNotionalUsd,
    currentNotionalUsd: notional,
    minimumNotionalUsd: MIN_TRADE_NOTIONAL_USD,
  }), [notional, planLossEnvelope.allInLossUsd, planLossEnvelope.ready, planLossEnvelope.reason, planLossEnvelope.safeNotionalUsd, riskBudgetUsd]);
  const liquidityStress = useMemo(() => deriveTerminalLiquidityStress({
    side,
    orderNotionalUsd: notional,
    sizingPrice: entryLevel,
    limitPrice: entryLevel,
    bids: certifiedBookInput?.bids ?? [],
    asks: certifiedBookInput?.asks ?? [],
  }), [certifiedBookInput, entryLevel, notional, side]);
  const executionQuality = liquidityStress.currentQuality;
  const liveSubmitLiquidityEvidence = useMemo(() => deriveTerminalLiveSubmitLiquidityEvidence({
    quality: executionQuality,
    bookCertified: liquidityStress.status === "ready" && certifiedSignals.components.book.ready,
    bookAgeMs: certifiedSignals.components.book.ageMs,
    currentExecutionReferencePrice: liveExecutionReferencePrice,
    boundReferencePrice: liveSubmitReview ? Number(liveSubmitReview.executionReferencePrice) : null,
    side,
  }), [certifiedSignals.components.book.ageMs, certifiedSignals.components.book.ready, executionQuality, liquidityStress.status, liveExecutionReferencePrice, liveSubmitReview, side]);
  const rawLiquidityRemediationNotional = planMarketState.allowed
    && planMarketState.mode === "marketable"
    && positionSizing.notionalUsd != null
    && liquidityStress.visibleCapacityNotionalUsd != null
    ? Math.min(positionSizing.notionalUsd, liquidityStress.visibleCapacityNotionalUsd)
    : null;
  const liquidityRemediationNotional = rawLiquidityRemediationNotional == null
    ? null
    : floorTerminalNotionalUsd(rawLiquidityRemediationNotional);
  const liquidityRecovery = useMemo(() => (
    liquidityRemediationNotional != null
      && liquidityRemediationNotional >= MIN_TRADE_NOTIONAL_USD
      && Math.abs(liquidityRemediationNotional - notional) >= 0.005
      ? {
          elementId: "terminal-apply-safe-size",
          label: `Review reduction cap $${liquidityRemediationNotional.toFixed(2)}`,
        }
      : null
  ), [liquidityRemediationNotional, notional]);
  const previewMatchesOrderPlan = Boolean(
    preview.status === "done" &&
    orderPlan &&
    tradeOrderPlanIntentMatches(orderPlan, preview.planBinding.order_plan) &&
    tradeOrderPlanMarketContextFresh(preview.planBinding.order_plan) &&
    Date.parse(preview.planBinding.expires_at) > Date.now(),
  );
  const liveExecutionJournalSafety = terminalLiveExecutionJournalSafetyState(
    scopedLiveExecutionJournalStorageStatus,
    scopedLiveExecutionJournal,
  );
  const boundPlanAudit = useMemo(() => deriveTerminalBoundPlanAudit({
    snapshot: boundPlanAuditSnapshot,
    currentPlan: orderPlan,
    active: preview.status === "done",
    nowMs: liveObservationNowMs,
  }), [boundPlanAuditSnapshot, liveObservationNowMs, orderPlan, preview.status]);
  const readyToPreview = !localPreview
    && !scenarioReplayActive
    && !ticketDecimalDraftBlocked
    && thumperAuth.authenticated
    && marketDataLive
    && Boolean(orderPlan)
    && stopOnRiskSide
    && planMarketState.allowed
    && riskBudgetInterlock.allowed;
  const readyToArm = readyToPreview && riskBudgetInterlock.allowed && liveExecutionReadiness.allowed;
  const readyToExecute = Boolean(
    readyToPreview &&
    riskBudgetInterlock.allowed &&
    previewMatchesOrderPlan &&
    terminalLiveExecutionCanSubmit(liveExecution.status) &&
    marketDataLive &&
    liveExecutionReadiness.allowed &&
    planMarketState.allowed &&
    effectiveLiveAccountRisk.allowed &&
    signedPayloadValid &&
    liveExecutionJournalSafety === "ready" &&
    !localPreview,
  );
  const liveSubmitReviewDecision = terminalLiveSubmitReviewDecision({
    review: liveSubmitReview,
    currentPlanDigest: preview.status === "done" ? preview.planBinding.plan_digest : null,
    currentPreviewCommitment: preview.status === "done" ? preview.planBinding.preview_commitment : null,
    currentEpoch: liveExecutionEpochRef.current,
    executionReady: readyToExecute,
  });
  const ticketDraftBlocker = TICKET_DECIMAL_FIELD_ORDER.find((field) => ticketDecimalBlocks[field]) ?? null;
  const orderPlanReady = orderPlan != null;
  const signedPayloadPresent = signedPayloadText.trim().length > 0;
  const executionFlightCheck = useMemo(() => deriveTerminalExecutionFlightCheck({
    localPreview,
    replayActive: scenarioReplayActive,
    authenticated: thumperAuth.authenticated,
    marketReady: marketDataLive,
    marketReason: marketDataLive
      ? "Exact quote identity and freshness certified."
      : !liveMarketContext.allowed
        ? terminalLiveMarketContextBlockerLabel(liveMarketContext.blocker)
        : loadingMarket
          ? "Waiting for the selected public market feed."
          : marketError ?? "Selected market data is not certified.",
    ticketDraftBlocker,
    orderPlanReady,
    invalidationReady: stopOnRiskSide,
    planMarketReady: planMarketState.allowed,
    planReason: !stopOnRiskSide
      ? "Move the plan invalidation beyond entry on the risk side."
      : !planMarketState.allowed
        ? terminalPlanMarketStateBlockerLabel(planMarketState.blocker)
        : !livePlanSlippageBound.allowed && livePlanSlippageBound.limitOffsetBps != null
          ? `Limit reaches ${livePlanSlippageBound.limitOffsetBps.toFixed(1)} bp beyond the executable BBO; reduce it to the ${slippageBps} bp cap.`
        : "A fresh exact order plan is unavailable.",
    riskReady: riskBudgetInterlock.allowed,
    riskReason: riskBudgetInterlock.reason,
    liquidityStatus: liquidityStress.status !== "ready" || executionQuality.status === "no_market"
      ? "unavailable"
      : executionQuality.status,
    liquidityReason: liquidityStress.status !== "ready" || executionQuality.status === "no_market"
      ? liveOrderMode.timeInForce === "ioc"
        ? "Certified visible depth is unavailable; an IOC limit would cancel without a verified immediate fill."
        : "Certified visible depth is unavailable; fill capacity is unknown. A GTC limit may rest, but no displayed fill is implied."
      : executionQuality.status === "full"
        ? `Certified visible depth covers the requested size at this limit; modeled impact ${executionQuality.impactBps?.toFixed(2) ?? "—"} bp. Fees, latency, and queue position are excluded.`
        : executionQuality.status === "partial"
          ? `Certified visible depth covers ${executionQuality.fillPct.toFixed(1)}%; $${(executionQuality.unfilledNotionalUsd ?? 0).toFixed(2)} remains unfilled at this limit.`
          : liveOrderMode.timeInForce === "ioc"
            ? "No eligible displayed liquidity is available at this limit. The IOC remainder cancels immediately; no fill is implied."
            : "No eligible displayed liquidity is available at this limit. The GTC order may rest; no immediate fill is implied.",
    liquidityRecovery,
    portfolioStatus: effectiveLiveAccountRisk.status,
    portfolioReady: effectiveLiveAccountRisk.allowed,
    portfolioReason: effectiveLiveAccountRisk.reason,
    venueReady: liveExecutionReadiness.allowed,
    venueReason: liveExecutionReadiness.message ?? "Fresh global and selected-venue gates are green.",
    venueRecoveryElementId: venue.id === "hyperliquid" ? "hyperliquid-connection" : null,
    previewState: localPreview || scenarioReplayActive
      ? "unavailable"
      : previewMatchesOrderPlan
        ? "ready"
        : preview.status === "done"
          ? "stale"
          : "missing",
    signatureState: !userSignedPayloadRequired
      ? "not_required"
      : signedPayloadValid
        ? "ready"
        : signedPayloadPresent
          ? "invalid"
          : "missing",
    signatureRecoveryElementId: venue.id === "hyperliquid" ? "signed-live-payload" : null,
    journalState: liveExecutionJournalSafety,
  }), [effectiveLiveAccountRisk.allowed, effectiveLiveAccountRisk.reason, effectiveLiveAccountRisk.status, executionQuality.fillPct, executionQuality.impactBps, executionQuality.status, executionQuality.unfilledNotionalUsd, liquidityRecovery, liquidityStress.status, liveExecutionJournalSafety, liveExecutionReadiness.allowed, liveExecutionReadiness.message, liveMarketContext.allowed, liveMarketContext.blocker, liveOrderMode.timeInForce, livePlanSlippageBound.allowed, livePlanSlippageBound.limitOffsetBps, loadingMarket, localPreview, marketDataLive, marketError, orderPlanReady, planMarketState.allowed, planMarketState.blocker, preview.status, previewMatchesOrderPlan, riskBudgetInterlock.allowed, riskBudgetInterlock.reason, scenarioReplayActive, signedPayloadPresent, signedPayloadValid, slippageBps, stopOnRiskSide, thumperAuth.authenticated, ticketDraftBlocker, userSignedPayloadRequired, venue.id]);
  const workerSleeping = Boolean(scopedLiveStatus && shouldWakePooledWorker(scopedLiveStatus));
  const workerStatusValue = workerWakeState === "waking" ? "starting" : workerSleeping ? "sleeping" : workerLabel;
  const workerStatusTone = workerReady || workerWakeState === "ready" || workerWakeState === "waking"
    ? "good"
    : "warn";
  const pooledStatusValue = scopedLiveStatus?.pooled_live_trading_enabled
    ? "enabled"
    : workerWakeState === "waking"
      ? "starting"
      : workerSleeping
        ? "sleeping"
        : "off";
  const pooledStatusTone = scopedLiveStatus?.pooled_live_trading_enabled || workerWakeState === "waking"
    ? "good"
    : "warn";

  // Synthetic chart fallback is useful for layout continuity, never for a
  // historical range model. Stale retained frames also fail closed so the
  // envelope cannot look current or actionable after a feed interruption.
  const replayScenarioSourceCertified = Boolean(
    replayScenario.context?.source &&
    !replayScenario.context.source.stale &&
    replayScenario.context.source.candles.length > 0 &&
    replayScenario.context.source.componentTimestamps?.candles != null &&
    terminalFrameMatchesSelection(replayScenario.context.source, {
      venue: venue.id,
      market: marketSel,
      interval: chartInterval,
    }) &&
    replayScenario.context.source.network === (venue.id === "hyperliquid" ? hyperliquidNetwork : "mainnet"),
  );
  const scenarioSourceFresh = scenarioReplayActive
    ? replayScenarioSourceCertified
    : certifiedSignals.components.candles.ready;
  const scenarioFrame = !scenarioSourceFresh
    ? null
    : scenarioReplayActive
      ? replayScenario.frame
      : selectedLiveFrame;
  const scenarioAnalysis = useMemo(() => analyzeTerminalScenario({
    candles: scenarioFrame?.candles ?? [],
    side,
    entryPrice: entryLevel,
    stopPrice: stopLevel,
    targetPrice,
    notionalUsd: notional,
    slippageBps,
  }), [entryLevel, notional, scenarioFrame?.candles, side, slippageBps, stopLevel, targetPrice]);
  const planPathAnalysis = useMemo(() => analyzeTerminalPlanPath({
    candles: scenarioFrame?.candles ?? [],
    side,
    entryPrice: entryLevel,
    stopPrice: stopLevel,
    targetPrice,
    notionalUsd: notional,
  }), [entryLevel, notional, scenarioFrame?.candles, side, stopLevel, targetPrice]);
  const planPathStudies = useMemo(() => studyTerminalPlanPathHorizons({
    candles: scenarioFrame?.candles ?? [],
    side,
    entryPrice: entryLevel,
    stopPrice: stopLevel,
    targetPrice,
  }), [entryLevel, scenarioFrame?.candles, side, stopLevel, targetPrice]);
  const planPayoffCalibration = useMemo(() => deriveTerminalPlanPayoffCalibration({
    studies: planPathStudies,
    stopLossUsd: scenarioAnalysis.stopLossUsd,
    targetProfitUsd: scenarioAnalysis.targetProfitUsd,
  }), [planPathStudies, scenarioAnalysis.stopLossUsd, scenarioAnalysis.targetProfitUsd]);
  const rewardLadder = useMemo(() => deriveTerminalRewardLadder({
    candles: scenarioFrame?.candles ?? [],
    side,
    entryPrice: entryLevel,
    stopPrice: stopLevel,
    notionalUsd: notional,
    slippageBps,
  }), [entryLevel, notional, scenarioFrame?.candles, side, slippageBps, stopLevel]);
  const rewardLadderRef = useRef(rewardLadder);
  rewardLadderRef.current = rewardLadder;
  const handleStageRewardTarget = useCallback((
    rewardMultiple: TerminalRewardMultiple,
    expectedTargetPrice: number,
  ) => {
    if (liveExecutionInFlightRef.current) {
      setKeyboardMessage("Target staging waits for the current live execution request to settle.");
      return;
    }
    if (replayScenario.active) {
      setKeyboardMessage("Target staging is disabled during historical replay.");
      return;
    }
    const current = rewardLadderRef.current;
    const row = current.rows.find((item) => item.rewardMultiple === rewardMultiple);
    if (!row || Math.abs(row.targetPrice - expectedTargetPrice) > 1e-9) {
      setKeyboardMessage("Target staging blocked: the analytical plan changed.");
      return;
    }
    setTargetRewardMultiple(rewardMultiple);
    setKeyboardMessage(`${rewardMultiple.toFixed(1)}R target selected at ${formatPrice(row.targetPrice)} for analysis and future attached PAPER OCO only; live one-shot execution is unchanged.`);
  }, [replayScenario.active]);
  const buildEntryPriceStages = useCallback(() => deriveTerminalEntryPriceStages({
    frame: selectedLiveFrame,
    venue: venue.id,
    market: marketSel,
    interval: chartInterval,
    network: venue.id === "hyperliquid" ? hyperliquidNetwork : "mainnet",
    side,
    controllerStale: unifiedMarket.stale,
    nowMs: liveObservationNowMs,
    maxAgeMs: marketFreshnessLimitMs(chartInterval),
  }), [chartInterval, hyperliquidNetwork, liveObservationNowMs, marketSel, selectedLiveFrame, side, unifiedMarket.stale, venue.id]);
  const entryPriceStages = useMemo(
    () => buildEntryPriceStages(),
    [buildEntryPriceStages],
  );
  const buildEntryPriceStagesRef = useRef(buildEntryPriceStages);
  buildEntryPriceStagesRef.current = buildEntryPriceStages;
  const entryOutcomeMatrix = useMemo(() => deriveTerminalEntryOutcomeMatrix({
    frame: certifiedBookInput,
    side,
    notionalUsd: notional,
    joinPrice: entryPriceStages.join?.price ?? null,
    currentPrice: entryLevel,
    crossPrice: entryPriceStages.cross?.price ?? null,
    stopPrice: stopLevel,
    stopPinned,
    autoStopDistancePct: STOP_DEFAULT_PCT,
    slippageBps,
    roundTripCostBps: selectedRoundTripCostBps,
    riskBudgetUsd,
    minNotionalUsd: MIN_TRADE_NOTIONAL_USD,
    maxNotionalUsd: MAX_TRADE_NOTIONAL_USD,
  }), [certifiedBookInput, entryLevel, entryPriceStages.cross?.price, entryPriceStages.join?.price, notional, riskBudgetUsd, selectedRoundTripCostBps, side, slippageBps, stopLevel, stopPinned]);
  const entryTargetSurface = useMemo(() => deriveTerminalEntryTargetSurface({
    entryMatrix: entryOutcomeMatrix,
    candles: scenarioFrame?.candles ?? [],
    side,
    notionalUsd: notional,
    slippageBps,
  }), [entryOutcomeMatrix, notional, scenarioFrame?.candles, side, slippageBps]);
  const entryTargetSurfaceRef = useRef(entryTargetSurface);
  entryTargetSurfaceRef.current = entryTargetSurface;
  const currentSizeRecommendation = terminalEntrySizeRecommendation(
    entryOutcomeMatrix.status === "ready"
      ? entryOutcomeMatrix.outcomes.find((outcome) => outcome.mode === "current")
      : null,
  );
  const allInSizeRecommendation = useMemo<TerminalEntrySizeRecommendation | null>(() => {
    const riskCapNotionalUsd = planLossEnvelope.safeNotionalUsd;
    if (riskCapNotionalUsd == null) return null;
    const visibleFullFillNotionalUsd = currentSizeRecommendation?.visibleFullFillNotionalUsd ?? null;
    const raw = visibleFullFillNotionalUsd == null
      ? riskCapNotionalUsd
      : Math.min(riskCapNotionalUsd, visibleFullFillNotionalUsd);
    const recommended = floorTerminalNotionalUsd(raw);
    if (recommended == null) return null;
    return {
      notionalUsd: recommended,
      constraint: visibleFullFillNotionalUsd != null && visibleFullFillNotionalUsd < riskCapNotionalUsd - 0.005
        ? "visible_liquidity"
        : "risk_budget",
      canApply: recommended >= MIN_TRADE_NOTIONAL_USD && recommended < notional - 0.005,
      riskCapNotionalUsd,
      visibleFullFillNotionalUsd,
    };
  }, [currentSizeRecommendation?.visibleFullFillNotionalUsd, notional, planLossEnvelope.safeNotionalUsd]);
  const handleAutoEntryPrice = useCallback(() => {
    if (liveExecutionInFlightRef.current) {
      setKeyboardMessage("Entry staging waits for the current live execution to settle.");
      return;
    }
    previewRequestIdRef.current += 1;
    liveExecutionEpochRef.current += 1;
    setEntryPrice(null);
    setEntryPinned(false);
    setPreview({ status: "idle" });
    setLiveExecution((current) => current.status === "working" ? current : { status: "idle" });
    setSignedPayloadText("");
    setKeyboardMessage("Entry returned to certified BBO midpoint tracking; it waits when BBO is unavailable. No order submitted.");
  }, []);
  const handleStageEntryPrice = useCallback((mode: TerminalEntryPriceMode) => {
    if (liveExecutionInFlightRef.current) {
      setKeyboardMessage("Entry staging waits for the current live execution to settle.");
      return false;
    }
    const current = buildEntryPriceStagesRef.current();
    const stage = current[mode];
    if (!stage) {
      setKeyboardMessage(`Entry staging blocked: ${terminalEntryPriceStageBlockerLabel(current.blocker)}.`);
      return false;
    }
    handleEntryDrag(stage.price);
    setKeyboardMessage(`${mode === "join" ? "Joined" : "Crossed"} certified ${stage.sourceSide} at ${formatPrice(stage.price)}. Draft bindings cleared; no order submitted.`);
    return true;
  }, [handleEntryDrag]);
  const handleStageEntryTarget = useCallback((
    mode: TerminalEntryOutcomeMode,
    expectedEntryPrice: number,
    rewardMultiple: TerminalRewardMultiple,
    expectedTargetPrice: number,
  ) => {
    if (liveExecutionInFlightRef.current) {
      setKeyboardMessage("Entry × target staging waits for the current live execution request to settle.");
      return;
    }
    if (replayScenario.active) {
      setKeyboardMessage("Entry × target staging is disabled during historical replay.");
      return;
    }
    const selection = terminalEntryTargetStageSelection({
      surface: entryTargetSurfaceRef.current,
      mode,
      expectedEntryPrice,
      rewardMultiple,
      expectedTargetPrice,
    });
    if (!selection) {
      setKeyboardMessage("Entry × target staging blocked: certified depth or plan inputs changed.");
      return;
    }
    if (mode !== "current" && !handleStageEntryPrice(mode)) return;
    if (mode === "current" && (entryLevel == null || Math.abs(entryLevel - expectedEntryPrice) > 1e-9)) {
      setKeyboardMessage("Entry × target staging blocked: the current entry changed.");
      return;
    }
    setTargetRewardMultiple(rewardMultiple);
    setKeyboardMessage(`${mode} entry ${formatPrice(selection.entryPrice)} with ${rewardMultiple.toFixed(1)}R target ${formatPrice(selection.targetPrice)} staged for analysis and future PAPER OCO; no order previewed or submitted.`);
  }, [entryLevel, handleStageEntryPrice, replayScenario.active]);
  const handleStageSafeSizedOutcome = useCallback((
    mode: TerminalEntryPriceMode,
    expectedPrice: number,
    recommendation: TerminalEntrySizeRecommendation,
  ) => {
    if (liveExecutionInFlightRef.current) {
      setKeyboardMessage("Safe-size staging waits for the current live execution to settle.");
      return;
    }
    const current = buildEntryPriceStagesRef.current();
    const stage = current[mode];
    if (!stage) {
      setKeyboardMessage(`Safe-size staging blocked: ${terminalEntryPriceStageBlockerLabel(current.blocker)}.`);
      return;
    }
    if (
      Math.abs(expectedPrice - stage.price) > 1e-9
      || !recommendation.canApply
      || recommendation.notionalUsd < MIN_TRADE_NOTIONAL_USD
    ) {
      setKeyboardMessage("Safe-size staging blocked: current certified depth, risk, and entry inputs do not produce an executable ticket size.");
      return;
    }
    handleEntryDrag(stage.price);
    handleApplyRiskSizedNotional(recommendation.notionalUsd);
    const constraint = recommendation.constraint === "visible_liquidity" ? "visible-depth-capped" : "risk-capped";
    setKeyboardMessage(`${mode === "join" ? "Joined" : "Crossed"} certified ${stage.sourceSide} at ${formatPrice(stage.price)} and set $${recommendation.notionalUsd.toFixed(2)} ${constraint} notional. Draft bindings cleared; no order submitted.`);
  }, [handleApplyRiskSizedNotional, handleEntryDrag]);
  const handleStageSafeSizedEntryPrice = useCallback((mode: TerminalEntryPriceMode) => {
    const outcome = entryOutcomeMatrix.status === "ready"
      ? entryOutcomeMatrix.outcomes.find((item) => item.mode === mode)
      : null;
    const recommendation = terminalEntrySizeRecommendation(outcome);
    if (!outcome || !recommendation) {
      setKeyboardMessage("Safe-size staging blocked: current certified depth, risk, and entry inputs do not produce an executable ticket size.");
      return;
    }
    handleStageSafeSizedOutcome(mode, outcome.price, recommendation);
  }, [entryOutcomeMatrix, handleStageSafeSizedOutcome]);
  const handleJoinEntryPrice = useCallback(() => handleStageEntryPrice("join"), [handleStageEntryPrice]);
  const handleCrossEntryPrice = useCallback(() => handleStageEntryPrice("cross"), [handleStageEntryPrice]);
  const chartPriceAlertProjection = useMemo(() => deriveTerminalChartPriceAlerts({
    snapshot: chartPriceAlerts,
    expectedScope: terminalAlertInstrumentScope(marketSel),
  }), [chartPriceAlerts, marketSel]);
  const executableRPlanOverlays = useMemo<GholaChartOverlay[]>(() => {
    return buildGholaExecutableRPlanOverlays({
      side,
      entryPrice: entryLevel,
      stopPrice: stopLevel,
      targetPrice,
      targetRewardMultiple,
      entryPinned,
      stopPinned,
      stopValid: stopOnRiskSide,
    }).concat(chartPriceAlertProjection.overlays, overlays);
  }, [chartPriceAlertProjection.overlays, entryLevel, entryPinned, overlays, side, stopLevel, stopOnRiskSide, stopPinned, targetPrice, targetRewardMultiple]);
  const chartToolbarActions = useMemo(() => (
    <ChartRPlanReadout
      replay={scenarioReplayActive}
      modeledLossUsd={riskBudgetInterlock.modeledLossUsd}
      riskBudgetUsd={riskBudgetInterlock.riskBudgetUsd}
      utilizationPct={riskBudgetInterlock.utilizationPct}
      safeNotionalUsd={riskBudgetInterlock.safeNotionalUsd}
      fillPct={executionQuality.status === "no_market" ? null : executionQuality.fillPct}
      impactBps={executionQuality.impactBps}
      allowed={riskBudgetInterlock.allowed}
    />
  ), [executionQuality.fillPct, executionQuality.impactBps, executionQuality.status, riskBudgetInterlock, scenarioReplayActive]);
  const handleChartOverlayPriceCommit = useCallback((overlayId: string, price: number) => {
    if (scenarioReplayActive || !Number.isFinite(price) || price <= 0) return;
    const next = roundForInput(price);
    if (overlayId === "trade-plan-entry") handleEntryDrag(next);
    if (overlayId === "trade-plan-invalidation") handleStopChange(next);
  }, [handleEntryDrag, handleStopChange, scenarioReplayActive]);
  const handleChartSelectPrice = useCallback((price: string) => {
    const next = Number(price.replaceAll(",", ""));
    if (Number.isFinite(next) && next > 0) handleEntryDrag(next);
  }, [handleEntryDrag]);
  const bookPressureObservedAtMs = Date.parse(unifiedMarket.telemetry.lastReceiptAt ?? "");
  const routePrimaryFrame = routeFeedsEnabled && !unifiedMarket.stale ? selectedLiveFrame : null;
  const routeComparisonFrames = useMemo(() => terminalRouteAnalysisFrames({
    active: routeFeedsEnabled,
    primary: null,
    peers: compareFrames,
  }), [compareFrames, routeFeedsEnabled]);
  const routeFrames = useMemo(() => terminalRouteAnalysisFrames({
    active: routeFeedsEnabled,
    primary: routePrimaryFrame,
    peers: routeComparisonFrames,
  }), [routeComparisonFrames, routeFeedsEnabled, routePrimaryFrame]);
  const venueBasis = useMemo(() => deriveTerminalVenueBasis(
    routePrimaryFrame,
    routeComparisonFrames,
    {
      market: marketSel,
      interval: chartInterval,
      requiredProductClass: venue.id === "coinbase" ? "spot" : "perpetual",
      requiredNetwork: venue.id === "hyperliquid" ? hyperliquidNetwork : "mainnet",
      nowMs: liveObservationNowMs,
      maxAgeMs: marketFreshnessLimitMs(chartInterval),
    },
  ), [chartInterval, hyperliquidNetwork, liveObservationNowMs, marketSel, routeComparisonFrames, routePrimaryFrame, venue.id]);
  const crossVenueCarryMatrix = useMemo(() => deriveTerminalCrossVenueCarryMatrix({
    frames: routeFrames,
    selectedVenue: venue.id,
    market: marketSel,
    interval: chartInterval,
    requiredProductClass: venue.id === "coinbase" ? "spot" : "perpetual",
    requiredNetwork: venue.id === "hyperliquid" ? hyperliquidNetwork : "mainnet",
    side,
    notionalUsd: notional,
    nowMs: liveObservationNowMs,
    maxQuoteAgeMs: marketFreshnessLimitMs(chartInterval),
  }), [chartInterval, hyperliquidNetwork, liveObservationNowMs, marketSel, notional, routeFrames, side, venue.id]);
  const routeDecision = useMemo(() => deriveTerminalRouteDecision({
    frames: routeFrames,
    market: marketSel,
    interval: chartInterval,
    side,
    orderNotionalUsd: notional,
    limitPrice: entryLevel,
    requiredProductClass: venue.id === "coinbase" ? "spot" : "perpetual",
    requiredNetwork: venue.id === "hyperliquid" ? hyperliquidNetwork : "mainnet",
    nowMs: liveObservationNowMs,
    maxAgeMs: marketFreshnessLimitMs(chartInterval),
  }), [chartInterval, entryLevel, hyperliquidNetwork, liveObservationNowMs, marketSel, notional, routeFrames, side, venue.id]);
  const routeImprovement = useMemo(
    () => routeFeedsEnabled ? deriveTerminalRouteImprovement(routeDecision, venue.id) : null,
    [routeDecision, routeFeedsEnabled, venue.id],
  );
  const routeAllInModel = useMemo(() => routeFeedsEnabled && routeCostPolicy.ready && routeCostPolicy.inspection.status !== "blocked"
    ? deriveTerminalAllInRouteModel({
        decision: routeDecision,
        policy: routeCostPolicy.inspection.policy,
        selectedVenue: venue.id,
        nowMs: routeCostPolicy.nowMs,
      })
    : null,
  [routeCostPolicy.inspection, routeCostPolicy.nowMs, routeCostPolicy.ready, routeDecision, routeFeedsEnabled, venue.id]);
  const alertSnapshot = useMemo<TerminalAlertSnapshot>(() => ({
    ...certifiedSignals.alertSnapshot,
    funding_rate_bps: fundingRateSignal.available ? fundingRateSignal.rateBps : null,
    route_improvement_bps: routeAllInModel?.improvementBps ?? null,
    feed_health_score: unifiedMarket.telemetry.healthScore,
    receipt_latency_ms: unifiedMarket.telemetry.receiptLatencyMs,
  }), [certifiedSignals.alertSnapshot, fundingRateSignal, routeAllInModel?.improvementBps, unifiedMarket.telemetry.healthScore, unifiedMarket.telemetry.receiptLatencyMs]);
  const availableAlertMetrics = useMemo<TerminalAlertMetric[]>(() => {
    const additions: TerminalAlertMetric[] = ["feed_health_score"];
    if (unifiedMarket.telemetry.receiptLatencyMs != null) additions.push("receipt_latency_ms");
    if (fundingRateSignal.available && !certifiedSignals.availableAlertMetrics.includes("funding_rate_bps")) {
      additions.push("funding_rate_bps");
    }
    if (routeAllInModel?.improvementBps != null && !certifiedSignals.availableAlertMetrics.includes("route_improvement_bps")) {
      additions.push("route_improvement_bps");
    }
    return additions.length === 0
      ? certifiedSignals.availableAlertMetrics
      : [...certifiedSignals.availableAlertMetrics, ...additions];
  }, [certifiedSignals.availableAlertMetrics, fundingRateSignal.available, routeAllInModel?.improvementBps, unifiedMarket.telemetry.receiptLatencyMs]);
  const handleStageRouteCandidate = useCallback((candidate: TerminalRouteCandidate) => {
    const expectedProductClass = venue.id === "coinbase" ? "spot" : "perpetual";
    const expectedNetwork = venue.id === "hyperliquid" ? hyperliquidNetwork : "mainnet";
    if (liveExecutionInFlightRef.current) {
      setKeyboardMessage("Route staging waits for the current live execution to settle.");
      return;
    }
    const target = terminalRouteStageTarget({
      candidate,
      currentCandidates: routeDecision.candidates,
      currentVenue: venue.id,
      currentMarket: marketSel,
      requiredProductClass: expectedProductClass,
      requiredNetwork: expectedNetwork,
      supportedMarketsByVenue: {
        hyperliquid: VENUES.find((item) => item.id === "hyperliquid")?.markets ?? [],
        phoenix: VENUES.find((item) => item.id === "phoenix")?.markets ?? [],
        coinbase: VENUES.find((item) => item.id === "coinbase")?.markets ?? [],
      },
      nowMs: Date.now(),
      maxAgeMs: marketFreshnessLimitMs(chartInterval),
    });
    if (!target.allowed) {
      setKeyboardMessage(target.blocker === "route_stage_already_selected"
        ? `${VENUES.find((item) => item.id === candidate.venue)?.label ?? candidate.venue} is already selected.`
        : "Route staging blocked: the candidate is no longer a fresh compatible visible-depth route.");
      return;
    }
    const nextVenue = VENUES.find((item) => item.id === target.venue);
    if (!nextVenue) return;
    previewRequestIdRef.current += 1;
    liveExecutionEpochRef.current += 1;
    setVenueId(target.venue);
    setMarketSel(target.market);
    if (target.venue === "hyperliquid") setHyperliquidNetwork(target.network);
    setEntryPrice(null);
    setEntryPinned(false);
    setStopPrice(null);
    setStopPinned(false);
    setPreview({ status: "idle" });
    setLiveExecution({ status: "idle" });
    setSignedPayloadText("");
    setReplayScenario({ active: false, frame: null, context: null });
    setRouteCheckOpen(false);
    setKeyboardMessage(`Staged ${target.market} on ${nextVenue.label} from the certified route matrix. Bound preview, signature, and pinned levels cleared; awaiting its fresh book. No order submitted.`);
    window.requestAnimationFrame(() => {
      terminalTicketFocusRestoreTarget({
        returnFocus: null,
        mobileTrigger: document.getElementById(MOBILE_TICKET_TRIGGER_ID),
        desktopTarget: document.getElementById(TERMINAL_TICKET_FIELD_IDS.entry),
        desktop: window.matchMedia("(min-width: 1280px)").matches,
      })?.focus();
    });
  }, [chartInterval, hyperliquidNetwork, marketSel, routeDecision.candidates, venue.id]);
  const stopDistancePct = tradeRisk.stopDistanceBps != null ? tradeRisk.stopDistanceBps / 10_000 : null;
  const maxLossUsd = planLossEnvelope.allInLossUsd;
  const worstFill = tradeRisk.worstFillPrice;
  const estimatedBaseSize = tradeRisk.baseSize;
  const executionBlocker = localPreview
    ? "Live submit disabled in local preview"
    : scenarioReplayActive
      ? "Live preview, arming, and submit are locked during historical replay"
    : ticketDecimalDraftBlocked
      ? "Finish or correct the highlighted ticket value"
    : !thumperAuth.authenticated
      ? "Sign in required"
    : !planMarketState.allowed
      ? `Plan blocked: ${terminalPlanMarketStateBlockerLabel(planMarketState.blocker)}`
    : !riskBudgetInterlock.allowed
        ? riskBudgetInterlock.reason
      : !effectiveLiveAccountRisk.allowed
        ? effectiveLiveAccountRisk.reason
        : liveExecutionJournalSafety !== "ready"
          ? liveExecutionJournalBlockerLabel(liveExecutionJournalSafety)
        : liveExecution.status === "unknown"
          ? "Original submit outcome is unknown; reconcile it before any new submit"
          : liveExecution.status === "done"
            ? "Original plan was acknowledged; change and re-bind the plan before another submit"
            : preview.status !== "done"
              ? "Run a fresh privacy preview first"
            : !previewMatchesOrderPlan
            ? "Order or market context changed; refresh preview"
            : !marketDataLive
              ? liveMarketContext.allowed
                ? "Waiting for live market data"
                : `Live execution blocked: ${terminalLiveMarketContextBlockerLabel(liveMarketContext.blocker)}`
              : !liveExecutionReadiness.allowed
                ? liveExecutionReadiness.reason_code === "terminal_byo_live_gate_not_ready"
                  ? `Connect ${venue.label} live access`
                  : liveExecutionReadiness.message
                : !stopOnRiskSide
                  ? "Plan invalidation must be beyond entry risk"
                  : !signedPayloadValid
                      ? `Valid ${venue.label} signature required`
                      : null;


  useEffect(() => {
    if (typeof window === "undefined") return;
    const searchParams = new URLSearchParams(window.location.search);
    const exchangeCode = searchParams.get("code");
    if (!exchangeCode) return;
    fetch("/api/auth/twitter/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: exchangeCode }),
    })
      .then((res) => {
        if (!res.ok) throw new Error("Exchange failed");
        return res.json();
      })
      .then((data: { user: { id: string; email: string; name?: string } }) => {
        const res = handleTwitterSession(data.user);
        setAuth(res.user);
      })
      .catch(() => {})
      .finally(() => {
        router.replace("/trade");
      });
  }, [router, setAuth]);

  const openAuth = useCallback((mode: AuthMode) => {
    if (mobileTicketOpen) {
      restoreMobileTicketFocusRef.current = false;
      setMobileTicketOpen(false);
      setOpenRow(null);
    }
    setAuthMode(mode);
    setAuthOpen(true);
  }, [mobileTicketOpen]);
  const closeAuth = useCallback(() => {
    setAuthOpen(false);
    const returnFocus = mobileTicketReturnFocusRef.current;
    mobileTicketReturnFocusRef.current = null;
    if (returnFocus?.isConnected) queueMicrotask(() => returnFocus.focus());
  }, []);
  const handleAgentSignIn = useCallback(() => openAuth("signin"), [openAuth]);
  const handleAgentSignUp = useCallback(() => openAuth("signup"), [openAuth]);
  const handleSelectLaunchVenue = useCallback((nextVenueId: PublicAgentStartupVenue["id"]) => {
    if (nextVenueId !== "hyperliquid" && nextVenueId !== "phoenix" && nextVenueId !== "coinbase") return;
    selectVenue(nextVenueId);
    if (nextVenueId === "hyperliquid") {
      window.requestAnimationFrame(() => {
        document.getElementById("hyperliquid-connection")?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    }
  }, [selectVenue]);

  const focusTicketField = useCallback((field: TerminalTicketField) => {
    const fieldId = TERMINAL_TICKET_FIELD_IDS[field];
    const label = ticketFieldLabel(field);
    const mobile = window.matchMedia("(max-width: 1279px)").matches;
    if (mobile) {
      const active = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
        ? document.activeElement
        : null;
      const commandTrigger = document.querySelector<HTMLButtonElement>('button[aria-label="Open terminal command palette"]');
      mobileTicketReturnFocusRef.current = terminalTicketReturnFocusTarget({
        activeElement: active,
        commandTrigger,
      });
      restoreMobileTicketFocusRef.current = true;
      setMobileTicketOpen(true);
    }
    window.requestAnimationFrame(() => {
      const input = document.getElementById(fieldId);
      if (!(input instanceof HTMLInputElement) || input.disabled) {
        setKeyboardMessage(`${label} is unavailable`);
        return;
      }
      input.scrollIntoView({ behavior: "smooth", block: "center" });
      input.focus({ preventScroll: true });
      if (document.activeElement !== input) {
        setKeyboardMessage(`${label} could not be focused`);
        return;
      }
      input.select();
      setKeyboardMessage(`${label} focused · staging only`);
    });
  }, []);

  const handleExecutionFlightAction = useCallback((action: TerminalExecutionFlightAction) => {
    if (action.type === "focus_ticket_field") {
      focusTicketField(action.field);
      return;
    }
    if (action.type === "open_auth") {
      openAuth("signin");
      return;
    }
    window.requestAnimationFrame(() => {
      const container = document.getElementById(action.elementId);
      const target = container?.matches("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]")
        ? container
        : container?.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]");
      if (!(target instanceof HTMLElement)) {
        setKeyboardMessage(`${action.label} is unavailable`);
        return;
      }
      container?.scrollIntoView({ behavior: "smooth", block: "center" });
      target.focus({ preventScroll: true });
      setKeyboardMessage(`${action.label} focused · no order action taken`);
    });
  }, [focusTicketField, openAuth]);

  const focusLiveAccount = useCallback(() => {
    const account = document.getElementById("terminal-live-account-blotter");
    if (!(account instanceof HTMLElement)) {
      setKeyboardMessage("Live account stream is unavailable");
      return;
    }
    account.scrollIntoView({ behavior: "smooth", block: "center" });
    account.focus({ preventScroll: true });
    setKeyboardMessage("Live account stream focused · read only");
  }, []);

  const copyLiveExecutionEvidence = useCallback(async (label: string, value: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard_unavailable");
      await navigator.clipboard.writeText(value);
      setKeyboardMessage(`${label} copied · browser-local evidence only`);
    } catch {
      setKeyboardMessage(`${label} could not be copied`);
    }
  }, []);

  const downloadLiveExecutionEvidence = useCallback((content: string, filename: string) => {
    try {
      const url = URL.createObjectURL(new Blob([content], { type: "application/json;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setKeyboardMessage("Live execution evidence exported · browser-local file only");
    } catch {
      setKeyboardMessage("Live execution evidence could not be exported");
    }
  }, []);

  const refreshLiveAccountEvidence = useCallback(() => {
    if (!thumperAuth.authenticated || venue.id !== "hyperliquid") {
      setKeyboardMessage("Select Hyperliquid and sign in before refreshing account evidence.");
      return;
    }
    if (liveExecutionInFlightRef.current) {
      setKeyboardMessage("Account evidence refresh waits for the current live execution request to settle.");
      return;
    }
    previewRequestIdRef.current += 1;
    liveExecutionEpochRef.current += 1;
    setPreview({ status: "idle" });
    setBoundPlanAuditSnapshot(null);
    setSignedPayloadText("");
    setLiveExecution({ status: "idle" });
    setAccountStreamRestartKey((current) => current + 1);
    setKeyboardMessage("Refreshing the sealed Hyperliquid account stream and authoritative snapshot; preview and signature cleared. No order submitted.");
  }, [thumperAuth.authenticated, venue.id]);

  const handleExternalExecutionReview = useCallback((planDigest: string) => {
    if (liveExecutionJournalStorageStatusRef.current !== "ready") {
      setKeyboardMessage("Execution safety ledger is locked; stored history was preserved");
      return;
    }
    const current = liveExecutionJournalRef.current;
    const entry = current.find((item) => item.planDigest === planDigest);
    if (!entry || (entry.status !== "unknown" && entry.status !== "submitted")) return;
    const reviewDecision = terminalLiveExecutionExternalReviewDecision({
      entry,
      selectedVenue: venue.id,
      selectedNetwork: venue.id === "hyperliquid" ? hyperliquidNetwork : "mainnet",
      accountStreamCurrent: effectiveLiveAccountRisk.accountStreamCurrent,
      accountStreamObservedAtMs: effectiveLiveAccountRisk.accountStreamObservedAtMs,
    });
    if (!reviewDecision.allowed) {
      setKeyboardMessage(terminalLiveExecutionExternalReviewBlockerLabel(reviewDecision.blocker));
      return;
    }
    const confirmed = window.confirm("Only continue after checking the venue account's open orders and fills. This records external review locally; it does not prove reconciliation or cancel an order. Unlock this entry?");
    if (!confirmed) return;
    const next = externallyReviewTerminalLiveExecutionJournalEntry(current, planDigest);
    const reviewed = next.find((item) => item.planDigest === planDigest) ?? null;
    if (next === current || !reviewed || !recordLiveExecutionJournalEntry(reviewed)) return;
    liveExecutionEpochRef.current += 1;
    previewRequestIdRef.current += 1;
    setPreview({ status: "idle" });
    setBoundPlanAuditSnapshot(null);
    setSignedPayloadText("");
    setLiveExecution({ status: "idle" });
    setKeyboardMessage("External account review recorded · preview and signature cleared · no reconciliation claimed");
  }, [effectiveLiveAccountRisk.accountStreamCurrent, effectiveLiveAccountRisk.accountStreamObservedAtMs, hyperliquidNetwork, recordLiveExecutionJournalEntry, venue.id]);

  const handleReconnectMarket = useCallback(() => {
    if (previewInFlightRef.current || liveExecutionInFlightRef.current) {
      setKeyboardMessage("Market reconnect waits for the current preview or execution request to settle.");
      return;
    }
    previewRequestIdRef.current += 1;
    liveExecutionEpochRef.current += 1;
    setPreview({ status: "idle" });
    setLiveExecution((current) => current.status === "working" ? current : { status: "idle" });
    setSignedPayloadText("");
    setMarketRestartKey((current) => current + 1);
    setKeyboardMessage("Selected public market feed reconnecting · bound preview and signature cleared; workspace and staged levels preserved.");
  }, []);

  const openRouteCheck = useCallback(() => {
    if (!compareWorkspaceActive) setRouteCheckOpen(true);
    setKeyboardMessage("Compatible public routes opened · visible depth only; no order previewed or submitted");
    window.requestAnimationFrame(() => {
      const matrix = document.getElementById("terminal-route-matrix");
      matrix?.scrollIntoView({ behavior: "smooth", block: "center" });
      matrix?.focus();
    });
  }, [compareWorkspaceActive]);
  const stopRouteCheck = useCallback(() => {
    setRouteCheckOpen(false);
    setKeyboardMessage("On-demand peer feeds stopped");
  }, []);

  const focusPaperSurface = useCallback((targetId: string, label: string) => {
    paperSurfaceFocusAbortRef.current?.abort();
    const controller = new AbortController();
    paperSurfaceFocusAbortRef.current = controller;
    window.dispatchEvent(new Event(TERMINAL_OPEN_PAPER_EVENT));
    void focusTerminalSurfaceWhenReady({
      targetId,
      fallbackId: "paper-workstation",
      signal: controller.signal,
    }).then((result) => {
      if (paperSurfaceFocusAbortRef.current !== controller || result === "cancelled") return;
      paperSurfaceFocusAbortRef.current = null;
      setKeyboardMessage(result === "target"
        ? `${label} focused · local PAPER only`
        : result === "fallback"
          ? `PAPER opened, but ${label.toLowerCase()} is unavailable in the current preserved state`
          : `${label} is unavailable`);
    });
  }, []);

  const runTerminalCommand = useCallback((command: TerminalCommand) => {
    if (command.type !== "open_risk_desk" && command.type !== "open_execution_analytics") {
      paperSurfaceFocusAbortRef.current?.abort();
      paperSurfaceFocusAbortRef.current = null;
    }
    if (terminalCommandMutatesTradePlan(command.type) && !allowTerminalPlanMutation()) return;
    switch (command.type) {
      case "select_venue": selectVenue(command.venue); break;
      case "select_market": {
        const supportedVenue = VENUES.find((item) => item.id === venueId && item.markets.includes(command.market));
        if (supportedVenue) setMarketSel(command.market);
        else {
          selectVenue(command.market === "HYPE" ? "hyperliquid" : command.market === "SOL" ? "phoenix" : "coinbase");
          setMarketSel(command.market);
        }
        setEntryPinned(false);
        setStopPinned(false);
        break;
      }
      case "select_interval":
        setChartInterval(command.interval);
        setKeyboardMessage(`${command.interval} chart selected`);
        break;
      case "select_side":
        setSide(command.side);
        setStopPinned(false);
        setKeyboardMessage(`${command.side === "buy" ? "Buy" : "Sell"} side selected`);
        break;
      case "set_notional": setNotional(command.notionalUsd); break;
      case "set_slippage": setSlippageBps(command.slippageBps); break;
      case "set_chart_mode": {
        setChartSurface("terminal");
        setChartMode(command.mode);
        break;
      }
      case "toggle_study": setChartStudies((current) => current.includes(command.study)
        ? current.filter((study) => study !== command.study)
        : [...current, command.study]); break;
      case "toggle_book": {
        const next = !bookOpen;
        setBookOpen(next);
        setKeyboardMessage(`Market depth ${next ? "shown" : "hidden"}`);
        break;
      }
      case "set_depth_view": {
        setBookOpen(true);
        setBookView(command.view);
        window.requestAnimationFrame(() => {
          const depth = document.getElementById("terminal-market-depth");
          depth?.scrollIntoView({ behavior: "smooth", block: "center" });
          depth?.focus();
        });
        break;
      }
      case "fit_chart": {
        setChartSurface("terminal");
        window.requestAnimationFrame(() => {
          const chart = document.querySelector<HTMLCanvasElement>('canvas[role="application"]');
          chart?.focus();
          chart?.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true }));
        });
        break;
      }
      case "toggle_replay": {
        setChartSurface("terminal");
        window.requestAnimationFrame(() => {
          const chart = document.querySelector<HTMLCanvasElement>('canvas[role="application"]');
          chart?.focus();
          chart?.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true }));
        });
        break;
      }
      case "open_chart": {
        setChartSurface("terminal");
        window.requestAnimationFrame(() => {
          const chart = document.querySelector<HTMLCanvasElement>('canvas[role="application"]');
          chart?.scrollIntoView({ behavior: "smooth", block: "center" });
          chart?.focus({ preventScroll: true });
          setKeyboardMessage(chart ? "Live chart focused" : "Live chart is unavailable");
        });
        break;
      }
      case "open_alerts": {
        openTerminalAlertManager();
        setKeyboardMessage("Local alerts opened");
        break;
      }
      case "open_paper": {
        window.dispatchEvent(new Event(TERMINAL_OPEN_PAPER_EVENT));
        const workstation = document.getElementById("paper-workstation");
        workstation?.scrollIntoView({ behavior: "smooth", block: "start" });
        window.requestAnimationFrame(() => workstation?.focus());
        setKeyboardMessage("PAPER workstation opened · simulation only");
        break;
      }
      case "open_ticket": {
        const commandTrigger = document.querySelector<HTMLButtonElement>('button[aria-label="Open terminal command palette"]');
        mobileTicketReturnFocusRef.current = terminalTicketReturnFocusTarget({
          activeElement: document.activeElement,
          commandTrigger,
        });
        if (window.matchMedia("(max-width: 1279px)").matches) setMobileTicketOpen(true);
        window.requestAnimationFrame(() => {
          const ticket = document.getElementById("order-ticket");
          ticket?.scrollIntoView({ behavior: "smooth", block: "start" });
          ticket?.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), button:not([disabled])')?.focus();
          setKeyboardMessage(ticket ? "Order ticket opened · staging only" : "Order ticket is unavailable");
        });
        break;
      }
      case "open_risk_desk": {
        focusPaperSurface("paper-risk-desk", "PAPER portfolio risk desk");
        break;
      }
      case "open_scanner": {
        const scanner = document.getElementById("terminal-market-scanner");
        scanner?.scrollIntoView({ behavior: "smooth", block: "center" });
        window.requestAnimationFrame(() => {
          scanner?.focus();
          setKeyboardMessage(scanner ? "Passive market scanner focused" : "Market scanner is unavailable");
        });
        break;
      }
      case "open_execution_analytics": {
        focusPaperSurface("paper-execution-analytics", "PAPER execution analytics");
        break;
      }
      case "open_route_check":
        openRouteCheck();
        break;
      case "open_plan_book": {
        const commandTrigger = document.querySelector<HTMLButtonElement>('button[aria-label="Open terminal command palette"]');
        mobileTicketReturnFocusRef.current = terminalTicketReturnFocusTarget({
          activeElement: document.activeElement,
          commandTrigger,
        });
        if (window.matchMedia("(max-width: 1279px)").matches) setMobileTicketOpen(true);
        window.requestAnimationFrame(() => {
          const planBook = document.getElementById("terminal-plan-book") as HTMLDetailsElement | null;
          if (planBook) {
            planBook.open = true;
            planBook.dispatchEvent(new Event("toggle", { bubbles: false }));
            planBook.scrollIntoView({ behavior: "smooth", block: "center" });
            planBook.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
          }
          setKeyboardMessage(planBook ? "Local plan book opened · saved plans never submit automatically" : "Local plan book is unavailable");
        });
        break;
      }
      case "reconnect_market":
        handleReconnectMarket();
        break;
      case "focus_ticket_field":
        focusTicketField(command.field);
        break;
      case "stage_entry_price":
        if (command.mode === "auto") handleAutoEntryPrice();
        else handleStageEntryPrice(command.mode);
        break;
      case "stage_safe_sized_entry":
        handleStageSafeSizedEntryPrice(command.mode);
        break;
      case "cycle_slippage": {
        const next = nextTerminalSlippage(slippageBps);
        setSlippageBps(next);
        setKeyboardMessage(`Slippage cap ${next} basis points`);
        break;
      }
      case "reset_plan_levels":
        setEntryPinned(false);
        setStopPinned(false);
        setKeyboardMessage("Entry and plan invalidation returned to automatic levels");
        break;
    }
  }, [allowTerminalPlanMutation, bookOpen, focusPaperSurface, focusTicketField, handleAutoEntryPrice, handleReconnectMarket, handleStageEntryPrice, handleStageSafeSizedEntryPrice, openRouteCheck, openTerminalAlertManager, selectVenue, slippageBps, venueId]);

  useEffect(() => {
    function handleKeyboard(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (event.defaultPrevented || terminalModalIsOpen(document) || openRow == null) return;
        event.preventDefault();
        setOpenRow(null);
        setKeyboardMessage("Ticket editor closed");
        return;
      }
      const command = terminalCommandForHotkey({
        key: event.key,
        defaultPrevented: event.defaultPrevented,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        repeat: event.repeat,
        editableTarget: terminalKeyboardEventIsEditable(event),
        modalOpen: terminalModalIsOpen(document),
      });
      if (!command) return;
      event.preventDefault();
      runTerminalCommand(command);
    }
    window.addEventListener("keydown", handleKeyboard);
    return () => window.removeEventListener("keydown", handleKeyboard);
  }, [openRow, runTerminalCommand]);

  return (
    <div className="trade-terminal min-h-screen bg-[#05070b] text-[#eef1f8]">
      <AuthModal
        mode={authMode}
        open={authOpen}
        onClose={closeAuth}
        onModeChange={setAuthMode}
        redirectTo={`/account?flow=${venueId === "coinbase" ? "coinbase" : venueId === "phoenix" ? "phoenix-live" : "hyperliquid-live"}`}
      />
      <span data-terminal-keyboard-message className="sr-only" aria-live="polite" aria-atomic="true">{keyboardMessage}</span>
      <TerminalHeader
        authenticated={thumperAuth.authenticated}
        alertSummary={alertSummary}
        byoLiveEnabled={scopedLiveStatus?.byo_live_trading_enabled === true}
        inert={mobileTicketOpen}
        keyboardMessage=""
        localPreview={localPreview}
        marketStatusTone={marketStatusTone}
        marketStatusValue={marketStatusValue}
        pooledStatusTone={pooledStatusTone}
        pooledStatusValue={pooledStatusValue}
        persistenceScope={traderPersistenceScope}
        userEmail={thumperAuth.user?.email}
        workerStatusTone={workerStatusTone}
        workerStatusValue={workerStatusValue}
        onCommand={runTerminalCommand}
        onCaptureWorkspace={captureWorkspace}
        onLoadWorkspace={loadWorkspace}
        onOpenAuth={openAuth}
      />

      <main
        style={{ "--terminal-ticket-width": `${ticketWidthPx}px` } as CSSProperties}
        className="grid min-h-[calc(100vh-3.5rem)] grid-cols-1 xl:grid-cols-[minmax(0,1fr)_0.5rem_var(--terminal-ticket-width)]"
      >
        <section inert={mobileTicketOpen ? true : undefined} className="min-w-0 border-r border-[#182234]">
          <div inert={liveWorking ? true : undefined} aria-disabled={liveWorking || undefined}>
            <TerminalMarketToolbar
              venues={VENUES}
              venueId={venueId}
              market={marketSel}
              network={hyperliquidNetwork}
              interval={chartInterval}
              onSelectVenue={selectVenue}
              onSelectMarket={selectMarket}
              onSelectInterval={selectInterval}
            />
          </div>

          {liveWorking ? (
            <div role="status" aria-live="polite" className="flex items-center gap-2 border-b border-amber-300/30 bg-amber-300/[0.05] px-4 py-2 text-[10px] leading-4 text-amber-100 sm:px-6">
              <LockKeyhole aria-hidden className="h-3.5 w-3.5 shrink-0" />
              Live request in flight · venue, market, side, size, risk, slippage, replay, and chart/depth price staging are locked to the dispatched plan.
            </div>
          ) : null}

          {localPreview ? (
            <TerminalLocalSafetyStrip
              fundedTestnetProofAvailable={process.env.NEXT_PUBLIC_GHOLA_HYPERLIQUID_FUNDED_TESTNET_UI_ENABLED === "true"}
            />
          ) : (
            <PublicAgentLaunchPanel
              startup={scopedAgentStartup}
              failed={agentStartupFailed}
              selectedVenueId={venueId}
              wakeState={agentWakeState}
              wakeMessage={agentWakeMessage}
              authenticated={thumperAuth.authenticated}
              onSignIn={handleAgentSignUp}
              onWake={handleWakeAgentWorker}
              onSelectVenue={handleSelectLaunchVenue}
            />
          )}

          {workspaceStorageBlocked ? (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-2 border-b border-rose-300/30 bg-rose-300/[0.04] px-4 py-2 text-[10px] leading-4 text-rose-200 sm:px-6">
              <span>{workspaceStorageConflict
                ? "Another tab changed this workspace concurrently. Automatic writes stopped; choose which complete layout to keep."
                : "Saved workspace data is unreadable and preserved. Automatic layout writes are locked."}</span>
              {workspaceStorageConflict ? (
                <span className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => resolveWorkspaceStorageConflict("stored")} className="term-chip h-7 shrink-0 px-2 text-[9px] uppercase">
                    Use stored
                  </button>
                  <button type="button" onClick={() => resolveWorkspaceStorageConflict("local")} className="term-chip h-7 shrink-0 px-2 text-[9px] uppercase">
                    Keep this tab
                  </button>
                </span>
              ) : (
                <button type="button" onClick={resetBlockedWorkspaceStorage} className="term-chip h-7 shrink-0 px-2 text-[9px] uppercase">
                  Reset workspace
                </button>
              )}
            </div>
          ) : null}

          <TerminalMarketContextRail
            venue={venue.label}
            product={productLabel}
            side={side}
            notionalUsd={notional}
            quoteReady={liveMarketContext.allowed}
            quoteMid={liveMarketContext.allowed ? (liveMarketContext.bestBid + liveMarketContext.bestAsk) / 2 : null}
            bestBid={liveMarketContext.allowed ? liveMarketContext.bestBid : null}
            bestAsk={liveMarketContext.allowed ? liveMarketContext.bestAsk : null}
            quoteAgeMs={liveMarketContext.allowed ? liveMarketContext.quoteAgeMs : null}
            entryPrice={entryLevel}
            invalidationPrice={stopLevel}
            riskAllowed={riskBudgetInterlock.allowed}
            modeledLossUsd={riskBudgetInterlock.modeledLossUsd}
            riskBudgetUsd={riskBudgetInterlock.riskBudgetUsd}
            onAuto={handleAutoEntryPrice}
            onJoin={handleJoinEntryPrice}
            onCross={handleCrossEntryPrice}
          />

          <div
            style={{ "--terminal-market-rail-width": `${marketRailWidthPx}px` } as CSSProperties}
            className="grid grid-cols-[minmax(0,1fr)] gap-0 lg:grid-cols-[minmax(0,1fr)_0.5rem_var(--terminal-market-rail-width)]"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-end justify-between gap-4 px-4 py-4 sm:px-6">
                <div className="min-w-[12rem]">
                  <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.2em] text-[#5aa7ff]/80">
                    <span>{venue.label}</span>
                    <span aria-hidden className="text-[#344258]">/</span>
                    <span className={unifiedMarket.status === "live" ? "text-emerald-300" : "text-amber-300"}>
                      {marketStatusValue}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <h1 className="font-display text-2xl font-semibold tracking-tight text-[#f6f8ff]">{productLabel}</h1>
                    <TerminalLivePrice
                      value={mid}
                      formattedValue={formatPrice(mid)}
                      className="font-mono text-2xl font-semibold tabular-nums"
                    />
                    <span className={`font-mono text-xs tabular-nums ${certifiedSignals.intelligence.sessionChangePct == null ? "text-[#566278]" : certifiedSignals.intelligence.sessionChangePct >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                      {formatSignedPercent(certifiedSignals.intelligence.sessionChangePct)} {certifiedSignals.components.candles.ready ? "chart" : "uncertified chart"}
                    </span>
                  </div>
                  <p className="mt-1.5 font-mono text-[10px] tabular-nums text-[#66738c]">
                    {liveMarketContext.allowed
                      ? `Bid ${formatPrice(liveMarketContext.bestBid)} · Ask ${formatPrice(liveMarketContext.bestAsk)} · quote age ${formatFeedTelemetryMs(liveMarketContext.quoteAgeMs)} · ${marketFieldAuthority.ready ? `market age ${formatFeedTelemetryMs(marketFieldAuthority.ageMs)}` : "market fields paused"}`
                      : `Certified BBO paused · ${terminalLiveMarketContextBlockerLabel(liveMarketContext.blocker)}`}
                  </p>
                </div>
                <TerminalMarketSnapshotMetrics
                  mark={formatPrice(marketFieldAuthority.markPrice)}
                  oracle={formatPrice(marketFieldAuthority.oraclePrice)}
                  spread={liveMarketContext.allowed ? `${liveMarketContext.spreadBps.toFixed(2)} bps` : "-"}
                  funding={fundingRateSignal.available ? `${fundingRateSignal.ratePercent.toFixed(4)}%` : "-"}
                  openInterest={formatCompact(marketFieldAuthority.openInterest)}
                  dayVolume={formatCompact(marketFieldAuthority.dayVolume)}
                />
              </div>
              <TerminalMarketFeedTelemetry
                telemetry={unifiedMarket.telemetry}
                peerGrades={marketFeedPeerGrades}
                components={certifiedSignals.components}
              />
              <TerminalMarketDecisionStack
                scanner={(
                  <TerminalMarketWatchlist
                    key={`${traderPersistenceScope ?? "identity_loading"}:${chartInterval}:${hyperliquidNetwork}`}
                    persistenceScope={traderPersistenceScope}
                    sources={watchlistSources}
                    interval={chartInterval}
                    hyperliquidNetwork={hyperliquidNetwork}
                    selectedInstrument={marketSel as TerminalWatchlistInstrument}
                    selectedVenue={venueId}
                    onSelect={handleWatchlistSelect}
                  />
                )}
                chart={(
                  <div
                    inert={liveWorking ? true : undefined}
                    aria-disabled={liveWorking || undefined}
                    className={`px-3 pb-3 sm:px-6 ${liveWorking ? "cursor-wait" : ""}`}
                  >
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-1" role="group" aria-label="Chart workspace">
                    {(["terminal", "plan"] as const).map((surface) => (
                      <button
                        key={surface}
                        type="button"
                        aria-pressed={chartSurface === surface}
                        onClick={() => {
                          setChartSurface(surface);
                          if (surface === "plan") setReplayScenario({ active: false, frame: null, context: null });
                        }}
                        className={chartSurface === surface ? "trade-chip-on h-8 rounded-md px-3 text-xs font-medium capitalize" : "trade-chip h-8 rounded-md px-3 text-xs font-medium capitalize"}
                      >
                        {surface}
                      </button>
                    ))}
                  </div>
                  <span className="hidden text-[10px] text-[#566278] sm:inline">
                    {chartSurface === "terminal" ? "Studies · depth · keyboard inspection" : "Drag entry and plan invalidation"}
                  </span>
                </div>
                {chartSurface === "terminal" ? (
                  <>
                    <GholaMarketChart
                      frame={frame}
                      mode={chartMode}
                      onModeChange={setChartMode}
                      allowedModes={TERMINAL_CHART_MODES}
                      compareFrames={compareFrames}
                      studies={chartStudies}
                      onStudiesChange={setChartStudies}
                      overlays={executableRPlanOverlays}
                      height="auto"
                      label={`${productLabel} terminal`}
                      replayIdentityKey={`${venue.id}:${venue.id === "hyperliquid" ? hyperliquidNetwork : "mainnet"}:${marketSel}:${chartInterval}`}
                      drawingPersistenceScope={traderPersistenceScope}
                      onReplayFrameChange={handleReplayFrameChange}
                      toolbarActions={chartToolbarActions}
                      onOverlayPriceCommit={!liveWorking && certifiedSignals.components.candles.ready ? handleChartOverlayPriceCommit : undefined}
                      onSelectPrice={!liveWorking && certifiedSignals.components.candles.ready ? handleChartSelectPrice : undefined}
                      drawingSourceCertified={certifiedSignals.components.candles.ready}
                    />
                    <TerminalChartAlertLevels
                      projection={chartPriceAlertProjection}
                      replayActive={scenarioReplayActive}
                      onManage={openTerminalAlertManager}
                    />
                  </>
                ) : (
                  <MarketChart
                    key={certifiedSignals.components.candles.ready ? "certified" : "uncertified"}
                    frame={frame}
                    overlays={overlays}
                    side={side}
                    entryPrice={entryLevel}
                    stopPrice={stopLevel}
                    stopSuggested={!stopPinned}
                    interactionAllowed={!liveWorking && certifiedSignals.components.candles.ready}
                    onEntryDrag={handleEntryDrag}
                    onStopDrag={handleStopChange}
                  />
                )}
                {chartSurface === "terminal" && replayScenario.active && replayScenario.context ? (
                  <ReplayExecutionLab
                    sourceFrame={replayScenario.context.source}
                    cursor={replayScenario.context.cursor}
                    totalBars={replayScenario.context.totalBars}
                  />
                ) : null}
                  </div>
                )}
              />
              {routeFeedsEnabled ? (
                <>
                  <div className="mx-3 mb-3 grid grid-cols-2 gap-2 sm:mx-6 sm:grid-cols-4" aria-label="Cross-venue basis">
                    <RiskMetric label="Best ask" value={venueBasis.bestExecutableBuy ? `${venueBasis.bestExecutableBuy.venue} ${venueBasis.bestExecutableBuy.network} ${formatPrice(venueBasis.bestExecutableBuy.price)}` : "-"} />
                    <RiskMetric label="Best bid" value={venueBasis.bestExecutableSell ? `${venueBasis.bestExecutableSell.venue} ${venueBasis.bestExecutableSell.network} ${formatPrice(venueBasis.bestExecutableSell.price)}` : "-"} />
                    <RiskMetric label="Executable edge" value={venueBasis.executableSpreadBps != null ? `${venueBasis.executableSpreadBps >= 0 ? "+" : ""}${venueBasis.executableSpreadBps.toFixed(2)} bp` : "-"} />
                    <RiskMetric label="Venue health" value={`${venueHealth.liveVenueCount}/${venueHealth.health.length} live${venueHealth.staleVenueCount ? ` · ${venueHealth.staleVenueCount} stale` : ""}`} />
                  </div>
                  <TerminalCrossVenueCarryMatrix matrix={crossVenueCarryMatrix} />
                  <TerminalRouteMatrix
                    decision={routeDecision}
                    improvement={routeImprovement}
                    selectedVenue={venue.id}
                    costPolicy={routeCostPolicy}
                    allInModel={routeAllInModel}
                    onStageCandidate={handleStageRouteCandidate}
                    onStopPeerFeeds={!compareWorkspaceActive && routeCheckOpen ? stopRouteCheck : undefined}
                  />
                </>
              ) : null}
              <MarketIntelligenceStrip signals={certifiedSignals} />
            </div>

            <TerminalColumnResizeHandle
              className="hidden lg:block"
              controls="terminal-market-rail"
              cssVariable="--terminal-market-rail-width"
              defaultValue={TERMINAL_MARKET_RAIL_WIDTH_PX.default}
              label="Resize market activity column"
              min={TERMINAL_MARKET_RAIL_WIDTH_PX.min}
              max={Math.min(TERMINAL_MARKET_RAIL_WIDTH_PX.max, TERMINAL_SIDE_COLUMNS_MAX_PX - ticketWidthPx)}
              value={marketRailWidthPx}
              onChange={setMarketRailWidthPx}
            />
            <aside id="terminal-market-rail" className="border-t border-[#182234] lg:border-l lg:border-t-0">
              <div className="border-b border-[#182234] bg-gradient-to-b from-[#0a0e16] to-transparent px-4 py-3">
                <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#dce6f4]">Agent activity</h2>
              </div>
              <TerminalAgentActivity authenticated={thumperAuth.authenticated} authenticatedSubject={thumperAuth.user?.id ?? null} localPreview={localPreview} onSignIn={handleAgentSignIn} />
              <TerminalLiveAccountPanel
                authenticated={thumperAuth.authenticated}
                subjectScope={liveExecutionSubjectScope}
                selectedVenue={venue.id}
                expectedNetwork={venue.id === "hyperliquid" ? hyperliquidNetwork : "mainnet"}
                coin={marketSel === "ETH" || marketSel === "SOL" || marketSel === "HYPE" ? marketSel : "BTC"}
                market={productLabel}
                reduceOnly={orderPlan?.execution_policy.reduce_only ?? false}
                onRiskDecision={handleLiveAccountRiskDecision}
                onInspectMarket={handleInspectLiveAccountMarket}
                restartKey={accountStreamRestartKey}
                onRefresh={thumperAuth.authenticated && venue.id === "hyperliquid" ? refreshLiveAccountEvidence : undefined}
              />
              <section
                id="terminal-market-depth"
                tabIndex={-1}
                aria-labelledby="terminal-market-depth-heading"
                className="outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-sky-300"
              >
                <div className="flex items-center justify-between gap-2 border-y border-[#182234] bg-gradient-to-b from-[#0a0e16] to-transparent pr-3">
                  <button
                    type="button"
                    aria-expanded={bookOpen}
                    aria-keyshortcuts="D"
                    onClick={() => setBookOpen((value) => !value)}
                    className="flex min-w-0 flex-1 items-center justify-between px-4 py-3 text-left transition-colors hover:bg-[#0c1220]"
                  >
                    <h2 id="terminal-market-depth-heading" className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#dce6f4]">Market depth</h2>
                    <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-[#566278] transition-transform ${bookOpen ? "rotate-180" : ""}`} />
                  </button>
                  {bookOpen ? (
                    <div role="group" aria-label="Market depth view" className="flex rounded border border-[#263249] bg-[#080c13] p-0.5 text-[8px] uppercase tracking-[0.1em]">
                      {(["ladder", "book"] as const).map((view) => (
                        <button
                          key={view}
                          type="button"
                          aria-pressed={bookView === view}
                          onClick={() => setBookView(view)}
                          className={`rounded-sm px-2 py-1.5 transition-colors ${bookView === view ? "bg-sky-400/15 text-sky-200" : "text-[#6f7d9a] hover:text-[#c7d2e4]"}`}
                        >
                          {view}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
                {bookOpen ? (
                  bookView === "ladder" ? (
                    <TerminalLiquidityLadder
                      frame={certifiedBookFrame}
                      side={side}
                      requestedNotionalUsd={notional}
                      limitPrice={entryPinned ? entryLevel : null}
                      selectedEntryPrice={entryLevel}
                      selectedVenue={venue.id}
                      selectedProduct={marketSel}
                      selectedInterval={chartInterval}
                      stale={certifiedBookFrame == null}
                      synthetic={selectedLiveFrame == null}
                      stagingDisabled={liveWorking}
                      onStagePrice={handleEntryDrag}
                    />
                  ) : (
                    certifiedBookFrame ? (
                      <BookTable signals={certifiedSignals} onSelectPrice={handleEntryDrag} stagingDisabled={liveWorking} />
                    ) : (
                      <MarketDepthUnavailable />
                    )
                  )
                ) : (
                  certifiedBookFrame ? (
                    <BookSummary signals={certifiedSignals} />
                  ) : (
                    <MarketDepthUnavailable compact />
                  )
                )}
                <TerminalBookPressureTape
                  frame={selectedLiveFrame}
                  selectedVenue={venue.id}
                  selectedProduct={marketSel}
                  selectedInterval={chartInterval}
                  network={venue.id === "hyperliquid" ? hyperliquidNetwork : "mainnet"}
                  bookAgeMs={unifiedMarket.telemetry.componentAgesMs.book ?? null}
                  observedAtMs={bookPressureObservedAtMs}
                  controllerStale={unifiedMarket.stale}
                  synthetic={selectedLiveFrame == null && frame != null}
                />
              </section>
              <div className="border-y border-[#182234] bg-gradient-to-b from-[#0a0e16] to-transparent px-4 py-3">
                <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#dce6f4]">Market tape</h2>
              </div>
              <TerminalTradeTape signals={certifiedSignals} onStagePrice={handleStageTradePrice} stagingDisabled={liveWorking} />
              <TerminalAlertCenter
                persistenceScope={traderPersistenceScope}
                instrument={marketSel}
                snapshotInstrument={certifiedSignals.snapshotInstrument}
                evaluationIdentityKey={certifiedSignals.evaluationIdentityKey}
                referencePrice={certifiedSignals.referencePrice}
                snapshot={alertSnapshot}
                snapshotCapturedAtMs={liveObservationNowMs}
                availableMetrics={availableAlertMetrics}
                feed={certifiedSignals.surfaces.alerts}
                planEntryPrice={entryLevel}
                planTargetPrice={targetPrice}
                planInvalidationPrice={stopLevel}
                savedPlanWatchRequest={savedPlanWatchRequest}
                savedPlanRemovalRequest={savedPlanRemovalRequest}
                savedPlanInventory={savedPlanInventory}
                onSavedPlanWatchIdsChange={handleSavedPlanWatchIdsChange}
                onSummaryChange={handleAlertSummaryChange}
                onPriceAlertsChange={handleChartPriceAlertsChange}
              />
            </aside>
          </div>
        </section>

        {mobileTicketOpen ? (
          <div
            aria-hidden="true"
            onClick={() => {
              setMobileTicketOpen(false);
              setOpenRow(null);
            }}
            className="fixed inset-0 z-40 bg-black/70 xl:hidden"
          />
        ) : null}
        <TerminalColumnResizeHandle
          className="hidden xl:block"
          controls="order-ticket"
          cssVariable="--terminal-ticket-width"
          defaultValue={TERMINAL_TICKET_WIDTH_PX.default}
          label="Resize order ticket"
          min={TERMINAL_TICKET_WIDTH_PX.min}
          max={Math.min(TERMINAL_TICKET_WIDTH_PX.max, TERMINAL_SIDE_COLUMNS_MAX_PX - marketRailWidthPx)}
          value={ticketWidthPx}
          onChange={setTicketWidthPx}
        />
        <aside
          ref={mobileTicketRef}
          id="order-ticket"
          role={mobileTicketOpen ? "dialog" : undefined}
          aria-modal={mobileTicketOpen ? true : undefined}
          aria-label="Order ticket"
          className={`${mobileTicketOpen ? "fixed inset-x-0 bottom-0 z-50 flex max-h-[90dvh] flex-col overflow-hidden rounded-t-xl border-t border-[#26354a]" : "hidden"} bg-[#070a10] xl:sticky xl:top-0 xl:z-auto xl:flex xl:h-[calc(100vh-3.5rem)] xl:max-h-none xl:flex-col xl:overflow-hidden xl:rounded-none xl:border-t-0`}
        >
          <TerminalResponsiveTicketMount
            mobileOpen={mobileTicketOpen}
            render={() => (
              <>
          <div className="shrink-0 border-b border-[#182234] p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-sm text-[#a8d8ff]">
                  <SlidersHorizontal className="h-4 w-4" />
                  Order ticket
                </div>
                <p className="mt-1 text-xs text-[#6f7d9a]">{productLabel} · limit entry</p>
              </div>
              <ReadinessBadge
                label={liveWorking ? "Plan locked" : localPreview ? "Local safe" : liveExecutionJournalSafety === "loading" ? "Ledger loading" : liveExecutionJournalSafety === "blocked" ? "Ledger locked" : liveExecutionJournalSafety === "unresolved" ? "Review prior submit" : ticketDecimalDraftBlocked ? "Fix ticket" : readyToExecute ? "Submit ready" : readyToPreview ? "Preview ready" : !thumperAuth.authenticated ? "Sign in needed" : !marketDataLive ? "Quote not certified" : "Fix risk"}
                ready={!liveWorking && readyToExecute}
              />
              <button
                ref={mobileTicketCloseRef}
                type="button"
                aria-label="Close order ticket"
                onClick={() => {
                  setMobileTicketOpen(false);
                  setOpenRow(null);
                }}
                className="trade-chip -mr-1 flex h-10 w-10 items-center justify-center rounded-md text-lg xl:hidden"
              >
                ×
              </button>
            </div>

          </div>

          <div
            inert={liveWorking ? true : undefined}
            aria-disabled={liveWorking || undefined}
            className={`min-h-0 flex-1 overflow-y-auto p-4 xl:p-5 ${liveWorking ? "cursor-wait opacity-70" : ""}`}
          >
            <section aria-labelledby="order-entry-heading" className="mb-4">
              <div className="mb-2 flex items-center justify-between gap-3">
                <h2 id="order-entry-heading" className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7d8ba5]">Entry order</h2>
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#566278]">{liveOrderMode.label}</span>
              </div>
              <p className="mt-2 text-[9px] leading-4 text-[#718097]">{liveOrderMode.explanation}</p>
              <div className="mt-3 grid grid-cols-2 gap-2" role="group" aria-label="Order side">
                {(["buy", "sell"] as const).map((item) => (
                  <button
                    key={item}
                    type="button"
                    aria-pressed={side === item}
                    aria-keyshortcuts={item === "buy" ? "B" : "S"}
                    onClick={() => {
                      setSide(item);
                      setStopPinned(false);
                    }}
                    className={`h-11 rounded-md text-sm font-semibold uppercase tracking-[0.08em] ${
                      side === item
                        ? item === "buy"
                          ? "border border-emerald-400/60 bg-emerald-400/15 text-emerald-200"
                          : "border border-rose-400/60 bg-rose-400/15 text-rose-200"
                        : "trade-chip"
                    }`}
                  >
                    {item} <kbd className="ml-1 font-mono text-[10px] opacity-60">{item === "buy" ? "B" : "S"}</kbd>
                  </button>
                ))}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <TradeInput
                  id={TERMINAL_TICKET_FIELD_IDS.notional}
                  ariaKeyShortcuts="N"
                  label="Order value"
                  value=""
                  prefix="$"
                  hint="$1–$100 · cents"
                  decimal={{
                    value: notional,
                    bounds: NOTIONAL_DRAFT_BOUNDS,
                    onValueChange: (value) => {
                      if (value != null) setNotional(value);
                    },
                    onDraftStatusChange: (status) => handleTicketDecimalStatus("notional", status),
                  }}
                />
                <TradeInput
                  label="Est. size"
                  value={estimatedBaseSize != null ? formatBaseSize(estimatedBaseSize) : "-"}
                  hint={marketSel}
                  readOnly
                />
                <TradeInput
                  id={TERMINAL_TICKET_FIELD_IDS.entry}
                  ariaKeyShortcuts="E"
                  label="Limit entry"
                  value=""
                  hint={entryPinned ? "manual" : "tracks mid"}
                  decimal={{
                    value: entryLevel,
                    bounds: priceDraftBounds,
                    allowEmpty: true,
                    onEditStart: () => {
                      if (!entryPinned && entryLevel != null) handleEntryDrag(entryLevel);
                    },
                    onValueChange: handleEntryDrag,
                    onDraftStatusChange: (status) => handleTicketDecimalStatus("entry", status),
                  }}
                />
                <TradeInput
                  id={TERMINAL_TICKET_FIELD_IDS.invalidation}
                  ariaKeyShortcuts="I"
                  label="Plan invalidation"
                  value=""
                  hint={!stopOnRiskSide ? "invalid side" : stopPinned ? "manual" : "auto 0.75%"}
                  invalid={!stopOnRiskSide}
                  decimal={{
                    value: stopLevel,
                    bounds: priceDraftBounds,
                    allowEmpty: true,
                    onEditStart: () => {
                      if (!stopPinned && stopLevel != null) handleStopChange(stopLevel);
                    },
                    onValueChange: handleStopChange,
                    onDraftStatusChange: (status) => handleTicketDecimalStatus("invalidation", status),
                  }}
                />
              </div>
              <TerminalEntryPriceStager
                stages={entryPriceStages}
                entryPinned={entryPinned}
                entryPrice={entryLevel}
                onAuto={handleAutoEntryPrice}
                onStage={handleStageEntryPrice}
              />
              <TerminalEntryOutcomeMatrix
                matrix={entryOutcomeMatrix}
                onStage={handleStageEntryPrice}
                onStageSafeSized={handleStageSafeSizedOutcome}
              />
              <TerminalEntryTargetSurface
                surface={entryTargetSurface}
                selectedEntryPrice={entryLevel}
                selectedMultiple={targetRewardMultiple}
                replay={scenarioReplayActive}
                onStage={handleStageEntryTarget}
              />
              <TerminalPlanBook
                key={`plan-book:${traderPersistenceScope ?? "identity-loading"}`}
                persistenceScope={traderPersistenceScope}
                identity={planBookIdentity}
                getCurrentReferencePrice={getPlanBookReferencePrice}
                onCapture={captureTerminalPlan}
                onRestore={restoreTerminalPlan}
                onInspectIdentity={inspectTerminalPlanIdentity}
                onWatch={watchTerminalPlan}
                onUnwatch={unwatchTerminalPlan}
                onInventoryChange={handleSavedPlanInventoryChange}
                watchedPlanIds={watchedSavedPlanIds}
              />
              <div className="mt-2 flex items-center justify-between gap-2">
                <div className="flex gap-1" role="group" aria-label="Slippage tolerance" aria-keyshortcuts="V">
                  {[25, 50, 100].map((item) => (
                    <button
                      key={item}
                      type="button"
                      aria-pressed={slippageBps === item}
                      onClick={() => setSlippageBps(item)}
                      className={`h-7 rounded px-2 font-mono text-[10px] ${slippageBps === item ? "trade-chip-on" : "trade-chip"}`}
                    >
                      {item} bp
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setEntryPinned(false);
                    setStopPinned(false);
                  }}
                  className="text-[10px] text-[#6f7d9a] underline decoration-[#344258] underline-offset-4 hover:text-[#dce6f4]"
                >
                  Reset levels
                </button>
              </div>
              {!stopOnRiskSide ? (
                <p role="alert" className="mt-2 flex items-start gap-1.5 text-[11px] leading-4 text-rose-300">
                  <AlertTriangle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {side === "buy" ? "Buy invalidation must be below entry." : "Sell invalidation must be above entry."} Submission is blocked.
                </p>
              ) : null}
            </section>

            <RiskSizer
              budgetUsd={riskBudgetUsd}
              sizing={positionSizing}
              sizeRecommendation={allInSizeRecommendation}
              onBudgetChange={handleRiskBudgetChange}
              onApply={handleApplyRiskSizedNotional}
              onDraftStatusChange={handleRiskBudgetDraftStatus}
            />

            <TerminalInvalidationPlanner
              plan={invalidationPlan}
              onStage={handleStageAtrInvalidation}
            />

            <TerminalRiskBudgetInterlock
              decision={riskBudgetInterlock}
              lossEnvelope={planLossEnvelope}
              sizeRecommendation={allInSizeRecommendation}
              onApplySafeNotional={handleApplyRiskSizedNotional}
              onOpenCostPolicy={openRouteCheck}
            />

            <TerminalPlanMarketState decision={planMarketState} />

            <TerminalLivePortfolioInterlock decision={effectiveLiveAccountRisk} />

            <TerminalExecutionFlightCheck
              decision={executionFlightCheck}
              onAction={handleExecutionFlightAction}
            />

            <TerminalBoundPlanAudit
              audit={boundPlanAudit}
              onFocusField={focusTicketField}
            />

              <TerminalLiveExecutionJournal
                entries={scopedLiveExecutionJournal}
                onFocusAccount={focusLiveAccount}
                onReviewEntry={handleExternalExecutionReview}
                reviewBlocker={externalReviewDecision?.allowed === false ? terminalLiveExecutionExternalReviewBlockerLabel(externalReviewDecision.blocker) : null}
                storageStatus={scopedLiveExecutionJournalStorageStatus}
                selectedVenue={venue.id}
                selectedNetwork={venue.id === "hyperliquid" ? hyperliquidNetwork : "mainnet"}
                accountStreamCurrent={effectiveLiveAccountRisk.accountStreamCurrent}
                accountStreamObservedAtMs={effectiveLiveAccountRisk.accountStreamObservedAtMs}
                onCopyEvidence={copyLiveExecutionEvidence}
                onExportEvidence={downloadLiveExecutionEvidence}
              />

            <TerminalFundingCarry
              preview={fundingCarryPreview}
            />

            <ScenarioAnalysisPanel
              analysis={scenarioAnalysis}
              replay={scenarioReplayActive}
              sourceFresh={scenarioSourceFresh}
            />

            <TerminalPlanPathAnalysis
              analysis={planPathAnalysis}
              replay={scenarioReplayActive}
              sourceFresh={scenarioSourceFresh}
            />

            <TerminalPlanPathStudy
              studies={planPathStudies}
              replay={scenarioReplayActive}
              sourceFresh={scenarioSourceFresh}
            />

            <TerminalPlanPayoffCalibration
              calibration={planPayoffCalibration}
              replay={scenarioReplayActive}
            />

            <TerminalRewardLadder
              ladder={rewardLadder}
              replay={scenarioReplayActive}
              selectedMultiple={targetRewardMultiple}
              onStage={handleStageRewardTarget}
            />

            <PositionPreview
              side={side}
              product={productLabel}
              notional={notional}
              baseSize={estimatedBaseSize}
              entry={entryLevel}
              mark={mid}
              maxLoss={maxLossUsd}
              targetPrice={targetPrice}
              targetRewardMultiple={targetRewardMultiple}
              status={terminalPositionPreviewStatus(
                liveExecution.status,
                liveExecution.status === "working" ? liveExecution.stage : null,
              )}
            />

            <div className="trade-panel relative rounded-md p-4">
              <span aria-hidden className="trade-corners pointer-events-none absolute inset-0" />
              <div className="mb-3 flex items-center justify-between gap-3">
                <span className="text-[9px] font-semibold uppercase tracking-[0.24em] text-[#5aa7ff]/70">Mandate</span>
                <span
                  className={`font-mono text-[9px] uppercase tracking-[0.18em] ${
                    preview.status === "done" ? "text-emerald-300" : "text-[#566278]"
                  }`}
                >
                  {preview.status === "done" ? `bound · ${preview.planBinding.plan_digest.slice(7, 15)}` : "draft"}
                </span>
              </div>
              <div className="grid gap-2 text-[15px] text-[#7b88a1]">
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
                <Token
                  active={openRow === "size"}
                  tone={side === "buy" ? "good" : "bad"}
                  onClick={() => setOpenRow(openRow === "size" ? null : "size")}
                >
                  {side === "buy" ? "Buy" : "Sell"} ${notional}
                </Token>
                <span>of</span>
                <Token
                  active={openRow === "market"}
                  onClick={() => setOpenRow(openRow === "market" ? null : "market")}
                >
                  {productLabel}
                </Token>
              </div>
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
                <span>when</span>
                <Token
                  active={openRow === "idea"}
                  auto={!ideaManual}
                  onClick={() => setOpenRow(openRow === "idea" ? null : "idea")}
                >
                  {selectedStrategy(STRATEGIES, strategy).condition}
                </Token>
              </div>
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
                <Token
                  active={openRow === "trigger"}
                  auto={!triggerManual}
                  onClick={() => setOpenRow(openRow === "trigger" ? null : "trigger")}
                >
                  {TRIGGER_PHRASES[entryTrigger].term}
                </Token>
                <span>{TRIGGER_PHRASES[entryTrigger].connective}</span>
                <Token
                  active={openRow === "entry"}
                  auto={!entryPinned}
                  mono
                  onClick={() => setOpenRow(openRow === "entry" ? null : "entry")}
                >
                  {formatPrice(entryPrice ?? mid)}
                </Token>
              </div>
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
                <span className="inline-flex items-center gap-1.5">
                  <span>invalidate at</span>
                  <Token
                    active={openRow === "stop"}
                    auto={!stopPinned}
                    tone="bad"
                    mono
                    onClick={() => setOpenRow(openRow === "stop" ? null : "stop")}
                  >
                    {stopLevel ? formatPrice(stopLevel) : "not set"}
                  </Token>
                </span>
                <span className="text-[#3c4961]">·</span>
                <span className="inline-flex items-center gap-1.5">
                  <span>slippage ≤</span>
                  <Token
                    active={openRow === "slippage"}
                    tone="warn"
                    mono
                    onClick={() => setOpenRow(openRow === "slippage" ? null : "slippage")}
                  >
                    {slippageBps} bps
                  </Token>
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
                <span className="inline-flex items-center gap-1.5">
                  <Token
                    active={openRow === "horizon"}
                    onClick={() => setOpenRow(openRow === "horizon" ? null : "horizon")}
                  >
                    {HORIZONS.find((item) => item.id === horizon)?.label ?? horizon}
                  </Token>
                  <span>horizon</span>
                </span>
                <span className="text-[#3c4961]">·</span>
                <span className="inline-flex items-center gap-1.5">
                  <Token
                    active={openRow === "stoprule"}
                    auto={!stopRuleManual}
                    onClick={() => setOpenRow(openRow === "stoprule" ? null : "stoprule")}
                  >
                    {(STOP_RULES.find((item) => item.id === stopRule)?.label ?? stopRule).toLowerCase()}
                  </Token>
                  <span>exit</span>
                </span>
              </div>
              </div>
            </div>
            <p className="mt-2.5 text-[11px] leading-5 text-[#566278]">
              Your agent&apos;s read of the plan — tap any highlighted term to change it, or drag the
              lines on the chart.
              <span className="text-emerald-300/80"> Green dots</span> mark what it inferred.
            </p>
            {openRow && (
              <div className="trade-panel mt-4 rounded-md p-3">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-[#6b7997]">
                    {TOKEN_TITLES[openRow] ?? openRow}
                  </span>
                  <span className="flex items-center gap-3">
                    {openRow === "idea" && ideaManual && (
                      <EditorResetButton onClick={() => setIdeaManual(false)} />
                    )}
                    {openRow === "trigger" && triggerManual && (
                      <EditorResetButton onClick={() => setTriggerManual(false)} />
                    )}
                    {openRow === "entry" && entryPinned && (
                      <EditorResetButton
                        onClick={handleAutoEntryPrice}
                      />
                    )}
                    {openRow === "stop" && stopPinned && (
                      <EditorResetButton onClick={() => setStopPinned(false)} />
                    )}
                    {openRow === "stoprule" && stopRuleManual && (
                      <EditorResetButton onClick={() => setStopRuleManual(false)} />
                    )}
                    <button
                      type="button"
                      aria-label="Close editor"
                      onClick={() => setOpenRow(null)}
                      className="text-sm leading-none text-[#566278] transition hover:text-[#eef1f8]"
                    >
                      ✕
                    </button>
                  </span>
                </div>

                {openRow === "market" && (
                  <ButtonGrid
                    items={venue.markets.map((market) => ({
                      id: market,
                      label: venueProductLabel(venue.id, market),
                    }))}
                    selected={marketSel}
                    onSelect={(market) => {
                      setMarketSel(market);
                      setEntryPinned(false);
                      setStopPinned(false);
                    }}
                  />
                )}
                {openRow === "idea" && (
                  <ButtonGrid items={STRATEGIES} selected={strategy} onSelect={selectIdea} />
                )}
                {openRow === "trigger" && (
                  <ButtonGrid
                    items={ENTRY_TRIGGERS.filter((item) => TRIGGERS_FOR[strategy].includes(item.id))}
                    selected={entryTrigger}
                    onSelect={selectTrigger}
                  />
                )}
                {openRow === "entry" && (
                  <div className="grid grid-cols-[1fr_auto] gap-2">
                    <TerminalDecimalInput
                      aria-label="Entry price"
                      value={entryPrice}
                      bounds={priceDraftBounds}
                      allowEmpty
                      onEditStart={() => {
                        if (!entryPinned && entryLevel != null) handleEntryDrag(entryLevel);
                      }}
                      onValueChange={handleEntryDrag}
                      onDraftStatusChange={(status) => handleTicketDecimalStatus("entry", status)}
                      invalidClassName="ring-1 ring-inset ring-rose-400/60"
                      className="trade-field h-10 min-w-0 rounded-md px-3 font-mono text-sm tabular-nums text-[#eef1f8] outline-none"
                    />
                    <button
                      type="button"
                      onClick={handleAutoEntryPrice}
                      disabled={priceAuthority.automaticEntryPrice == null}
                      title={priceAuthority.automaticEntryPrice == null ? "Waiting for certified BBO" : "Track certified BBO midpoint"}
                      className="trade-chip h-10 rounded-md px-3 text-sm disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      Current
                    </button>
                  </div>
                )}
                {openRow === "stop" && (
                  <div className="grid grid-cols-[1fr_auto] gap-2">
                    <TerminalDecimalInput
                      aria-label="Plan invalidation"
                      value={stopLevel}
                      bounds={priceDraftBounds}
                      allowEmpty
                      onEditStart={() => {
                        if (!stopPinned && stopLevel != null) handleStopChange(stopLevel);
                      }}
                      onValueChange={handleStopChange}
                      onDraftStatusChange={(status) => handleTicketDecimalStatus("invalidation", status)}
                      invalidClassName="ring-1 ring-inset ring-rose-400/60"
                      className="trade-field h-10 min-w-0 rounded-md px-3 font-mono text-sm tabular-nums text-[#eef1f8] outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => setStopPinned(false)}
                      className="trade-chip h-10 rounded-md px-3 text-sm"
                    >
                      Auto
                    </button>
                  </div>
                )}
                {openRow === "size" && (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      {(["buy", "sell"] as const).map((item) => (
                        <button
                          key={item}
                          type="button"
                          aria-pressed={side === item}
                          onClick={() => {
                            setSide(item);
                            setStopPinned(false);
                          }}
                          className={`h-10 rounded-md text-sm font-medium capitalize transition-shadow duration-150 ${
                            side === item
                              ? item === "buy"
                                ? "border border-emerald-400/60 bg-gradient-to-b from-emerald-400/20 to-emerald-400/8 text-emerald-200 shadow-[inset_0_1px_0_rgba(110,231,183,0.2),0_0_16px_-6px_rgba(52,211,153,0.5)]"
                                : "border border-rose-400/60 bg-gradient-to-b from-rose-400/20 to-rose-400/8 text-rose-200 shadow-[inset_0_1px_0_rgba(251,113,133,0.2),0_0_16px_-6px_rgba(251,113,133,0.5)]"
                              : "trade-chip"
                          }`}
                        >
                          {item}
                        </button>
                      ))}
                    </div>
                    <div className="mt-2 grid grid-cols-4 gap-2">
                      {[10, 25, 50, 100].map((item) => (
                        <button
                          key={item}
                          type="button"
                          aria-pressed={notional === item}
                          onClick={() => setNotional(item)}
                          className={`h-9 rounded-md text-sm tabular-nums ${
                            notional === item ? "trade-chip-on" : "trade-chip"
                          }`}
                        >
                          ${item}
                        </button>
                      ))}
                    </div>
                    <div className="relative mt-2">
                      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-sm text-[#566278]">
                        $
                      </span>
                      <TerminalDecimalInput
                        aria-label="Amount in USD"
                        value={notional}
                        bounds={NOTIONAL_DRAFT_BOUNDS}
                        onValueChange={(value) => {
                          if (value != null) setNotional(value);
                        }}
                        onDraftStatusChange={(status) => handleTicketDecimalStatus("notional", status)}
                        invalidClassName="ring-1 ring-inset ring-rose-400/60"
                        errorClassName="mt-1 block pl-7 text-[9px] text-rose-300"
                        className="trade-field h-10 w-full rounded-md pl-7 pr-3 font-mono text-sm tabular-nums text-[#eef1f8] outline-none"
                      />
                    </div>
                  </>
                )}
                {openRow === "slippage" && (
                  <>
                    <div className="grid grid-cols-3 gap-2">
                      {[25, 50, 100].map((item) => (
                        <button
                          key={item}
                          type="button"
                          aria-pressed={slippageBps === item}
                          onClick={() => setSlippageBps(item)}
                          className={`h-10 rounded-md text-sm tabular-nums transition-shadow duration-150 ${
                            slippageBps === item
                              ? "border border-[#f8e56b]/70 bg-gradient-to-b from-[#332d12] to-[#231f0c] text-[#fff27a] shadow-[inset_0_1px_0_rgba(248,229,107,0.18),0_0_16px_-6px_rgba(248,229,107,0.45)]"
                              : "trade-chip"
                          }`}
                        >
                          {item} bps
                        </button>
                      ))}
                    </div>
                    <p className="mt-2 font-mono text-[11px] tabular-nums text-[#8b95a8]">Band: {slippageBand}</p>
                  </>
                )}
                {openRow === "horizon" && (
                  <ButtonGrid items={HORIZONS} selected={horizon} onSelect={(id) => setHorizon(id)} />
                )}
                {openRow === "stoprule" && (
                  <ButtonGrid
                    items={STOP_RULES}
                    selected={stopRule}
                    onSelect={(id) => {
                      setStopRule(id);
                      setStopRuleManual(true);
                    }}
                  />
                )}
              </div>
            )}

            <div className="mt-6 border-t border-[#141d2e] pt-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-[#6b7997]">Pre-trade risk</p>
                <span className={`font-mono text-[10px] uppercase ${stopOnRiskSide ? "text-emerald-300" : "text-rose-300"}`}>
                  {stopOnRiskSide ? "invalidation valid" : "blocked"}
                </span>
              </div>
              <div className="mt-2.5 grid grid-cols-3 gap-2">
                <div className="trade-field rounded-md px-2.5 py-2">
                  <p className="text-[9px] uppercase tracking-[0.14em] text-[#566278]">Invalidation</p>
                  <p className="mt-1 font-mono text-sm tabular-nums text-[#eef1f8]">
                    {stopDistancePct != null ? `${(stopDistancePct * 100).toFixed(2)}%` : "-"}
                  </p>
                </div>
                <div className="trade-field rounded-md px-2.5 py-2">
                  <p className="text-[9px] uppercase tracking-[0.14em] text-[#566278]">Modeled loss</p>
                  <p className="mt-1 font-mono text-sm tabular-nums text-rose-200">
                    {maxLossUsd != null ? `$${maxLossUsd.toFixed(2)}` : "-"}
                  </p>
                </div>
                <div className="trade-field rounded-md px-2.5 py-2">
                  <p className="text-[9px] uppercase tracking-[0.14em] text-[#566278]">Worst fill</p>
                  <p className="mt-1 font-mono text-sm tabular-nums text-[#fff27a]">
                    {worstFill != null ? formatPrice(worstFill) : "-"}
                  </p>
                </div>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2">
                <RiskMetric label={`${targetRewardMultiple.toFixed(1)}R target`} value={formatPrice(targetPrice)} />
                <RiskMetric label="Spread cost" value={tradeRisk.crossingCostUsd != null ? `$${tradeRisk.crossingCostUsd.toFixed(3)}` : "-"} />
                <RiskMetric label="Size" value={estimatedBaseSize != null ? formatBaseSize(estimatedBaseSize) : "-"} />
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <RiskMetric label="Book fill" value={executionQuality.status === "no_market" ? "-" : `${executionQuality.fillPct.toFixed(0)}%`} />
                <RiskMetric label="Book VWAP" value={formatPrice(executionQuality.vwap)} />
                <RiskMetric label="Impact" value={executionQuality.impactBps != null ? `${executionQuality.impactBps.toFixed(2)} bp` : "-"} />
                <RiskMetric label="Limit guard" value={formatLimitGuard(livePlanSlippageBound.limitOffsetBps, slippageBps)} />
              </div>
              {executionQuality.status === "partial" || executionQuality.status === "none" ? (
                <p role="alert" className="mt-2 text-[10px] leading-4 text-amber-200">
                  Visible book fills {executionQuality.fillPct.toFixed(0)}%; ${(executionQuality.unfilledNotionalUsd ?? 0).toFixed(2)} has no eligible displayed liquidity at this limit.
                </p>
              ) : null}
              <TerminalLiquidityStress curve={liquidityStress} />
              <TerminalRouteCheckControl
                active={routeFeedsEnabled}
                compareMode={compareWorkspaceActive}
                liveVenueCount={venueHealth.liveVenueCount}
                totalVenueCount={venueHealth.health.length}
                status={routeDecision.status}
                onOpen={openRouteCheck}
                onStop={stopRouteCheck}
              />
              <p className="mt-2 text-[10px] leading-4 text-[#566278]">
                Modeled loss assumes an exit at the invalidation within the slippage cap. Gaps, outages, and venue failures can produce a larger realized loss.
              </p>
              <p className="mt-1 text-[10px] leading-4 text-amber-200/75">
                Strategy, trigger, and plan invalidation are agent-plan controls. One-shot live submit sends the entry limit only; it is not a bracket order.
              </p>
            </div>

            <div className="mt-5 border-t border-[#141d2e] pt-4">
              <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-[#6b7997]">Visibility</p>
              <div className="mt-2.5 grid gap-2">
                <VisibilityRow
                  label="Trading authority"
                  value={venue.id === "phoenix" ? "explicitly approved" : "scoped venue access"}
                  tone="good"
                />
                <VisibilityRow label="Execution" value="sealed runtime" tone="good" />
                <VisibilityRow label={`${venue.label} sees`} value="venue account + order" tone="warn" />
              </div>
            </div>
            {userSignedPayloadRequired && (
              <div className="mt-5 border-t border-[#141d2e] pt-4">
                {venue.id === "phoenix" ? (
                  <p role="alert" className="text-[10px] leading-4 text-amber-200">
                    Phoenix GTC/full-ticket submit is unavailable. The worker accepts only tiny-fill IOC, and this terminal does not yet build and verify that exact mode.
                  </p>
                ) : (
                  <>
                    <label className="text-[10px] font-medium uppercase tracking-[0.18em] text-[#6b7997]" htmlFor="signed-live-payload">
                      Signed payload
                    </label>
                    <textarea
                      id="signed-live-payload"
                      value={signedPayloadText}
                      onChange={(event) => setSignedPayloadText(event.target.value)}
                      spellCheck={false}
                      className="trade-field mt-2 h-24 w-full resize-none rounded-md px-3 py-2 font-mono text-xs leading-5 text-[#eef1f8] outline-none"
                      placeholder="Exact signedAction JSON with network"
                    />
                    {signedPayloadText.trim() ? (
                      <p className={`mt-1.5 text-[10px] ${signedPayloadValid ? "text-emerald-300" : "text-rose-300"}`}>
                        {signedPayloadValid
                          ? "One signed IOC action matches the bound plan; the server rechecks configured asset identity."
                          : "Action must exactly match the bound side, price, size, TIF, reduce-only, and network."}
                      </p>
                    ) : null}
                  </>
                )}
              </div>
            )}
            {venue.id === "hyperliquid" && !localPreview ? (
              <div id="hyperliquid-connection" className="scroll-mt-4">
                <ConnectHyperliquidButton
                  ready={thumperAuth.authenticated}
                  network={hyperliquidNetwork}
                  onNetworkChange={setHyperliquidNetwork}
                />
              </div>
            ) : null}
            {localPreview ? null : (
              <ArmAgentButton orderDraft={orderDraft} ready={readyToArm && !localPreview} network={hyperliquidNetwork} />
            )}
          </div>

          <div className="shrink-0 border-t border-[#182234] bg-[#070a10] p-4 xl:p-5">
            <div className="grid gap-2">
              {!thumperAuth.authenticated ? (
                <button
                  type="button"
                  onClick={() => openAuth("signup")}
                  className="trade-action flex h-12 items-center justify-center gap-2 rounded-md text-sm font-semibold"
                >
                  <KeyRound className="h-4 w-4" />
                  Sign in to connect API keys
                </button>
              ) : (
                <>
                  <button
                    id="terminal-preview-order"
                    type="button"
                    onClick={handlePreview}
                    disabled={preview.status === "working" || !readyToPreview}
                    className="trade-action flex h-12 items-center justify-center gap-2 rounded-md text-sm font-semibold disabled:cursor-wait disabled:opacity-70"
                  >
                    {preview.status === "working" ? (
                      <RefreshCcw className="h-4 w-4 animate-spin" />
                    ) : (
                      <Play className="h-4 w-4" />
                    )}
                    {preview.status === "working"
                      ? "Binding exact order plan"
                      : preview.status === "done"
                        ? "Refresh bound preview"
                        : "Bind & preview exact plan"}
                  </button>
                  {preview.status === "done" && (
                    <p role="status" aria-live="polite" aria-atomic="true" className="flex items-center gap-1.5 font-mono text-xs text-emerald-200">
                      <CheckCircle2 aria-hidden className="h-3.5 w-3.5" />
                      Exact plan bound {preview.planBinding.plan_digest.slice(0, 21)}…
                    </p>
                  )}
                  {preview.status === "error" && (
                    <p role="alert" aria-atomic="true" className="text-xs leading-5 text-rose-300">
                      <span className="sr-only">Real-money order preview failed: </span>{preview.message}
                    </p>
                  )}
                  {liveSubmitReview ? (
                    <TerminalLiveSubmitReview
                      review={liveSubmitReview}
                      liquidity={liveSubmitLiquidityEvidence}
                      decision={liveSubmitReviewDecision}
                      onConfirm={handleConfirmLiveSubmitReview}
                      onCancel={() => setLiveSubmitReview(null)}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={handleOpenLiveSubmitReview}
                      disabled={liveWorking || !readyToExecute}
                      className="trade-action flex h-12 items-center justify-center gap-2 rounded-md text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {liveWorking ? (
                        <RefreshCcw className="h-4 w-4 animate-spin" />
                      ) : (
                        <ShieldCheck className="h-4 w-4" />
                      )}
                      {liveWorking
                        ? liveExecution.stage === "session"
                          ? "Opening trading session"
                          : liveExecution.stage === "linking"
                            ? "Linking venue"
                            : "Submitting live order"
                        : localPreview ? "Live submit unavailable locally" : "Review exact live order"}
                    </button>
                  )}
                  {executionBlocker ? (
                    <p className="flex items-center gap-1.5 text-[11px] text-amber-200/80">
                      <AlertTriangle aria-hidden className="h-3.5 w-3.5 shrink-0" />
                      {executionBlocker}
                    </p>
                  ) : null}
                  {liveExecution.status === "done" && (
                    <p role="status" aria-live="polite" aria-atomic="true" className="flex items-center gap-1.5 font-mono text-xs text-emerald-200">
                      <Check aria-hidden className="h-3.5 w-3.5" />
                      Submission acknowledgement verified · {liveExecution.receipt.commitment.slice(0, 14)}…
                    </p>
                  )}
                  {liveExecution.status === "unknown" && (
                    <p role="alert" aria-atomic="true" className="text-xs leading-5 text-rose-300">
                      <span className="sr-only">Real-money submission outcome unknown: </span>{liveExecution.message}
                    </p>
                  )}
                  {liveExecution.status === "error" && (
                    <p role="alert" aria-atomic="true" className="text-xs leading-5 text-rose-300">
                      <span className="sr-only">Real-money live submit failed: </span>{liveExecution.message}
                    </p>
                  )}
                </>
              )}
              <button
                id="terminal-refresh-market"
                type="button"
                disabled={preview.status === "working" || liveWorking}
                onClick={handleReconnectMarket}
                className="trade-chip flex h-10 items-center justify-center gap-2 rounded-md text-sm disabled:cursor-wait disabled:opacity-45"
              >
                <RefreshCcw className={`h-4 w-4 ${loadingMarket ? "animate-spin" : ""}`} />
                Reconnect selected feed
              </button>
            </div>
          </div>
              </>
            )}
          />
        </aside>
      </main>
      {!mobileTicketOpen ? (
        <button
          ref={mobileTicketTriggerRef}
          id={MOBILE_TICKET_TRIGGER_ID}
          type="button"
          aria-controls="order-ticket"
          aria-expanded="false"
          onClick={(event) => {
            mobileTicketReturnFocusRef.current = event.currentTarget;
            setMobileTicketOpen(true);
          }}
          className="trade-action fixed bottom-[max(0.75rem,env(safe-area-inset-bottom))] right-3 z-40 flex h-12 items-center gap-2 rounded-full px-4 text-sm font-semibold shadow-[0_14px_40px_rgba(0,0,0,0.55)] xl:hidden"
        >
          <SlidersHorizontal aria-hidden className="h-4 w-4" />
          Order ticket
          <span className="font-mono text-[10px] opacity-75">{formatPrice(entryLevel)}</span>
        </button>
      ) : null}
      <TerminalPaperWorkstation
        key={`paper:${traderPersistenceScope ?? "identity_loading"}`}
        persistenceScope={traderPersistenceScope}
        inert={mobileTicketOpen}
        frame={selectedLiveFrame}
        venueId={venue.id}
        network={venue.id === "hyperliquid" ? hyperliquidNetwork : "mainnet"}
        product={productLabel}
        side={side}
        limitPrice={entryLevel}
        quoteNotionalUsd={notional}
        stopLevel={stopLevel}
        targetPrice={targetPrice}
        targetRewardMultiple={targetRewardMultiple}
        marketDataLive={marketDataLive}
        marketMaxAgeMs={marketFreshnessLimitMs(chartInterval)}
        onSelectMarkMarket={selectPaperMarkMarket}
      />
    </div>
  );
}

interface BuildLiveExecutionBodyInput {
  csrfToken: string;
  venueIds: VenueId[];
  venueId: VenueId;
  webUserId: string;
  market: string;
  productLabel: string;
  side: Side;
  notional: number;
  entryPrice: number | null;
  slippageBps: number;
  signedMaterial: Record<string, unknown>;
  tradeOrderPlanBinding: TradeOrderPlanBindingEnvelope;
}

async function buildLiveExecutionBody(input: BuildLiveExecutionBodyInput): Promise<Record<string, unknown>> {
  const boundPlan = input.tradeOrderPlanBinding.order_plan;
  const baseSize = boundPlan.base_size;
  const limitPrice = boundPlan.limit_price;
  const idempotencyKey = tradeOrderPlanIdempotencyKey(input.tradeOrderPlanBinding);
  if (!idempotencyKey) throw new Error("Bound order plan has no valid idempotency key");
  const executionCredentialHandleCommitmentsByVenue: Partial<Record<VenueId, string>> = {};
  for (const venueId of input.venueIds) {
    executionCredentialHandleCommitmentsByVenue[venueId] = await objectHashHex({
      type: "ghola_trade_page_execution_credential_handle_v1",
      webUserId: input.webUserId,
      venueId,
    });
  }

  const body: Record<string, unknown> = {
    ...input.signedMaterial,
    csrfToken: input.csrfToken,
    venueIds: input.venueIds,
    ensureWallet: input.venueIds.includes("phoenix"),
    executionCredentialHandleCommitmentsByVenue,
    idempotencyKey,
    submit: true,
    refreshAfterSubmit: true,
    fetchFills: true,
    cancelIfOpen: false,
    tradeOrderPlanBinding: input.tradeOrderPlanBinding,
    orderIntent: {
      idempotencyKey,
      venueIds: input.venueIds,
      symbol: input.venueId === "hyperliquid" ? input.market : input.productLabel,
      productId: input.venueIds.includes("coinbase") ? `${input.market}-USD` : input.productLabel,
      side: input.side,
      orderType: boundPlan.order_type,
      timeInForce: boundPlan.time_in_force,
      network: input.tradeOrderPlanBinding.order_plan.network,
      baseSize,
      quoteSize: boundPlan.quote_notional_usd,
      limitPrice,
      slippageBps: String(input.slippageBps),
    },
  };

  if (input.venueIds.includes("hyperliquid")) {
    body.hyperliquidAccountCommitment = await objectHashHex({
      type: "ghola_trade_page_hyperliquid_account_commitment_v1",
      webUserId: input.webUserId,
    });
  }
  if (input.venueIds.includes("coinbase")) {
    body.coinbaseAccountCommitment = await objectHashHex({
      type: "ghola_trade_page_coinbase_account_commitment_v1",
      webUserId: input.webUserId,
    });
  }

  return body;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

async function objectHashHex(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(stableStringify(value)),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const CHART_FONT = "ui-monospace, SFMono-Regular, Menlo, monospace";

interface MarketChartProps {
  frame: GholaMarketFrame | null;
  overlays: GholaChartOverlay[];
  side: Side;
  entryPrice: number | null;
  stopPrice: number | null;
  stopSuggested: boolean;
  interactionAllowed: boolean;
  onEntryDrag: (price: number) => void;
  onStopDrag: (price: number) => void;
}

const MarketChart = memo(function MarketChart({
  frame,
  overlays,
  side,
  entryPrice,
  stopPrice,
  stopSuggested,
  interactionAllowed,
  onEntryDrag,
  onStopDrag,
}: MarketChartProps) {
  const frameCandles = frame?.candles;
  const candles = useMemo(() => decimateCandles(frameCandles ?? [], 96), [frameCandles]);
  const [hover, setHover] = useState<{ index: number; y: number } | null>(null);
  const [drag, setDrag] = useState<"entry" | "stop" | null>(null);
  const [dragPrice, setDragPrice] = useState<number | null>(null);
  const dragPriceRef = useRef<number | null>(null);
  const dragTargetRef = useRef<"entry" | "stop" | null>(null);
  const dragPointerIdRef = useRef<number | null>(null);
  const dragInitialPriceRef = useRef<number | null>(null);
  const dragChangedRef = useRef(false);
  const effectiveDrag = interactionAllowed ? drag : null;
  const displayedEntryPrice = effectiveDrag === "entry" && dragPrice != null ? dragPrice : entryPrice;
  const displayedStopPrice = effectiveDrag === "stop" && dragPrice != null ? dragPrice : stopPrice;
  const layoutOverlays = useMemo(() => {
    const extra: GholaChartOverlay[] = [];
    if (displayedEntryPrice != null && displayedEntryPrice > 0) {
      extra.push({ id: "drag-entry", kind: "price_line", label: "entry", tone: "accent", price: displayedEntryPrice });
    }
    if (displayedStopPrice != null && displayedStopPrice > 0) {
      extra.push({ id: "drag-stop", kind: "price_line", label: "plan invalidation", tone: "bad", price: displayedStopPrice });
    }
    return overlays.concat(extra);
  }, [displayedEntryPrice, displayedStopPrice, overlays]);
  const chart = useMemo(() => chartLayout(candles, layoutOverlays), [candles, layoutOverlays]);
  const hovered = hover ? candles[hover.index] : null;
  const last = candles.at(-1);
  const lastClose = last ? Number(last.c) : null;
  const lastUp = last ? Number(last.c) >= Number(last.o) : true;
  const lastColor = lastUp ? "#34d399" : "#fb7185";
  const labels = useMemo(() => overlayLabelSlots(overlays, chart, side), [chart, overlays, side]);
  const entryColor = side === "buy" ? "#34d399" : "#fb7185";
  const entryY = displayedEntryPrice != null && displayedEntryPrice > 0 ? chart.y(displayedEntryPrice) : null;
  const stopY = displayedStopPrice != null && displayedStopPrice > 0 ? chart.y(displayedStopPrice) : null;
  const HIT_RADIUS = 12;
  const hoverNearLine =
    interactionAllowed &&
    hover != null &&
    [entryY, stopY].some((lineY) => lineY != null && Math.abs(hover.y - lineY) <= HIT_RADIUS);

  function svgPoint(event: React.PointerEvent<SVGSVGElement>) {
    // The SVG preserves its viewBox aspect ratio (xMidYMid meet), so the
    // drawing is letterboxed inside the element — map through the real
    // scale and centering offsets or pointer hits land off-target.
    const rect = event.currentTarget.getBoundingClientRect();
    const scale = Math.min(rect.width / chart.width, rect.height / chart.height) || 1;
    const offsetX = (rect.width - chart.width * scale) / 2;
    const offsetY = (rect.height - chart.height * scale) / 2;
    return {
      x: (event.clientX - rect.left - offsetX) / scale,
      y: (event.clientY - rect.top - offsetY) / scale,
    };
  }

  function clampPlotY(y: number) {
    return Math.min(chart.height - chart.padding.bottom, Math.max(chart.padding.top, y));
  }

  function handlePointerMove(event: React.PointerEvent<SVGSVGElement>) {
    if (candles.length === 0) return;
    const { x, y } = svgPoint(event);
    if (dragTargetRef.current) {
      if (event.pointerId !== dragPointerIdRef.current) return;
      const price = chart.priceAt(clampPlotY(y));
      if (Number.isFinite(price) && price > 0) {
        const nextPrice = roundForInput(price);
        dragPriceRef.current = nextPrice;
        dragChangedRef.current = nextPrice !== dragInitialPriceRef.current;
        setDragPrice(nextPrice);
      }
      return;
    }
    const ratio = (x - chart.padding.left) / Math.max(1, chart.plotWidth);
    const index = Math.min(candles.length - 1, Math.max(0, Math.round(ratio * (candles.length - 1))));
    setHover({ index, y: clampPlotY(y) });
  }

  function handlePointerDown(event: React.PointerEvent<SVGSVGElement>) {
    if (!interactionAllowed || candles.length === 0 || dragTargetRef.current || event.button !== 0 || !event.isPrimary) return;
    const { y } = svgPoint(event);
    const nearEntry = entryY != null && Math.abs(y - entryY) <= HIT_RADIUS;
    const nearStop = stopY != null && Math.abs(y - stopY) <= HIT_RADIUS;
    let target: "entry" | "stop" | null = null;
    if (nearEntry && nearStop) {
      target = Math.abs(y - (entryY as number)) <= Math.abs(y - (stopY as number)) ? "entry" : "stop";
    } else if (nearEntry) {
      target = "entry";
    } else if (nearStop) {
      target = "stop";
    }
    if (target) {
      const initialPrice = target === "entry" ? displayedEntryPrice : displayedStopPrice;
      if (initialPrice == null || !Number.isFinite(initialPrice) || initialPrice <= 0) return;
      dragPriceRef.current = initialPrice;
      dragTargetRef.current = target;
      dragPointerIdRef.current = event.pointerId;
      dragInitialPriceRef.current = roundForInput(initialPrice);
      dragChangedRef.current = false;
      setDragPrice(initialPrice);
      setDrag(target);
      setHover(null);
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    }
  }

  function finishPointerDrag(event: React.PointerEvent<SVGSVGElement>, commit: boolean) {
    const target = dragTargetRef.current;
    const ownerPointerId = dragPointerIdRef.current;
    if (!target || ownerPointerId == null || event.pointerId !== ownerPointerId) return;
    const committedPrice = dragPriceRef.current;
    const changed = dragChangedRef.current;
    dragPriceRef.current = null;
    dragTargetRef.current = null;
    dragPointerIdRef.current = null;
    dragInitialPriceRef.current = null;
    dragChangedRef.current = false;
    setDragPrice(null);
    setDrag(null);
    if (event.currentTarget.hasPointerCapture(ownerPointerId)) {
      event.currentTarget.releasePointerCapture(ownerPointerId);
    }
    if (commit && interactionAllowed && changed && committedPrice != null) {
      if (target === "entry") onEntryDrag(committedPrice);
      else onStopDrag(committedPrice);
    }
  }

  function handlePointerUp(event: React.PointerEvent<SVGSVGElement>) {
    finishPointerDrag(event, true);
  }

  function handlePointerCancel(event: React.PointerEvent<SVGSVGElement>) {
    finishPointerDrag(event, false);
  }

  return (
    <div className="relative h-[60dvh] min-h-[280px] max-h-[31rem] overflow-hidden rounded-md border border-[#182234] bg-[#05070b] sm:h-[31rem]">
      <svg
        viewBox={`0 0 ${chart.width} ${chart.height}`}
        className={`h-full w-full touch-pan-y ${!interactionAllowed ? "cursor-not-allowed" : effectiveDrag ? "cursor-grabbing" : hoverNearLine ? "cursor-ns-resize" : "cursor-crosshair"}`}
        role="img"
        aria-label={interactionAllowed ? "Trading chart. Drag the entry and plan invalidation lines to set levels." : "Uncertified chart preview. Entry and plan invalidation dragging is disabled."}
        onPointerMove={handlePointerMove}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onPointerLeave={(event) => {
          setHover(null);
          finishPointerDrag(event, false);
        }}
      >
        <defs>
          <linearGradient id="tradeBand" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#f8e56b" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#f8e56b" stopOpacity="0.04" />
          </linearGradient>
        </defs>
        <rect width={chart.width} height={chart.height} fill="#05070b" />
        {chart.timeTicks.map((tick) => (
          <g key={`t-${tick.x}`}>
            <line x1={tick.x} x2={tick.x} y1={chart.padding.top} y2={chart.height - chart.padding.bottom} stroke="#0e1626" strokeWidth="1" />
            <text x={tick.x} y={chart.height - 12} textAnchor="middle" fill="#8b95a8" fontSize="10" fontFamily={CHART_FONT}>
              {tick.label}
            </text>
          </g>
        ))}
        {chart.grid.map((line) => (
          <g key={line.y}>
            <line x1="0" x2={chart.width} y1={line.y} y2={line.y} stroke="#162033" strokeWidth="1" />
            <text x={chart.width - 10} y={line.y - 5} textAnchor="end" fill="#8b95a8" fontSize="11" fontFamily={CHART_FONT}>
              {formatPrice(line.price)}
            </text>
          </g>
        ))}
        {chart.maxVolume > 0 && candles.map((candle, index) => {
          const volume = Number(candle.v);
          if (!Number.isFinite(volume) || volume <= 0) return null;
          const x = chart.x(index);
          const barHeight = Math.max(1, (volume / chart.maxVolume) * 52);
          const up = Number(candle.c) >= Number(candle.o);
          return (
            <rect
              key={`v-${candle.t}-${index}`}
              x={x - chart.candleWidth / 2}
              y={chart.height - chart.padding.bottom - barHeight}
              width={chart.candleWidth}
              height={barHeight}
              fill={up ? "#34d399" : "#fb7185"}
              opacity={hover?.index === index ? 0.42 : 0.16}
            />
          );
        })}
        {candles.map((candle, index) => {
          const x = chart.x(index);
          const open = chart.y(Number(candle.o));
          const close = chart.y(Number(candle.c));
          const high = chart.y(Number(candle.h));
          const low = chart.y(Number(candle.l));
          const up = Number(candle.c) >= Number(candle.o);
          const dimmed = hover != null && hover.index !== index;
          return (
            <g key={`${candle.t}-${index}`} opacity={dimmed ? 0.62 : 1}>
              <line x1={x} x2={x} y1={high} y2={low} stroke={up ? "#62d6a3" : "#f59aa0"} strokeWidth="1.4" />
              <rect
                x={x - chart.candleWidth / 2}
                y={Math.min(open, close)}
                width={chart.candleWidth}
                height={Math.max(2, Math.abs(close - open))}
                fill={up ? "#58d99a" : "#f08a93"}
                rx="1"
              />
            </g>
          );
        })}
        {overlays.map((overlay) => (
          <OverlaySvg key={overlay.id} overlay={overlay} chart={chart} side={side} />
        ))}
        {labels.map((label) => (
          <Label key={label.id} x={28} y={label.y} color={label.color} text={label.text} />
        ))}
        {stopY != null && (
          <g opacity={stopSuggested ? 0.6 : 1}>
            <line x1="0" x2={chart.width - chart.padding.right + 4} y1={stopY} y2={stopY} stroke="#fb7185" strokeWidth="1.4" strokeDasharray="5 5" />
            <DragGrip y={stopY} chart={chart} color="#fb7185" />
            <Label x={28} y={stopY + 16} color="#fb7185" text={interactionAllowed ? (stopSuggested ? "plan invalidation · auto · drag" : "plan invalidation · drag") : "plan invalidation · read only"} />
            {stopPrice != null && <PriceTag y={stopY} chart={chart} color="#fb7185" text={formatPrice(stopPrice)} />}
          </g>
        )}
        {entryY != null && (
          <g>
            <line x1="0" x2={chart.width - chart.padding.right + 4} y1={entryY} y2={entryY} stroke={entryColor} strokeWidth="1.6" />
            <DragGrip y={entryY} chart={chart} color={entryColor} />
            <Label x={28} y={entryY - 10} color={entryColor} text={`${side} entry · ${interactionAllowed ? "drag" : "read only"}`} />
            {entryPrice != null && <PriceTag y={entryY} chart={chart} color={entryColor} text={formatPrice(entryPrice)} />}
          </g>
        )}
        {lastClose != null && (
          <g>
            <line
              x1="0"
              x2={chart.width - chart.padding.right + 4}
              y1={chart.y(lastClose)}
              y2={chart.y(lastClose)}
              stroke={lastColor}
              strokeWidth="1"
              strokeDasharray="2 4"
              opacity="0.85"
            />
            <PriceTag y={chart.y(lastClose)} chart={chart} color={lastColor} text={formatPrice(lastClose)} solid />
          </g>
        )}
        {hover && hovered && (
          <g>
            <line
              x1={chart.x(hover.index)}
              x2={chart.x(hover.index)}
              y1={chart.padding.top}
              y2={chart.height - chart.padding.bottom}
              stroke="#3a4a64"
              strokeWidth="1"
              strokeDasharray="4 4"
            />
            <line x1="0" x2={chart.width - chart.padding.right + 4} y1={hover.y} y2={hover.y} stroke="#3a4a64" strokeWidth="1" strokeDasharray="4 4" />
            <PriceTag y={hover.y} chart={chart} color="#8fa3c4" text={formatPrice(chart.priceAt(hover.y))} />
            <TimeTag x={chart.x(hover.index)} chart={chart} text={formatChartTime(hovered.t)} />
          </g>
        )}
      </svg>
      <div className="pointer-events-none absolute left-4 top-4 flex items-center gap-2 rounded-md border border-[#1e2a3a] bg-[#070a10]/82 px-3 py-2 font-mono text-xs text-[#aab5c8] shadow-[inset_0_1px_0_rgba(220,238,255,0.06)] backdrop-blur-sm">
        <Activity className="h-4 w-4 text-[#5aa7ff]" />
        {frame?.product ?? "Loading"} {frame?.interval ? `/ ${frame.interval}` : ""}
      </div>
      {hovered && (
        <div className="pointer-events-none absolute right-3 top-3 flex items-center gap-3 rounded-md border border-[#1e2a3a] bg-[#070a10]/88 px-3 py-2 font-mono text-[11px] tabular-nums text-[#aab5c8] shadow-[inset_0_1px_0_rgba(220,238,255,0.06)] backdrop-blur-sm">
          <OhlcStat label="O" value={formatPrice(Number(hovered.o))} />
          <OhlcStat label="H" value={formatPrice(Number(hovered.h))} />
          <OhlcStat label="L" value={formatPrice(Number(hovered.l))} />
          <OhlcStat
            label="C"
            value={formatPrice(Number(hovered.c))}
            color={Number(hovered.c) >= Number(hovered.o) ? "#62d6a3" : "#f59aa0"}
          />
          {Number(hovered.v) > 0 && <OhlcStat label="V" value={formatCompact(hovered.v)} />}
        </div>
      )}
      <span aria-hidden className="trade-corners pointer-events-none absolute inset-0" />
    </div>
  );
}, (left, right) => terminalPlanChartRenderInputsEqual(
  {
    candles: left.frame?.candles,
    product: left.frame?.product,
    interval: left.frame?.interval,
    overlays: left.overlays,
    side: left.side,
    entryPrice: left.entryPrice,
    invalidationPrice: left.stopPrice,
    invalidationSuggested: left.stopSuggested,
    interactionAllowed: left.interactionAllowed,
    onEntryDrag: left.onEntryDrag,
    onInvalidationDrag: left.onStopDrag,
  },
  {
    candles: right.frame?.candles,
    product: right.frame?.product,
    interval: right.frame?.interval,
    overlays: right.overlays,
    side: right.side,
    entryPrice: right.entryPrice,
    invalidationPrice: right.stopPrice,
    invalidationSuggested: right.stopSuggested,
    interactionAllowed: right.interactionAllowed,
    onEntryDrag: right.onEntryDrag,
    onInvalidationDrag: right.onStopDrag,
  },
));

function DragGrip({ y, chart, color }: { y: number; chart: ReturnType<typeof chartLayout>; color: string }) {
  const x = chart.width - chart.padding.right - 34;
  return (
    <g>
      <rect x={x} y={y - 7} width="26" height="14" fill="#070a10" stroke={color} strokeOpacity="0.7" rx="3" />
      <line x1={x + 6} x2={x + 20} y1={y - 2.5} y2={y - 2.5} stroke={color} strokeWidth="1.2" />
      <line x1={x + 6} x2={x + 20} y1={y + 2.5} y2={y + 2.5} stroke={color} strokeWidth="1.2" />
    </g>
  );
}

function OhlcStat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="text-[#566278]">{label}</span>
      <span style={color ? { color } : undefined} className={color ? undefined : "text-[#eef1f8]"}>{value}</span>
    </span>
  );
}

function PriceTag({
  y,
  chart,
  color,
  text,
  solid,
}: {
  y: number;
  chart: ReturnType<typeof chartLayout>;
  color: string;
  text: string;
  solid?: boolean;
}) {
  const x = chart.width - chart.padding.right + 4;
  const tagWidth = chart.padding.right - 6;
  return (
    <g>
      <rect x={x} y={y - 10} width={tagWidth} height="20" fill={solid ? color : "#0b1322"} stroke={color} strokeWidth="1" rx="2" />
      <text
        x={x + tagWidth / 2}
        y={y + 4}
        textAnchor="middle"
        fill={solid ? "#05070b" : color}
        fontSize="11"
        fontWeight={solid ? 700 : 400}
        fontFamily={CHART_FONT}
      >
        {text}
      </text>
    </g>
  );
}

function TimeTag({ x, chart, text }: { x: number; chart: ReturnType<typeof chartLayout>; text: string }) {
  const width = 52;
  const left = Math.min(chart.width - chart.padding.right - width, Math.max(2, x - width / 2));
  return (
    <g>
      <rect x={left} y={chart.height - chart.padding.bottom + 4} width={width} height="18" fill="#0b1322" stroke="#3a4a64" strokeWidth="1" rx="2" />
      <text x={left + width / 2} y={chart.height - chart.padding.bottom + 17} textAnchor="middle" fill="#8fa3c4" fontSize="10" fontFamily={CHART_FONT}>
        {text}
      </text>
    </g>
  );
}

function OverlaySvg({
  overlay,
  chart,
  side,
}: {
  overlay: GholaChartOverlay;
  chart: ReturnType<typeof chartLayout>;
  side: Side;
}) {
  const color = overlayColor(overlay, side);
  if (overlay.kind === "price_band" && overlay.price && overlay.priceEnd) {
    const y1 = chart.y(overlay.price);
    const y2 = chart.y(overlay.priceEnd);
    return (
      <g>
        <rect x="0" y={Math.min(y1, y2)} width={chart.width} height={Math.abs(y2 - y1)} fill="url(#tradeBand)" />
        <line x1="0" x2={chart.width} y1={y1} y2={y1} stroke={color} strokeDasharray="8 8" strokeWidth="1" />
        <line x1="0" x2={chart.width} y1={y2} y2={y2} stroke={color} strokeDasharray="8 8" strokeWidth="1" />
      </g>
    );
  }
  if (!overlay.price) return null;
  const y = chart.y(overlay.price);
  return (
    <line
      x1="0"
      x2={chart.width}
      y1={y}
      y2={y}
      stroke={color}
      strokeWidth="1.2"
      strokeDasharray={overlay.id === "agent-entry" ? undefined : "7 7"}
    />
  );
}

function overlayColor(overlay: GholaChartOverlay, side: Side) {
  if (overlay.id === "agent-entry") return side === "buy" ? "#34d399" : "#fb7185";
  return overlay.tone === "warn" ? "#f8e56b" : overlay.tone === "good" ? "#62d6a3" : "#9ccfff";
}

function overlayLabelSlots(
  overlays: GholaChartOverlay[],
  chart: ReturnType<typeof chartLayout>,
  side: Side,
) {
  const entries = overlays
    .filter((overlay) => overlay.price != null)
    .map((overlay) => {
      const anchorPrice =
        overlay.kind === "price_band" && overlay.priceEnd
          ? Math.max(Number(overlay.price), Number(overlay.priceEnd))
          : Number(overlay.price);
      return {
        id: overlay.id,
        text: overlay.id === "agent-entry" ? `${side} entry` : overlay.label,
        color: overlayColor(overlay, side),
        y: chart.y(anchorPrice) + (overlay.kind === "price_band" ? 16 : -8),
      };
    })
    .sort((a, b) => a.y - b.y);
  let previous = chart.padding.top - 10;
  for (const entry of entries) {
    entry.y = Math.max(entry.y, previous + 24);
    previous = entry.y;
  }
  return entries;
}

function Label({ x, y, color, text }: { x: number; y: number; color: string; text: string }) {
  return (
    <g>
      <rect x={x - 8} y={y - 14} width={Math.max(80, text.length * 6.8 + 16)} height="20" fill="#070a10" fillOpacity="0.92" stroke={color} rx="2" />
      <text x={x} y={y} fill={color} fontSize="11" fontFamily={CHART_FONT}>
        {text}
      </text>
    </g>
  );
}

function ChartRPlanReadout({
  replay,
  modeledLossUsd,
  riskBudgetUsd,
  utilizationPct,
  safeNotionalUsd,
  fillPct,
  impactBps,
  allowed,
}: {
  replay: boolean;
  modeledLossUsd: number | null;
  riskBudgetUsd: number | null;
  utilizationPct: number | null;
  safeNotionalUsd: number | null;
  fillPct: number | null;
  impactBps: number | null;
  allowed: boolean;
}) {
  if (replay) return null;
  const loss = modeledLossUsd == null ? "—" : `$${modeledLossUsd.toFixed(2)}`;
  const budget = riskBudgetUsd == null ? "—" : `$${riskBudgetUsd.toFixed(2)}`;
  const utilization = utilizationPct == null ? "—" : `${utilizationPct.toFixed(0)}%`;
  const safeSize = safeNotionalUsd == null ? "—" : `$${formatCompactNumber(safeNotionalUsd)}`;
  const book = fillPct == null
    ? "—"
    : `${fillPct.toFixed(0)}% · ${impactBps == null ? "—" : `${impactBps.toFixed(2)} bp`}`;
  return (
    <div
      role="group"
      aria-label={`Executable R plan. Modeled loss ${loss} of ${budget}, ${utilization} utilization. Modeled notional cap ${safeSize}. Visible public book fill and impact ${book}. Plan invalidation is not an attached stop.`}
      title="Local model from the visible public book; execution is not guaranteed. Plan invalidation is not an attached stop."
      className="term-chip flex h-7 shrink-0 items-center gap-2 px-2 font-mono text-[9px] uppercase tracking-[0.06em] tabular-nums"
    >
      <span className="text-[#d6a94e]">R plan</span>
      <span className={allowed ? "text-emerald-300" : "text-rose-300"}>loss {loss}/{budget} · {utilization}</span>
      <span className="text-[#9ba8bb]">cap {safeSize}</span>
      <span className="text-[#6f819b]">book {book}</span>
    </div>
  );
}

const MarketIntelligenceStrip = memo(function MarketIntelligenceStrip({
  signals,
}: {
  signals: TerminalCertifiedMarketSignals;
}) {
  const metrics = signals.intelligence;
  const state = signals.surfaces.intelligence;
  const range = metrics.sessionLow != null && metrics.sessionHigh != null
    ? `${formatPrice(metrics.sessionLow)}–${formatPrice(metrics.sessionHigh)}`
    : "-";
  return (
    <div className="border-t border-[#182234]">
      <p
        role="status"
        className={`border-b border-[#141d2e] px-3 py-1.5 text-[8px] uppercase tracking-[0.1em] ${certifiedSurfaceTone(state.status)}`}
      >
        Decision signals {state.status} · {state.message}
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6">
        <TerminalMetric label="Range" value={range} />
        <TerminalMetric label="ATR 14" value={formatPrice(metrics.atr)} sub={metrics.atrBps != null ? `${metrics.atrBps.toFixed(1)} bp` : undefined} />
        <TerminalMetric label="Realized vol" value={metrics.realizedVolatilityBps != null ? `${metrics.realizedVolatilityBps.toFixed(1)} bp` : "-"} />
        <TerminalMetric label="Book imbalance" value={formatSignedPercent(metrics.bookImbalancePct)} tone={signedTone(metrics.bookImbalancePct)} />
        <TerminalMetric label="Microprice" value={formatPrice(metrics.microprice)} sub={metrics.micropriceEdgeBps != null ? `${formatSignedNumber(metrics.micropriceEdgeBps, 1)} bp edge` : undefined} />
        <TerminalMetric label="Tape VWAP" value={formatPrice(metrics.tradeVwap)} sub={metrics.buyFlowPct != null ? `${metrics.buyFlowPct.toFixed(0)}% buy flow` : undefined} />
      </div>
    </div>
  );
}, (previous, next) => terminalCertifiedIntelligenceViewEqual(previous.signals, next.signals));

function certifiedSurfaceTone(status: "ready" | "degraded" | "paused") {
  if (status === "ready") return "bg-emerald-300/[0.02] text-emerald-300";
  if (status === "degraded") return "bg-amber-300/[0.03] text-amber-200";
  return "bg-rose-300/[0.03] text-rose-200";
}

function TerminalMetric({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "good" | "bad" | "neutral";
}) {
  return (
    <div className="min-w-0 border-b border-r border-[#141d2e] px-3 py-2.5 last:border-r-0 sm:border-b-0">
      <p className="truncate text-[9px] uppercase tracking-[0.14em] text-[#566278]">{label}</p>
      <p className={`mt-1 truncate font-mono text-xs tabular-nums ${tone === "good" ? "text-emerald-300" : tone === "bad" ? "text-rose-300" : "text-[#dce6f4]"}`}>{value}</p>
      {sub ? <p className="mt-0.5 truncate font-mono text-[9px] tabular-nums text-[#566278]">{sub}</p> : null}
    </div>
  );
}

function TradeInput({
  id,
  ariaKeyShortcuts,
  label,
  value,
  prefix,
  hint,
  readOnly = false,
  invalid = false,
  decimal,
  onChange,
}: {
  id?: string;
  ariaKeyShortcuts?: string;
  label: string;
  value: string;
  prefix?: string;
  hint?: string;
  readOnly?: boolean;
  invalid?: boolean;
  decimal?: Pick<TerminalDecimalInputProps, "allowEmpty" | "bounds" | "onDraftStatusChange" | "onEditStart" | "onValueChange" | "value">;
  onChange?: (value: string) => void;
}) {
  return (
    <label className={`block rounded-md border bg-[#080c13] px-2.5 py-2 ${invalid ? "border-rose-400/50" : "border-[#1e2a3a]"}`}>
      <span className="flex items-center justify-between gap-2 text-[9px] uppercase tracking-[0.12em] text-[#66738c]">
        <span>{label}</span>
        {hint ? <span className={invalid ? "text-rose-300" : "text-[#46536a]"}>{hint}</span> : null}
      </span>
      <span className="mt-1 flex items-center gap-1 font-mono text-sm tabular-nums text-[#eef1f8]">
        {prefix ? <span className="text-[#566278]">{prefix}</span> : null}
        {decimal ? (
          <TerminalDecimalInput
            {...decimal}
            id={id}
            aria-keyshortcuts={ariaKeyShortcuts}
            aria-invalid={invalid || undefined}
            invalidClassName="rounded-sm ring-1 ring-inset ring-rose-400/60"
            className="min-w-0 flex-1 bg-transparent font-mono text-sm tabular-nums text-[#eef1f8] outline-none"
          />
        ) : (
          <input
            id={id}
            type="text"
            inputMode={readOnly ? undefined : "decimal"}
            value={value}
            readOnly={readOnly}
            aria-invalid={invalid || undefined}
            aria-keyshortcuts={ariaKeyShortcuts}
            onChange={onChange ? (event) => onChange(event.target.value) : undefined}
            className="min-w-0 flex-1 bg-transparent font-mono text-sm tabular-nums text-[#eef1f8] outline-none read-only:text-[#8b95a8]"
          />
        )}
      </span>
    </label>
  );
}

const PositionPreview = memo(function PositionPreview({
  side,
  product,
  notional,
  baseSize,
  entry,
  mark,
  maxLoss,
  targetPrice,
  targetRewardMultiple,
  status,
}: {
  side: Side;
  product: string;
  notional: number;
  baseSize: number | null;
  entry: number | null;
  mark: number | null;
  maxLoss: number | null;
  targetPrice: number | null;
  targetRewardMultiple: TerminalRewardMultiple;
  status: TerminalPositionPreviewStatus;
}) {
  const markMove = entry && mark ? ((mark - entry) / entry) * 100 * (side === "buy" ? 1 : -1) : null;
  const statusCopy = terminalPositionPreviewStatusCopy(status);
  return (
    <section aria-labelledby="position-preview-heading" className="mb-4 rounded-md border border-[#182234] bg-[#080c13] p-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id="position-preview-heading" className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#7d8ba5]">Position / P&amp;L preview</h2>
        <span className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] ${statusCopy.tone === "danger" ? "bg-rose-300/10 text-rose-200" : statusCopy.tone === "pending" ? "bg-amber-300/10 text-amber-200" : "bg-[#111a28] text-[#6f7d9a]"}`}>
          {statusCopy.label}
        </span>
      </div>
      <div className="mt-2 flex items-baseline justify-between gap-3">
        <p className="min-w-0 truncate text-sm font-semibold text-[#eef1f8]">
          <span className={side === "buy" ? "text-emerald-300" : "text-rose-300"}>{side === "buy" ? "LONG" : "SHORT"}</span> {product}
        </p>
        <p className="font-mono text-xs tabular-nums text-[#aab5c8]">${notional} · {baseSize != null ? formatBaseSize(baseSize) : "-"}</p>
      </div>
      <div className="mt-3 grid grid-cols-4 gap-2">
        <MiniMetric label="Entry" value={formatPrice(entry)} />
        <MiniMetric label="Plan vs mark" value={formatSignedPercent(markMove)} tone={markMove != null && markMove >= 0 ? "good" : markMove == null ? "neutral" : "bad"} />
        <MiniMetric label="Modeled loss" value={maxLoss != null ? `$${maxLoss.toFixed(2)}` : "-"} tone="bad" />
        <MiniMetric label={`${targetRewardMultiple.toFixed(1)}R`} value={formatPrice(targetPrice)} />
      </div>
      <p role={status === "unknown" ? "alert" : undefined} className={`mt-2 text-[9px] leading-4 ${status === "unknown" ? "text-rose-200" : "text-[#566278]"}`}>{statusCopy.detail}</p>
    </section>
  );
});

const RiskSizer = memo(function RiskSizer({
  budgetUsd,
  sizing,
  sizeRecommendation,
  onBudgetChange,
  onApply,
  onDraftStatusChange,
}: {
  budgetUsd: number;
  sizing: TerminalPositionSizing;
  sizeRecommendation: TerminalEntrySizeRecommendation | null;
  onBudgetChange: (value: number) => void;
  onApply: (value: number) => void;
  onDraftStatusChange: TerminalDecimalInputProps["onDraftStatusChange"];
}) {
  const suggested = sizeRecommendation?.notionalUsd ?? null;
  const modeledCap = suggested == null ? null : floorTerminalNotionalUsd(suggested);
  const applicable = sizing.status === "ready"
    && sizeRecommendation?.canApply === true
    && modeledCap != null
    && modeledCap >= MIN_TRADE_NOTIONAL_USD;
  const applicableNotional = applicable ? modeledCap : null;
  const status = sizing.status === "ready"
    ? sizing.capped
      ? `Venue cap · projected loss $${sizing.projectedLossUsd?.toFixed(2)}`
      : `Projected loss $${sizing.projectedLossUsd?.toFixed(2)}`
    : sizing.status === "invalid_stop"
      ? "Set a valid plan invalidation"
      : sizing.status === "invalid_entry"
        ? "Waiting for an entry"
        : sizing.status === "invalid_cost_assumption"
          ? "Set explicit selected-venue fee and execution-buffer assumptions"
          : "Enter a positive loss budget";
  return (
    <section aria-labelledby="risk-sizer-heading" className="mb-4 rounded-md border border-[#182234] bg-[#080c13] p-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id="risk-sizer-heading" className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#7d8ba5]">Modeled-risk sizing</h2>
        <span className="font-mono text-[9px] text-[#566278]">all-in round trip</span>
      </div>
      <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <label className="trade-field flex h-9 min-w-0 items-center rounded-md px-2.5">
          <span className="mr-1 text-xs text-[#66738c]">$</span>
          <span className="sr-only">Maximum planned loss</span>
          <TerminalDecimalInput
            id={TERMINAL_TICKET_FIELD_IDS.risk_budget}
            value={budgetUsd}
            bounds={RISK_BUDGET_DRAFT_BOUNDS}
            aria-label="Maximum planned loss"
            aria-keyshortcuts="G"
            onValueChange={(value) => {
              if (value != null) onBudgetChange(value);
            }}
            onDraftStatusChange={onDraftStatusChange}
            invalidClassName="rounded-sm ring-1 ring-inset ring-rose-400/60"
            className="min-w-0 flex-1 bg-transparent font-mono text-xs tabular-nums text-[#eef1f8] outline-none"
          />
          <span className="text-[9px] uppercase tracking-[0.1em] text-[#566278]">loss budget</span>
        </label>
        <button
          type="button"
          disabled={applicableNotional == null}
          onClick={() => applicableNotional != null && onApply(applicableNotional)}
          title="Modeled caps can only reduce the current notional"
          className="trade-chip h-9 rounded-md px-3 text-[10px] font-semibold disabled:cursor-not-allowed disabled:opacity-35"
        >
          {applicableNotional == null ? "Modeled cap" : "Reduce to"} {modeledCap == null ? "—" : `$${formatTerminalDecimalValue(modeledCap, 2)}`}
        </button>
      </div>
      <p className="mt-1.5 text-[9px] leading-4 text-[#566278]">
        {status}{sizing.totalRiskBps != null ? ` · ${sizing.totalRiskBps.toFixed(0)} bp modeled risk` : ""}{sizeRecommendation ? ` · ${sizeRecommendation.constraint === "visible_liquidity" ? "displayed-depth cap" : "risk cap"} · apply never upsizes` : " · awaiting certified sizing"}
      </p>
    </section>
  );
});

const ScenarioAnalysisPanel = memo(function ScenarioAnalysisPanel({
  analysis,
  replay,
  sourceFresh,
}: {
  analysis: ReturnType<typeof analyzeTerminalScenario>;
  replay: boolean;
  sourceFresh: boolean;
}) {
  const gradeTone = analysis.stressGrade === "contained"
    ? "text-emerald-300"
    : analysis.stressGrade === "tight"
      ? "text-amber-200"
      : analysis.stressGrade === "exposed"
        ? "text-rose-300"
        : "text-[#6f7d9a]";
  const breach = analysis.historicalStopBreached == null
    ? "—"
    : analysis.historicalStopBreached
      ? "crossed"
      : "inside";
  return (
    <section aria-labelledby="scenario-analysis-heading" className="mb-4 rounded-md border border-[#182234] bg-[#080c13] p-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id="scenario-analysis-heading" className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#7d8ba5]">Historical range stress</h2>
        <span className={`font-mono text-[9px] font-semibold uppercase tracking-[0.12em] ${gradeTone}`}>
          {analysis.stressGrade}
        </span>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <MiniMetric label="Invalidation / ATR" value={analysis.stopAtrMultiple == null ? "—" : `${analysis.stopAtrMultiple.toFixed(2)}×`} />
        <MiniMetric label="Reward / risk" value={analysis.rewardRiskRatio == null ? "—" : `${analysis.rewardRiskRatio.toFixed(2)}R`} />
        <MiniMetric label="Range vs invalidation" value={breach} tone={breach === "crossed" ? "bad" : breach === "inside" ? "good" : "neutral"} />
        <MiniMetric label="Realized vol" value={analysis.realizedVolatilityBps == null ? "—" : `${analysis.realizedVolatilityBps.toFixed(0)} bp`} />
        <MiniMetric label="Range stress" value={analysis.stressLossUsd == null ? "—" : `-$${analysis.stressLossUsd.toFixed(2)}`} tone="bad" />
        <MiniMetric label="Target after slip" value={analysis.targetProfitUsd == null ? "—" : `+$${analysis.targetProfitUsd.toFixed(2)}`} tone="good" />
      </div>
      <p className="mt-2 text-[9px] leading-4 text-[#8290a8]">
        {!sourceFresh
          ? "Unavailable: public history is stale or synthetic."
          : `${replay ? "Revealed replay prefix" : "Latest fresh history"} · ${analysis.sampleSize} valid bars · range relative to the proposed entry, not a path-conditioned fill.`}
        {sourceFresh ? " No probability claim; gaps and venue failure remain outside this candle model." : ""}
      </p>
    </section>
  );
});

function MiniMetric({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "good" | "bad" | "neutral" }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-[8px] uppercase tracking-[0.12em] text-[#8491a8]">{label}</p>
      <p className={`mt-0.5 truncate font-mono text-[10px] tabular-nums ${tone === "good" ? "text-emerald-300" : tone === "bad" ? "text-rose-300" : "text-[#c7d2e4]"}`}>{value}</p>
    </div>
  );
}

function RiskMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-[#182234] bg-[#080c13] px-2.5 py-2">
      <p className="text-[8px] uppercase tracking-[0.12em] text-[#566278]">{label}</p>
      <p className="mt-1 truncate font-mono text-xs tabular-nums text-[#c7d2e4]">{value}</p>
    </div>
  );
}

function MarketDepthUnavailable({ compact = false }: { compact?: boolean }) {
  return (
    <p className={`${compact ? "px-4 py-3" : "px-4 py-5"} text-center text-[10px] leading-4 text-amber-200`}>
      Market depth unavailable · waiting for a fresh, uncrossed public book.
    </p>
  );
}

const BookSummary = memo(function BookSummary({
  signals,
}: {
  signals: TerminalCertifiedMarketSignals;
}) {
  const frame = signals.bookFrame;
  const metrics = signals.intelligence;
  const bids = (frame?.bids ?? []).slice(0, 5);
  const asks = (frame?.asks ?? []).slice(0, 5);
  const bidTotal = bids.reduce((sum, level) => sum + (Number(level.sz) || 0), 0);
  const askTotal = asks.reduce((sum, level) => sum + (Number(level.sz) || 0), 0);
  const total = bidTotal + askTotal;
  const bidShare = total > 0 ? (bidTotal / total) * 100 : 50;
  return (
    <div className="px-4 py-3">
      <div className="flex items-baseline justify-between font-mono text-xs tabular-nums">
        <span className="text-emerald-300">{frame?.bestBid ? formatPrice(Number(frame.bestBid)) : "-"}</span>
        <span className="text-sm text-[#eef1f8]">{formatPrice(frameMidNumber(frame))}</span>
        <span className="text-rose-300">{frame?.bestAsk ? formatPrice(Number(frame.bestAsk)) : "-"}</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-rose-400/25">
        <div
          className="h-full rounded-full bg-emerald-400/60 transition-[width] duration-500"
          style={{ width: `${bidShare}%` }}
        />
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[10px] uppercase tracking-[0.14em] text-[#566278]">
        <span>bids {Math.round(bidShare)}%</span>
        <span>asks {Math.round(100 - bidShare)}%</span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 border-t border-[#141d2e] pt-2 font-mono text-[10px] tabular-nums">
        <span className="text-[#6f7d9a]">Micro <b className="font-normal text-[#c7d2e4]">{formatPrice(metrics.microprice)}</b></span>
        <span className="text-right text-[#6f7d9a]">Imbal <b className={`font-normal ${metricSignedTone(metrics.bookImbalancePct)}`}>{formatSignedPercent(metrics.bookImbalancePct)}</b></span>
      </div>
    </div>
  );
}, (previous, next) => terminalCertifiedBookViewEqual(previous.signals, next.signals));

const BookTable = memo(function BookTable({
  signals,
  onSelectPrice,
  stagingDisabled,
}: {
  signals: TerminalCertifiedMarketSignals;
  onSelectPrice: (price: number) => void;
  stagingDisabled: boolean;
}) {
  const frame = signals.bookFrame;
  const metrics = signals.intelligence;
  const asks = cumulativeBookRows((frame?.asks ?? []).slice(0, 8)).reverse();
  const bids = cumulativeBookRows((frame?.bids ?? []).slice(0, 8));
  const maxSize = Math.max(
    1e-9,
    ...[...asks, ...bids].map((level) => Number(level.size)).filter(Number.isFinite),
  );
  return (
    <div className="px-3 py-3 font-mono text-xs">
      <div className="grid grid-cols-3 px-1 pb-2 text-[9px] uppercase tracking-[0.14em] text-[#566278]">
        <span>Price</span>
        <span className="text-right">Size</span>
        <span className="text-right">Cum.</span>
      </div>
      {asks.map((level, index) => (
        <BookRow key={`ask-${index}`} price={level.price} size={level.size} cumulative={level.cumulative} tone="ask" maxSize={maxSize} onSelectPrice={onSelectPrice} disabled={stagingDisabled} />
      ))}
      <div className="my-2 flex items-center justify-between rounded border border-[#1e2a3a] bg-[#111a28] px-2 py-1 shadow-[inset_0_1px_0_rgba(220,238,255,0.06)]">
        <span className="text-[9px] uppercase tracking-[0.12em] text-[#566278]">spread {frame?.spreadBps?.toFixed(2) ?? "-"} bp</span>
        <span className="text-sm tabular-nums text-[#eef1f8]">{formatPrice(frameMidNumber(frame))}</span>
      </div>
      {bids.map((level, index) => (
        <BookRow key={`bid-${index}`} price={level.price} size={level.size} cumulative={level.cumulative} tone="bid" maxSize={maxSize} onSelectPrice={onSelectPrice} disabled={stagingDisabled} />
      ))}
      <div className="mt-2 grid grid-cols-2 gap-2 border-t border-[#141d2e] pt-2 text-[9px] text-[#566278]">
        <span>Bid depth <b className="font-normal text-emerald-300">{metrics.bidDepthUsd == null ? "-" : `$${formatCompactNumber(metrics.bidDepthUsd)}`}</b></span>
        <span className="text-right">Ask depth <b className="font-normal text-rose-300">{metrics.askDepthUsd == null ? "-" : `$${formatCompactNumber(metrics.askDepthUsd)}`}</b></span>
      </div>
    </div>
  );
}, (previous, next) => previous.onSelectPrice === next.onSelectPrice
  && previous.stagingDisabled === next.stagingDisabled
  && terminalCertifiedBookViewEqual(previous.signals, next.signals));

function BookRow({
  price,
  size,
  cumulative,
  tone,
  maxSize,
  onSelectPrice,
  disabled,
}: {
  price: string;
  size: string;
  cumulative: number;
  tone: "bid" | "ask";
  maxSize: number;
  onSelectPrice: (price: number) => void;
  disabled: boolean;
}) {
  const width = Math.min(100, Math.max(4, (Number(size) / maxSize) * 100));
  const color = tone === "bid" ? "#34d399" : "#fb7185";
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onSelectPrice(Number(price))}
      aria-label={disabled
        ? `${tone} level ${formatPrice(Number(price))}; staging locked during live execution`
        : `Set entry to ${formatPrice(Number(price))}, ${tone} level size ${size}`}
      className="relative grid w-full grid-cols-3 overflow-hidden rounded-sm px-1 py-1 text-left transition-colors duration-100 hover:bg-[#0f1a2c] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[#5aa7ff] disabled:cursor-not-allowed disabled:opacity-55"
    >
      <span
        aria-hidden
        className="absolute inset-y-0 right-0 opacity-15"
        style={{ width: `${width}%`, background: `linear-gradient(270deg, ${color}, transparent)` }}
      />
      <span className={`relative tabular-nums ${tone === "bid" ? "text-emerald-300" : "text-rose-300"}`}>{formatPrice(Number(price))}</span>
      <span className="relative text-right tabular-nums text-[#8b95a8]">{Number(size).toFixed(4)}</span>
      <span className="relative text-right tabular-nums text-[#566278]">{cumulative.toFixed(3)}</span>
    </button>
  );
}

const PublicAgentLaunchPanel = memo(function PublicAgentLaunchPanel({
  startup,
  failed,
  selectedVenueId,
  wakeState,
  wakeMessage,
  authenticated,
  onSignIn,
  onWake,
  onSelectVenue,
}: {
  startup: PublicAgentStartupStatus | null;
  failed: boolean;
  selectedVenueId: VenueId;
  wakeState: WorkerWakeState;
  wakeMessage: string | null;
  authenticated: boolean;
  onSignIn: () => void;
  onWake: () => void;
  onSelectVenue: (venueId: PublicAgentStartupVenue["id"]) => void;
}) {
  const venues = startup?.venues ?? [];
  const readyVenue = venues.find((venue) => venue.can_start_live);
  const preparableVenue = venues.find((venue) => venue.can_prepare);
  const connectableVenue = venues.find((venue) => venue.live_gate === "green");
  const visibleVenues = venues.length
    ? venues.filter((venue) => venue.live_gate === "green")
    : fallbackStartupVenues();
  const canWake = authenticated && Boolean(preparableVenue) && startup?.runtime.ready !== true;
  const runtimeTone = startup?.runtime.status === "ready"
    ? "good"
    : startup?.runtime.status === "warming" || wakeState === "waking"
      ? "warn"
      : "neutral";
  const actionLabel = !startup
    ? "Checking live agents"
    : !authenticated
      ? "Sign in to connect API keys"
      : canWake
        ? wakeState === "waking" ? "Starting secure worker" : "Start secure worker"
        : readyVenue
          ? `Use ${readyVenue.label} agent`
          : connectableVenue
            ? `Connect ${connectableVenue.label}`
            : startup.primary_action.label;
  const actionMessage = wakeMessage || startup?.primary_action.message || "Sign in, connect scoped venue access, then arm a capped agent.";
  const actionDisabled = !startup || wakeState === "waking" || (authenticated && !canWake && !readyVenue && !connectableVenue);

  function handlePrimaryAction() {
    if (!authenticated) {
      onSignIn();
      return;
    }
    if (canWake) {
      onWake();
      return;
    }
    if (readyVenue) {
      onSelectVenue(readyVenue.id);
      return;
    }
    if (connectableVenue) onSelectVenue(connectableVenue.id);
  }

  return (
    <div className="border-b border-[#182234] bg-[#070a10] px-4 py-4 sm:px-6">
      <div className="trade-panel relative overflow-hidden rounded-md p-4">
        <span aria-hidden className="trade-corners pointer-events-none absolute inset-0" />
        <div className="relative grid gap-4 xl:grid-cols-[minmax(18rem,0.78fr)_minmax(26rem,1.22fr)]">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[#8ec7ff]">
              <ShieldCheck className="h-3.5 w-3.5" />
              Scoped API-key agent path
            </div>
            <h2 className="mt-2 font-display text-2xl font-semibold tracking-tight text-[#f6f8ff]">
              Bring API keys to trade
            </h2>
            <p className="mt-2 max-w-xl text-sm leading-6 text-[#8b95a8]">
              Connect a trade-only Hyperliquid API wallet, then approve bounded agent execution. Withdrawal permission is never required.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className={`inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs font-medium ${launchToneClass(runtimeTone)}`}>
                <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${launchDotClass(runtimeTone)}`} />
                {wakeState === "waking" ? "Secure worker starting" : startup?.runtime.label ?? (failed ? "Status unavailable" : "Checking worker")}
              </span>
              <span className={`inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs font-medium ${
                startup?.live_trading.byo_live_trading_enabled ? launchToneClass("good") : launchToneClass("warn")
              }`}>
                <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${
                  startup?.live_trading.byo_live_trading_enabled ? launchDotClass("good") : launchDotClass("warn")
                }`} />
                BYO live {startup?.live_trading.byo_live_trading_enabled ? "enabled" : "locked"}
              </span>
            </div>
          </div>

          <div className="min-w-0">
            <div className="flex gap-2 overflow-x-auto pb-1 sm:grid sm:grid-cols-2 sm:overflow-visible sm:pb-0">
              {visibleVenues.map((venue) => {
                const chartBacked = venue.id === "hyperliquid" || venue.id === "phoenix" || venue.id === "coinbase";
                const selected = chartBacked && venue.id === selectedVenueId;
                return (
                  <button
                    key={venue.id}
                    type="button"
                    disabled={!chartBacked}
                    onClick={() => onSelectVenue(venue.id)}
                    className={`min-h-[8.5rem] w-[13rem] shrink-0 rounded-md border p-3 text-left transition sm:w-auto ${
                      selected
                        ? "border-[#5aa7ff]/80 bg-[#10213a] shadow-[inset_0_1px_0_rgba(220,238,255,0.1),0_0_18px_-8px_rgba(90,167,255,0.8)]"
                        : "border-[#1e2a3a] bg-[#070b12] hover:border-[#33435d]"
                    } ${chartBacked ? "" : "cursor-default opacity-80"}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-semibold text-[#eef1f8]">{venue.label}</span>
                      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.14em] ${launchStatusClass(venue.status_tone)}`}>
                        {venue.can_start_live ? "live" : venue.live_gate === "green" ? "open" : "locked"}
                      </span>
                    </div>
                    <p className="mt-2 min-h-[2rem] text-xs leading-4 text-[#8b95a8]">{venue.headline}</p>
                    <div className="mt-3 flex items-center justify-between gap-2 border-t border-[#141d2e] pt-2">
                      <span className="min-w-0 truncate text-[11px] text-[#6f7d9a]">{agentAccessCopy(venue)}</span>
                      {chartBacked ? (
                        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-[#566278]" />
                      ) : (
                        <Wallet className="h-3.5 w-3.5 shrink-0 text-[#566278]" />
                      )}
                    </div>
                    <p className={`mt-2 text-[11px] leading-4 ${launchTextToneClass(venue.status_tone)}`}>
                      {venue.status_label}
                    </p>
                  </button>
                );
              })}
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
              <p className={`text-xs leading-5 ${wakeState === "error" || failed ? "text-rose-300" : "text-[#8b95a8]"}`}>
                {failed && !startup ? "Live agent status is unavailable right now." : actionMessage}
              </p>
              <button
                type="button"
                onClick={handlePrimaryAction}
                disabled={actionDisabled}
                className="trade-action inline-flex h-10 items-center justify-center gap-2 rounded-md px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60"
              >
                {wakeState === "waking" ? (
                  <RefreshCcw className="h-4 w-4 animate-spin" />
                ) : !authenticated ? (
                  <KeyRound className="h-4 w-4" />
                ) : (
                  <ShieldCheck className="h-4 w-4" />
                )}
                {actionLabel}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

function fallbackStartupVenues(): PublicAgentStartupVenue[] {
  return [
    fallbackStartupVenue("hyperliquid", "Hyperliquid", "Scoped API wallet"),
  ];
}

function fallbackStartupVenue(
  id: PublicAgentStartupVenue["id"],
  label: string,
  headline: string,
): PublicAgentStartupVenue {
  return {
    id,
    label,
    headline,
    live_gate: "blocked",
    user_access: "sign_in_required",
    status_label: "Checking access",
    status_tone: "neutral",
    next_action: "Checking",
    can_prepare: false,
    can_start_live: false,
    passport_permission_commitment: null,
    vault_commitment: null,
  };
}

function agentAccessCopy(venue: PublicAgentStartupVenue) {
  if (venue.can_start_live) return "Agent ready";
  if (venue.user_access === "ready") return "Access sealed";
  if (venue.user_access === "wallet_required") return "Wallet needed";
  if (venue.user_access === "connect_required") return "Connect scoped access";
  if (venue.live_gate !== "green") return "Live gate locked";
  return venue.next_action;
}

function launchToneClass(tone: "good" | "warn" | "neutral") {
  if (tone === "good") return "border-emerald-400/35 bg-emerald-400/10 text-emerald-200";
  if (tone === "warn") return "border-[#f8e56b]/35 bg-[#f8e56b]/10 text-[#fff27a]";
  return "border-[#26344a] bg-[#0a0f18] text-[#8b95a8]";
}

function launchStatusClass(tone: PublicAgentStartupVenue["status_tone"]) {
  if (tone === "good") return "bg-emerald-400/12 text-emerald-200";
  if (tone === "warn") return "bg-[#f8e56b]/12 text-[#fff27a]";
  if (tone === "primary") return "bg-[#5aa7ff]/12 text-[#a8d8ff]";
  return "bg-[#1b2535] text-[#8b95a8]";
}

function launchTextToneClass(tone: PublicAgentStartupVenue["status_tone"]) {
  if (tone === "good") return "text-emerald-300";
  if (tone === "warn") return "text-[#fff27a]";
  if (tone === "primary") return "text-[#a8d8ff]";
  return "text-[#6f7d9a]";
}

function launchDotClass(tone: "good" | "warn" | "neutral") {
  if (tone === "good") return "bg-emerald-300 shadow-[0_0_8px_rgba(110,231,183,0.8)]";
  if (tone === "warn") return "bg-[#fff27a] shadow-[0_0_8px_rgba(248,229,107,0.8)]";
  return "bg-[#566278]";
}

function ButtonGrid<T extends string>({
  items,
  selected,
  onSelect,
}: {
  items: Array<{ id: T; label: string }>;
  selected: T;
  onSelect: (id: T) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-pressed={selected === item.id}
          onClick={() => onSelect(item.id)}
          className={`inline-flex min-h-10 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium ${
            selected === item.id ? "trade-chip-on" : "trade-chip"
          }`}
        >
          {selected === item.id && <Check aria-hidden className="h-3.5 w-3.5 shrink-0 text-[#9ccfff]" />}
          {item.label}
        </button>
      ))}
    </div>
  );
}

const TOKEN_TITLES: Record<string, string> = {
  size: "Side & size",
  market: "Market",
  idea: "Trade idea",
  trigger: "Entry trigger",
  entry: "Entry price",
  stop: "Plan invalidation",
  slippage: "Slippage cap",
  horizon: "Horizon",
  stoprule: "Exit rule",
};

// An editable term inside the mandate sentence, styled as an inline chip:
// soft fill, border, and a caret so it unmistakably reads as a control.
// The dot marks values the agent inferred from the chart.
function Token({
  active,
  auto,
  tone,
  mono,
  onClick,
  children,
}: {
  active: boolean;
  auto?: boolean;
  tone?: "good" | "bad" | "warn";
  mono?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const color =
    tone === "good"
      ? "border-emerald-300/30 bg-emerald-300/8 text-emerald-200 hover:border-emerald-300/60 hover:bg-emerald-300/15"
      : tone === "bad"
        ? "border-rose-300/30 bg-rose-300/8 text-rose-200 hover:border-rose-300/60 hover:bg-rose-300/15"
        : tone === "warn"
          ? "border-[#f8e56b]/30 bg-[#f8e56b]/8 text-[#fff27a] hover:border-[#f8e56b]/60 hover:bg-[#f8e56b]/15"
          : "border-[#5aa7ff]/30 bg-[#5aa7ff]/8 text-[#cfe2ff] hover:border-[#5aa7ff]/60 hover:bg-[#5aa7ff]/15";
  return (
    <button
      type="button"
      aria-expanded={active}
      onClick={onClick}
      className={`inline-flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 transition-colors duration-100 ${color} ${
        mono ? "font-mono tabular-nums" : ""
      } ${active ? "shadow-[0_0_0_1px_rgba(90,167,255,0.35),0_0_14px_-4px_rgba(90,167,255,0.5)]" : ""}`}
    >
      {auto && (
        <span
          aria-hidden
          title="Read by the agent from your chart"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-300 shadow-[0_0_6px_rgba(110,231,183,0.7)]"
        />
      )}
      {children}
      <ChevronDown
        aria-hidden
        className={`h-3 w-3 shrink-0 opacity-50 transition-transform ${active ? "rotate-180" : ""}`}
      />
    </button>
  );
}

function VisibilityRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "good" | "warn";
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-[#7b88a1]">{label}</span>
      <span
        className={`flex items-center gap-1.5 font-mono ${
          tone === "good" ? "text-emerald-200" : "text-amber-200"
        }`}
      >
        <span
          aria-hidden
          className={`h-1.5 w-1.5 rounded-full ${
            tone === "good"
              ? "bg-emerald-300 shadow-[0_0_6px_rgba(110,231,183,0.7)]"
              : "bg-amber-300 shadow-[0_0_6px_rgba(252,211,77,0.7)]"
          }`}
        />
        {value}
      </span>
    </div>
  );
}

function EditorResetButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="font-mono text-[10px] uppercase tracking-[0.14em] text-emerald-300/80 transition hover:text-emerald-200"
    >
      ↺ agent read
    </button>
  );
}

function formatFeedTelemetryMs(value: number | null) {
  if (value == null || !Number.isFinite(value)) return "-";
  if (value < 1_000) return `${Math.round(value)} ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 2 : 1)} s`;
}

const ReadinessBadge = memo(function ReadinessBadge({ label, ready }: { label: string; ready: boolean }) {
  return (
    <div className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${
      ready
        ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
        : "border-amber-400/30 bg-amber-400/10 text-amber-100"
    }`}>
      {ready ? <CheckCircle2 className="h-3.5 w-3.5" /> : <LockKeyhole className="h-3.5 w-3.5" />}
      {label}
    </div>
  );
});

function chartLayout(candles: GholaChartCandle[], overlays: GholaChartOverlay[]) {
  const width = 980;
  const height = 520;
  const padding = { top: 28, right: 74, bottom: 34, left: 18 };
  const candlePrices = candles.flatMap((candle) => [Number(candle.h), Number(candle.l), Number(candle.o), Number(candle.c)]);
  const overlayPrices = overlays.flatMap((overlay) => [overlay.price, overlay.priceEnd].map((value) => Number(value)).filter(Number.isFinite));
  const prices = [...candlePrices, ...overlayPrices].filter((price) => Number.isFinite(price) && price > 0);
  const fallbackMid = 100;
  const rangePrices = prices.length > 0 ? prices : [fallbackMid];
  const minRaw = Math.min(...rangePrices);
  const maxRaw = Math.max(...rangePrices);
  const pad = Math.max((maxRaw - minRaw) * 0.16, maxRaw * 0.002);
  const min = minRaw - pad;
  const max = maxRaw + pad;
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const candleWidth = Math.max(3, Math.min(9, plotWidth / Math.max(1, candles.length) * 0.58));
  const y = (price: number) => padding.top + ((max - price) / Math.max(1e-9, max - min)) * plotHeight;
  const x = (index: number) => padding.left + (index / Math.max(1, candles.length - 1)) * plotWidth;
  const priceAt = (yPos: number) => max - ((yPos - padding.top) / Math.max(1e-9, plotHeight)) * (max - min);
  const grid = Array.from({ length: 6 }, (_, index) => {
    const price = min + ((max - min) * index) / 5;
    return { price, y: y(price) };
  });
  const tickCount = Math.min(6, Math.max(2, candles.length));
  const timeTicks = candles.length > 1
    ? Array.from(new Set(Array.from({ length: tickCount }, (_, index) =>
        Math.round((index * (candles.length - 1)) / (tickCount - 1))))).map((index) => ({
        x: x(index),
        label: formatChartTime(candles[index].t),
      }))
    : [];
  const maxVolume = Math.max(0, ...candles.map((candle) => Number(candle.v)).filter(Number.isFinite));
  return { width, height, padding, plotWidth, plotHeight, y, x, priceAt, candleWidth, grid, timeTicks, maxVolume };
}

function formatChartTime(timestamp: number) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

function selectedStrategy<T extends { id: string }>(items: T[], id: string): T {
  return items.find((item) => item.id === id) ?? items[0];
}

// Reads trade intent off the chart geometry: where the entry sits relative
// to the live price and the recent range decides what kind of trade this is.
function interpretGeometry(input: {
  entry: number;
  mid: number;
  side: Side;
  candles: GholaChartCandle[];
}): { strategy: StrategyProfile; trigger: EntryTrigger } | null {
  const { entry, mid, side, candles } = input;
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(mid) || mid <= 0) return null;
  const recent = candles.slice(-60);
  const highs = recent.map((candle) => Number(candle.h)).filter(Number.isFinite);
  const lows = recent.map((candle) => Number(candle.l)).filter(Number.isFinite);
  const rangeHigh = highs.length > 0 ? Math.max(...highs) : mid;
  const rangeLow = lows.length > 0 ? Math.min(...lows) : mid;
  const span = Math.max(rangeHigh - rangeLow, mid * 0.001);
  const tolerance = mid * 0.0012;
  if (Math.abs(entry - mid) <= tolerance) {
    return { strategy: "trend_following", trigger: "preview_now" };
  }
  if (side === "buy") {
    if (entry > mid) return { strategy: "breakout", trigger: "break_level" };
    if (entry <= rangeLow + span * 0.05) return { strategy: "reversal", trigger: "sweep_reclaim" };
    if (entry <= rangeLow + span * 0.4) return { strategy: "range_trade", trigger: "retest_level" };
    return { strategy: "mean_reversion", trigger: "retest_level" };
  }
  if (entry < mid) return { strategy: "breakout", trigger: "break_level" };
  if (entry >= rangeHigh - span * 0.05) return { strategy: "reversal", trigger: "sweep_reclaim" };
  if (entry >= rangeHigh - span * 0.4) return { strategy: "range_trade", trigger: "retest_level" };
  return { strategy: "mean_reversion", trigger: "retest_level" };
}

function shouldWakePooledWorker(status: PrivateAccountLiveTradingStatus) {
  if (status.pooled_live_trading_enabled) return false;
  const reasonCodes = [
    ...(status.pooled_unavailable_reason_codes ?? []),
    ...(status.pooled_worker_readiness?.reason_codes ?? []),
  ];
  return reasonCodes.some((reason) => reason === "pooled_worker_probe_failed" || reason.endsWith(":pooled_worker_probe_failed"));
}

function formatPrice(value: number | string | null | undefined) {
  const number = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(number) || !number) return "-";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: number >= 1_000 ? 1 : 2,
    maximumFractionDigits: number >= 1_000 ? 1 : 4,
  }).format(number);
}

function formatLimitGuard(limitOffsetBps: number | null, maxSlippageBps: number) {
  if (limitOffsetBps == null || !Number.isFinite(limitOffsetBps)) return "-";
  return limitOffsetBps > 0
    ? `${limitOffsetBps.toFixed(1)} / ${maxSlippageBps} bp`
    : `${Math.abs(limitOffsetBps).toFixed(1)} bp resting`;
}

function livePlanSlippageBlocker(limitOffsetBps: number | null, maxSlippageBps: number) {
  return limitOffsetBps == null
    ? "Live execution blocked: a side-specific executable BBO is required for the slippage cap."
    : `Live execution blocked: the limit reaches ${limitOffsetBps.toFixed(1)} bp beyond the executable BBO, over the ${maxSlippageBps} bp cap.`;
}

function roundForInput(value: number) {
  return value >= 1_000 ? Number(value.toFixed(1)) : Number(value.toFixed(2));
}

function formatCompact(value: string | number | null | undefined) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(number);
}

function isLocalPreviewRuntime() {
  if (typeof window === "undefined") return true;
  const { hostname, protocol } = window.location;
  return protocol !== "https:" || (hostname !== "ghola.xyz" && hostname !== "www.ghola.xyz");
}

function chartIntervalMs(interval: ChartInterval) {
  if (interval === "1m") return 60_000;
  if (interval === "5m") return 300_000;
  if (interval === "15m") return 900_000;
  return 3_600_000;
}

function liveExecutionJournalBlockerLabel(
  state: ReturnType<typeof terminalLiveExecutionJournalSafetyState>,
) {
  if (state === "loading") return "Restoring the local execution safety ledger before live submit.";
  if (state === "blocked") return "Live submit blocked: the local execution safety ledger is unavailable or invalid; stored history was preserved.";
  if (state === "unresolved") return "Live submit blocked: a prior submission remains unacknowledged or unreconciled. Inspect the venue account before unlocking it.";
  return "";
}

function terminalLiveExecutionExternalReviewBlockerLabel(
  blocker: ReturnType<typeof terminalLiveExecutionExternalReviewDecision>["blocker"],
) {
  if (blocker === "account_context_mismatch") return "Select the unresolved order’s exact venue and network before reviewing it.";
  if (blocker === "account_stream_not_current") return "Await a verified current Hyperliquid account stream before external review.";
  if (blocker === "account_snapshot_predates_submit") return "Await a fresh Hyperliquid account snapshot observed after the submit attempt.";
  return "External review remains unavailable.";
}

function marketFreshnessLimitMs(interval: ChartInterval) {
  return Math.min(120_000, Math.max(30_000, chartIntervalMs(interval) / 10));
}

function formatSignedPercent(value: number | null | undefined) {
  return value == null || !Number.isFinite(value) ? "-" : `${formatSignedNumber(value, 2)}%`;
}

function formatSignedNumber(value: number, digits: number) {
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function signedTone(value: number | null | undefined): "good" | "bad" | "neutral" {
  return value == null || value === 0 ? "neutral" : value > 0 ? "good" : "bad";
}

function metricSignedTone(value: number | null | undefined) {
  return value == null || value === 0 ? "text-[#c7d2e4]" : value > 0 ? "text-emerald-300" : "text-rose-300";
}

function formatBaseSize(value: number) {
  if (!Number.isFinite(value)) return "-";
  return value >= 1 ? value.toFixed(4) : value.toFixed(6);
}

function terminalStringArrayEqual(left: readonly string[], right: readonly string[]) {
  return left === right || (left.length === right.length && left.every((value, index) => value === right[index]));
}

function terminalSavedPlanInventoryEqual(
  left: readonly TerminalSavedPlanInventoryItem[] | null,
  right: readonly TerminalSavedPlanInventoryItem[] | null,
) {
  return left === right || (left != null && right != null
    && left.length === right.length
    && left.every((value, index) => value.planId === right[index]?.planId && value.instrument === right[index]?.instrument));
}

function formatCompactNumber(value: number) {
  if (!Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

function cumulativeBookRows(levels: Array<{ px: string; sz: string }>) {
  let cumulative = 0;
  return levels.map((level) => {
    const size = Number(level.sz) || 0;
    cumulative += size;
    return { price: level.px, size: level.sz, cumulative };
  });
}

function fallbackFrame(venue: typeof VENUES[number], market: string, interval: ChartInterval): GholaMarketFrame {
  const now = Date.now();
  const base = FALLBACK_BASE_PRICE[market] ?? 100;
  const candleMs = chartIntervalMs(interval);
  const candles = Array.from({ length: 90 }, (_, index) => {
    const t = now - (90 - index) * candleMs;
    const wave = Math.sin(index / 6) * base * 0.006 + Math.cos(index / 13) * base * 0.004;
    const close = base + wave - index * base * 0.00008;
    const open = close + Math.sin(index) * base * 0.0015;
    const high = Math.max(open, close) + base * 0.002;
    const low = Math.min(open, close) - base * 0.002;
    return {
      t,
      T: t + candleMs - 1,
      o: open.toFixed(2),
      h: high.toFixed(2),
      l: low.toFixed(2),
      c: close.toFixed(2),
      v: String(20 + index),
      n: 4,
    };
  });
  const mid = Number(candles.at(-1)?.c ?? base);
  return {
    version: 1,
    venue: venue.chartVenue,
    product: venueProductLabel(venue.id, market),
    interval,
    fetchedAt: new Date(now).toISOString(),
    stale: true,
    mid: String(mid),
    bestBid: String(mid * 0.9999),
    bestAsk: String(mid * 1.0001),
    spreadBps: 2,
    markPrice: String(mid),
    oraclePrice: String(mid),
    fundingRate: "0.00001",
    openInterest: null,
    dayVolume: "1000000000",
    candles,
    bids: Array.from({ length: 12 }, (_, index) => ({
      px: (mid * (1 - (index + 1) * 0.0002)).toFixed(2),
      sz: (0.2 + index * 0.04).toFixed(4),
      n: 2,
    })),
    asks: Array.from({ length: 12 }, (_, index) => ({
      px: (mid * (1 + (index + 1) * 0.0002)).toFixed(2),
      sz: (0.18 + index * 0.04).toFixed(4),
      n: 2,
    })),
    trades: Array.from({ length: 12 }, (_, index) => ({
      side: index % 2 === 0 ? "buy" : "sell",
      px: (mid * (1 + Math.sin(index) * 0.0004)).toFixed(2),
      sz: (0.01 + index * 0.002).toFixed(4),
      time: now - index * 12_000,
    })),
    routeQuotes: [],
  };
}
