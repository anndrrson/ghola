export const TERMINAL_HYPERLIQUID_ORDER_STATUSES = new Set([
  "filled",
  "canceled",
  "cancelled",
  "rejected",
  "margincanceled",
  "expired",
  "triggered",
  "vaultwithdrawalcanceled",
  "openinterestcapcanceled",
  "selftradecanceled",
  "reduceonlycanceled",
  "siblingfilledcanceled",
  "delistedcanceled",
  "liquidatedcanceled",
  "scheduledcancel",
  "tickrejected",
  "mintradentlrejected",
  "mintradespotntlrejected",
  "perpmarginrejected",
  "reduceonlyrejected",
  "badalopxrejected",
  "ioccancelrejected",
  "badtriggerpxrejected",
  "marketordernoliquidityrejected",
  "positionincreaseatopeninterestcaprejected",
  "positionflipatopeninterestcaprejected",
  "tooaggressiveatopeninterestcaprejected",
  "openinterestincreaserejected",
  "insufficientspotbalancerejected",
  "oraclerejected",
  "perpmaxpositionrejected",
]);

export function normalizeHyperliquidOrderStatus(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/gu, "");
}

export function isTerminalHyperliquidOrderStatus(value) {
  return TERMINAL_HYPERLIQUID_ORDER_STATUSES.has(normalizeHyperliquidOrderStatus(value));
}
