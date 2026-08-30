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
