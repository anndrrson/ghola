export interface CarryTerminalChrome {
  eyebrow: "Cross-venue carry" | "Unified trading";
  title: string | null;
  marketContext: "Cross-venue reference" | null;
  showProductNavigation: boolean;
  showVenueReadiness: boolean;
  showVenueMarketStats: boolean;
  showVenueActivity: boolean;
  showVenueOrderTicket: boolean;
  showReferenceChart: true;
}

export function carryTerminalChrome(carryWorkspaceOpen: boolean): CarryTerminalChrome {
  if (!carryWorkspaceOpen) {
    return Object.freeze({
      eyebrow: "Unified trading",
      title: null,
      marketContext: null,
      showProductNavigation: true,
      showVenueReadiness: true,
      showVenueMarketStats: true,
      showVenueActivity: true,
      showVenueOrderTicket: true,
      showReferenceChart: true,
    });
  }
  return Object.freeze({
    eyebrow: "Cross-venue carry",
    title: "Carry Position",
    marketContext: "Cross-venue reference",
    showProductNavigation: false,
    showVenueReadiness: false,
    showVenueMarketStats: false,
    showVenueActivity: false,
    showVenueOrderTicket: false,
    showReferenceChart: true,
  });
}

export function carryMarketStatus(status: string, hasMarketData = false) {
  if (status === "live") return "Live market data · execution locked";
  if (status === "fallback_polling") return "Live market data · fallback · execution locked";
  if (status === "reconnecting") {
    return hasMarketData
      ? "Cached market data · reconnecting · execution locked"
      : "Market data reconnecting · execution locked";
  }
  if (status === "stale") return "Delayed market data · execution locked";
  if (status === "error") return "Market data unavailable · execution locked";
  return hasMarketData
    ? "Cached market data · refreshing · execution locked"
    : "Establishing market data · execution locked";
}
