import { describe, expect, it } from "vitest";
import {
  validatePrivateExecutionOrderDraft,
  type PrivateExecutionOrderDraft,
} from "./private-execution-instruction-seal";
import {
  deriveLiveReadinessDisplay,
  deriveMarketFeedFreshness,
  deriveOrderTicketDisplayState,
  deriveTradingNextAction,
  deriveVenueReadinessSteps,
  phoenixOrderbookClickSide,
  type TradingUiStateInput,
} from "./private-account-trading-ui";

const base: TradingUiStateInput = {
  authenticated: true,
  actionClass: "trade_on_platform",
  platformClass: "solana_perps_market",
  hasPreview: false,
  canApprovePrivate: false,
  canApproveDegraded: false,
  waiting: false,
  blocked: false,
  phoenix: { connected: false, armed: false, accessLabel: "not connected" },
  jupiter: { connected: false, armed: false, accessLabel: "not connected" },
  hyperliquid: { connected: false, armed: false, accessLabel: "not connected" },
  coinbase: { connected: false, armed: false, accessLabel: "not connected" },
};

const validOrder: PrivateExecutionOrderDraft = {
  venue_id: "hyperliquid",
  operation_class: "limit_order",
  market: "BTC",
  side: "buy",
  base_size: "0.001",
  limit_price: "65000",
  order_type: "limit",
  size_mode: "base",
  tif: "Gtc",
};

describe("private account trading UI derivation", () => {
  it("uses clearer signed-out and venue-access calls to action", () => {
    expect(deriveTradingNextAction({ ...base, authenticated: false }).label).toBe("Sign in to trade");
    expect(deriveTradingNextAction(base).label).toBe("Connect Phoenix authority");
    expect(deriveTradingNextAction(base).secondary).toMatchObject({
      label: "Ghola pool unavailable",
      disabled: true,
    });
    const hyperliquidAccess = deriveTradingNextAction({
      ...base,
      platformClass: "hyperliquid_style_market",
      hyperliquid: { connected: false, armed: false, accessLabel: "not connected" },
    });
    expect(hyperliquidAccess.label).toBe("Connect API wallet");
    expect(hyperliquidAccess.secondary).toMatchObject({
      label: "Ghola pool unavailable",
      disabled: true,
    });
    expect(deriveTradingNextAction({
      ...base,
      platformClass: "hyperliquid_style_market",
      hyperliquid: { connected: false, armed: false, pooledAvailable: true },
    }).secondary).toMatchObject({
      label: "Use Ghola pool",
      disabled: false,
    });
  });

  it("guides Phoenix from access to live verification and preview", () => {
    expect(deriveTradingNextAction(base).kind).toBe("connect_phoenix_byo");
    expect(deriveTradingNextAction({
      ...base,
      phoenix: { connected: true, armed: false, accessLabel: "Ghola Vault Mode" },
    }).kind).toBe("arm_phoenix");
    expect(deriveTradingNextAction({
      ...base,
      phoenix: { connected: true, armed: true, verified: false, accessLabel: "Ghola Vault Mode" },
    }).kind).toBe("verify_phoenix");
    expect(deriveTradingNextAction({
      ...base,
      phoenix: { connected: true, armed: true, verified: false, accessLabel: "Ghola Vault Mode" },
    }).label).toBe("Check connection");
    expect(deriveTradingNextAction({
      ...base,
      phoenix: { connected: true, armed: true, verified: true, accessLabel: "Ghola Vault Mode" },
    }).kind).toBe("preview");
    expect(deriveTradingNextAction({
      ...base,
      phoenix: { connected: true, armed: true, verified: true, accessLabel: "Ghola Vault Mode" },
    }).label).toBe("Preview intent");
  });

  it("does not consider Phoenix approval ready without no-submit verification", () => {
    expect(deriveTradingNextAction({
      ...base,
      hasPreview: true,
      canApprovePrivate: true,
      phoenix: { connected: true, armed: true, verified: false, accessLabel: "Ghola Vault Mode" },
    }).kind).toBe("verify_phoenix");
  });

  it("places or accepts a Phoenix trade after verification and preview", () => {
    expect(deriveTradingNextAction({
      ...base,
      hasPreview: true,
      canApprovePrivate: true,
      phoenix: { connected: true, armed: true, verified: true, accessLabel: "Ghola Vault Mode" },
    }).label).toBe("Place capped trade");
    expect(deriveTradingNextAction({
      ...base,
      hasPreview: true,
      canApproveDegraded: true,
      phoenix: { connected: true, armed: true, verified: true, accessLabel: "Ghola Vault Mode" },
    }).kind).toBe("accept_visibility");
  });

  it("routes waiting and blocked privacy states to the right action", () => {
    expect(deriveTradingNextAction({
      ...base,
      hasPreview: true,
      waiting: true,
      phoenix: { connected: true, armed: true, verified: true, accessLabel: "Ghola Vault Mode" },
    }).kind).toBe("wait_for_privacy");
    expect(deriveTradingNextAction({
      ...base,
      hasPreview: true,
      blocked: true,
      phoenix: { connected: true, armed: true, verified: true, accessLabel: "Ghola Vault Mode" },
    }).kind).toBe("blocked");
  });

  it("requires Hyperliquid live connection verification before approval", () => {
    expect(deriveTradingNextAction({
      ...base,
      platformClass: "hyperliquid_style_market",
      liveHyperliquidFlow: true,
      hasPreview: true,
      canApprovePrivate: true,
      hyperliquid: { connected: true, armed: true, verified: false, accountReady: true, accessLabel: "Ghola Vault Mode" },
    }).kind).toBe("verify_hyperliquid");
    expect(deriveTradingNextAction({
      ...base,
      platformClass: "hyperliquid_style_market",
      liveHyperliquidFlow: true,
      hasPreview: true,
      canApprovePrivate: true,
      hyperliquid: { connected: true, armed: true, verified: false, accountReady: true, workerUnavailable: true, accessLabel: "Ghola Vault Mode" },
    }).description).toContain("Worker unavailable");
    expect(deriveTradingNextAction({
      ...base,
      platformClass: "hyperliquid_style_market",
      liveHyperliquidFlow: true,
      hasPreview: true,
      canApprovePrivate: true,
      hyperliquid: { connected: true, armed: true, verified: false, accountReady: false, needsFunds: true, accessLabel: "Ghola Vault Mode" },
    }).description).toContain("Needs funds");
    expect(deriveTradingNextAction({
      ...base,
      platformClass: "hyperliquid_style_market",
      liveHyperliquidFlow: true,
      hasPreview: true,
      canApprovePrivate: true,
      hyperliquid: { connected: true, armed: true, verified: true, accountReady: true, accessLabel: "Ghola Vault Mode" },
    }).kind).toBe("place_trade");
  });

  it("guides Jupiter through swap authority, live verification, and preview", () => {
    expect(deriveTradingNextAction({
      ...base,
      platformClass: "solana_swap_aggregator",
    }).kind).toBe("connect_jupiter_byo");
    expect(deriveTradingNextAction({
      ...base,
      platformClass: "solana_swap_aggregator",
      jupiter: { connected: true, armed: false, accessLabel: "Ghola Vault Mode" },
    }).kind).toBe("arm_jupiter");
    expect(deriveTradingNextAction({
      ...base,
      platformClass: "solana_swap_aggregator",
      jupiter: { connected: true, armed: true, verified: false, accessLabel: "Ghola Vault Mode" },
    }).kind).toBe("verify_jupiter");
    expect(deriveTradingNextAction({
      ...base,
      platformClass: "solana_swap_aggregator",
      jupiter: { connected: true, armed: true, verified: true, accessLabel: "Ghola Vault Mode" },
    }).kind).toBe("preview");
  });

  it("guides Coinbase through scoped API key connection and agent arming", () => {
    expect(deriveTradingNextAction({
      ...base,
      platformClass: "coinbase_style_provider",
    }).kind).toBe("connect_coinbase_byo");
    expect(deriveTradingNextAction({
      ...base,
      platformClass: "coinbase_style_provider",
      coinbase: { connected: true, armed: false, accessLabel: "partner omnibus" },
    }).kind).toBe("arm_coinbase");
    expect(deriveTradingNextAction({
      ...base,
      platformClass: "coinbase_style_provider",
      coinbase: { connected: true, armed: true, verified: false, accessLabel: "partner omnibus" },
    }).kind).toBe("verify_coinbase");
    expect(deriveTradingNextAction({
      ...base,
      platformClass: "coinbase_style_provider",
      coinbase: { connected: true, armed: true, verified: true, accessLabel: "partner omnibus" },
    }).kind).toBe("preview");
  });

  it("derives shared all-live readiness status and receipts", () => {
    expect(deriveLiveReadinessDisplay({
      venue: "hyperliquid",
      authenticated: false,
      connected: false,
      armed: false,
    })).toMatchObject({
      status: "signed_out",
      statusLabel: "Sign in required",
      nextActionLabel: "Sign in to connect account",
      broadcastPerformed: false,
    });
    expect(deriveLiveReadinessDisplay({
      venue: "phoenix",
      authenticated: true,
      connected: false,
      armed: false,
    })).toMatchObject({
      status: "connect_account",
      blockerCode: "venue_access_required",
      blockerLabel: "Connect Phoenix access before preview.",
    });
    expect(deriveLiveReadinessDisplay({
      venue: "jupiter",
      authenticated: true,
      connected: true,
      armed: true,
      workerUnavailable: true,
    })).toMatchObject({
      status: "worker_unavailable",
      statusLabel: "Worker unavailable",
      blockerCode: "worker_unavailable",
    });
    expect(deriveLiveReadinessDisplay({
      venue: "coinbase",
      authenticated: true,
      connected: true,
      armed: true,
      needsFunds: true,
    })).toMatchObject({
      status: "needs_funds",
      nextActionLabel: "Check connection",
    });
    expect(deriveLiveReadinessDisplay({
      venue: "hyperliquid",
      authenticated: true,
      marketStatus: "stale",
      connected: true,
      armed: true,
      verified: true,
    })).toMatchObject({
      status: "market_stale",
      blockerCode: "market_stale",
    });
    expect(deriveLiveReadinessDisplay({
      venue: "jupiter",
      authenticated: true,
      connected: true,
      armed: true,
      verified: true,
      hasPreview: false,
      certificateCommitment: "live_readiness_certificate_test",
    })).toMatchObject({
      status: "ready_to_preview",
      statusLabel: "Ready to preview",
      proofCommitments: { certificateCommitment: "live_readiness_certificate_test" },
    });
    expect(deriveLiveReadinessDisplay({
      venue: "coinbase",
      authenticated: true,
      connected: true,
      armed: true,
      verified: true,
      hasPreview: true,
      liveSubmitEnabled: false,
    })).toMatchObject({
      status: "live_submit_locked",
      nextActionLabel: "Live submit locked",
    });
    expect(deriveLiveReadinessDisplay({
      venue: "phoenix",
      authenticated: true,
      connected: true,
      armed: true,
      verified: true,
      hasPreview: true,
      canSubmit: true,
    })).toMatchObject({
      status: "ready_to_place_capped_trade",
      receiptSummary: "Phoenix readiness passed. No broadcast happened during the check.",
    });
  });

  it("derives readiness step status from venue and preview state", () => {
    const steps = deriveVenueReadinessSteps({
      ...base,
      hasPreview: true,
      canApprovePrivate: true,
      phoenix: { connected: true, armed: true, verified: true, accessLabel: "Ghola Vault Mode" },
    });
    expect(steps.map((step) => [step.id, step.status])).toEqual([
      ["venue", "done"],
      ["access", "done"],
      ["guardrails", "done"],
      ["privacy", "done"],
      ["submit", "current"],
    ]);
    expect(steps.find((step) => step.id === "privacy")?.value).toBe("Checked");
  });

  it("uses conventional Phoenix book click sides", () => {
    expect(phoenixOrderbookClickSide("ask")).toBe("buy");
    expect(phoenixOrderbookClickSide("bid")).toBe("sell");
  });

  it("derives human market feed freshness labels", () => {
    const nowMs = Date.parse("2026-05-30T12:00:10.000Z");
    expect(deriveMarketFeedFreshness({
      status: "live",
      fetchedAt: "2026-05-30T12:00:08.000Z",
      stale: false,
      nowMs,
    })).toEqual({ label: "Live · updated 2s ago", tone: "good" });
    expect(deriveMarketFeedFreshness({
      status: "fallback_polling",
      fetchedAt: "2026-05-30T12:00:02.000Z",
      nowMs,
    })).toEqual({ label: "Polling · last good 8s ago", tone: "warn" });
    expect(deriveMarketFeedFreshness({
      status: "reconnecting",
      fetchedAt: "2026-05-30T11:59:00.000Z",
      nowMs,
    })).toEqual({ label: "Reconnecting · last good 1m ago", tone: "warn" });
    expect(deriveMarketFeedFreshness({
      status: "stale",
      fetchedAt: "2026-05-30T10:00:00.000Z",
      nowMs,
    })).toEqual({ label: "Stale · last good 2h ago", tone: "warn" });
    expect(deriveMarketFeedFreshness({ status: null, fetchedAt: null, nowMs }))
      .toEqual({ label: "Waiting for data", tone: "neutral" });
  });

  it("maps order validation errors to inline ticket fields", () => {
    const missingUsd = validatePrivateExecutionOrderDraft({
      ...validOrder,
      base_size: "",
      quote_size: "",
      size_mode: "quote",
    });
    expect(deriveOrderTicketDisplayState({ errors: missingUsd }).fieldHints.size)
      .toContain("Enter a USD amount greater than 0.");

    const missingBase = validatePrivateExecutionOrderDraft({
      ...validOrder,
      base_size: "",
      size_mode: "base",
    });
    expect(deriveOrderTicketDisplayState({ errors: missingBase }).fieldHints.size)
      .toContain("Enter a base size greater than 0.");

    const missingLimit = validatePrivateExecutionOrderDraft({
      ...validOrder,
      limit_price: "",
    });
    expect(deriveOrderTicketDisplayState({ errors: missingLimit }).fieldHints.price)
      .toContain("Enter a limit price greater than 0.");

    const missingPhoenixLimit = validatePrivateExecutionOrderDraft({
      ...validOrder,
      venue_id: "phoenix",
      operation_class: "perp_limit_order",
      order_type: "market",
      size_mode: "quote",
      quote_size: "5",
      limit_price: "",
    });
    expect(deriveOrderTicketDisplayState({ errors: missingPhoenixLimit }).fieldHints.price)
      .toContain("Enter a Phoenix market price limit greater than 0.");

    const invalidSlippage = validatePrivateExecutionOrderDraft({
      ...validOrder,
      live_order_mode: "tiny_fill",
      quote_size: "5",
      max_slippage_bps: "101",
    });
    expect(deriveOrderTicketDisplayState({ errors: invalidSlippage }).fieldHints.slippage)
      .toContain("Set slippage between 1 and 100 bps.");
  });

  it("maps live cap and ticket status labels", () => {
    const capErrors = validatePrivateExecutionOrderDraft({
      ...validOrder,
      live_order_mode: "tiny_fill",
      quote_size: "26",
      max_slippage_bps: "50",
    });
    const blocked = deriveOrderTicketDisplayState({ errors: capErrors });
    expect(blocked.statusLabel).toBe("Needs fields");
    expect(blocked.primaryBlockerText).toBe("Fix order fields before preview");
    expect(blocked.fieldHints.size).toContain("Live orders are capped at $25.");
    expect(deriveOrderTicketDisplayState({ errors: [] }).statusLabel).toBe("Ready");
    expect(deriveOrderTicketDisplayState({ errors: [], hasPreview: true }).statusLabel).toBe("Checked");
  });
});
