import { CARRY_EXECUTION_VENUES, type CarryExecutionVenue } from "./carry-venues";

export interface CarryAccountConnections {
  accountCommitment: string | null;
  venues: Readonly<Record<CarryExecutionVenue, boolean>>;
}

export interface CarryAccountConnectionProgress {
  connectedVenueIds: readonly CarryExecutionVenue[];
  missingVenueIds: readonly CarryExecutionVenue[];
  connectedCount: number;
  requiredCount: number;
  ready: boolean;
}

export type CarryAccountSetupNextAction = Readonly<
  | { kind: "connect_venue"; venueId: CarryExecutionVenue }
  | { kind: "verify_routes"; venueId: null }
>;

export function carryAccountConnections(input: {
  passport: unknown;
  hyperliquidStatus: unknown;
}): CarryAccountConnections {
  const passportResponse = record(input.passport);
  const passport = passportResponse.passport ? record(passportResponse.passport) : passportResponse;
  const venues = Array.isArray(passport.venues) ? passport.venues.map(record) : [];
  const ready = (venueId: string) => venues.some((venue) =>
    venue.venue_id === venueId && venue.status === "ready" && venue.can_read === true && venue.can_trade === true
  );
  const hyperliquid = record(input.hyperliquidStatus);
  const hyperliquidVault = record(hyperliquid.hyperliquid_execution_vault);
  const managedAllocation = record(hyperliquid.managed_allocation);
  const hyperliquidReady =
      hyperliquid.ready === true ||
      hyperliquid.credentials_sealed === true ||
      hyperliquidVault.status === "sealed" ||
      managedAllocation.status === "allocated" ||
      ready("hyperliquid");
  return {
    accountCommitment: stringValue(passport.account_commitment),
    venues: Object.freeze(Object.fromEntries(CARRY_EXECUTION_VENUES.map((venueId) => [
      venueId,
      venueId === "hyperliquid" ? hyperliquidReady : ready(venueId),
    ])) as Record<CarryExecutionVenue, boolean>),
  };
}

export function carryAccountConnectionProgress(connections: CarryAccountConnections): CarryAccountConnectionProgress {
  return carryAccountConnectionProgressForVenues(connections, CARRY_EXECUTION_VENUES);
}

export function carryAccountConnectionProgressForVenues(
  connections: CarryAccountConnections,
  requiredVenueIds: readonly CarryExecutionVenue[],
): CarryAccountConnectionProgress {
  const required = CARRY_EXECUTION_VENUES.filter((venueId) => requiredVenueIds.includes(venueId));
  const normalizedRequired = required.length >= 2 ? required : CARRY_EXECUTION_VENUES;
  const connectedVenueIds = normalizedRequired.filter((venueId) => connections.venues[venueId] === true);
  const missingVenueIds = normalizedRequired.filter((venueId) => connections.venues[venueId] !== true);
  return Object.freeze({
    connectedVenueIds: Object.freeze([...connectedVenueIds]),
    missingVenueIds: Object.freeze([...missingVenueIds]),
    connectedCount: connectedVenueIds.length,
    requiredCount: normalizedRequired.length,
    ready: missingVenueIds.length === 0,
  });
}

export function carryAccountSetupNextAction(
  progress: CarryAccountConnectionProgress,
  blockedVenueIds: readonly CarryExecutionVenue[] = [],
): CarryAccountSetupNextAction {
  if (progress.ready) return Object.freeze({ kind: "verify_routes", venueId: null });
  const blocked = new Set(blockedVenueIds);
  const venueId = progress.missingVenueIds.find((candidate) => !blocked.has(candidate))
    || progress.missingVenueIds[0];
  return Object.freeze({ kind: "connect_venue", venueId });
}

export function carryNoSubmitVerificationHref(returnTo: string): string {
  const fallback = "/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open";
  const target = returnTo === "/carry" ? fallback : returnTo.startsWith("/trade?") ? returnTo : fallback;
  const url = new URL(target, "https://ghola.local");
  url.searchParams.set("carry", "open");
  url.searchParams.set("carry_check", "no-submit");
  return `${url.pathname}?${url.searchParams.toString()}`;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
