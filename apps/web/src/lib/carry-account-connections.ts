import { CARRY_EXECUTION_VENUES, isCarryExecutionVenue, type CarryExecutionVenue } from "./carry-venues";

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

export interface CarryExecutionPair {
  longVenueId: CarryExecutionVenue;
  shortVenueId: CarryExecutionVenue;
}

export type CarryWorkerPlatformGate = Readonly<{
  status: "ready" | "authorization_mismatch" | "unavailable";
  message: string;
}>;

export function carryWorkerPlatformGate(runtime: unknown): CarryWorkerPlatformGate {
  const status = record(runtime);
  const blockers = Array.isArray(status.blocking_reasons)
    ? status.blocking_reasons.filter((value): value is string => typeof value === "string")
    : [];
  const providers = Array.isArray(status.providers) ? status.providers.map(record) : [];
  const authorizationMismatch = blockers.includes("private_worker_authorization_mismatch") ||
    providers.some((provider) => record(provider.evidence).worker_authorization_verified === false);
  if (authorizationMismatch) {
    return Object.freeze({
      status: "authorization_mismatch",
      message: "This preview and its worker do not share authorization. Venue connections are preserved; do not reconnect wallets.",
    });
  }
  const selectedProviderId = stringValue(status.selected_provider);
  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId);
  if (
    selectedProvider &&
    selectedProvider.available === true &&
    selectedProvider.supports_trading_execution === true &&
    record(selectedProvider.evidence).worker_authorization_verified === true
  ) {
    return Object.freeze({
      status: "ready",
      message: "Worker authorization matches this deployment.",
    });
  }
  return Object.freeze({
    status: "unavailable",
    message: "Ghola could not verify this preview's worker. Venue connections are preserved; route verification stays disabled.",
  });
}

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

export function carryExecutionPairFromReturnTo(returnTo: string): CarryExecutionPair | null {
  if (!returnTo.startsWith("/trade?")) return null;
  try {
    const target = new URL(returnTo, "https://ghola.local");
    if (target.origin !== "https://ghola.local" || target.pathname !== "/trade") return null;
    const longVenueId = target.searchParams.get("long_venue");
    const shortVenueId = target.searchParams.get("short_venue");
    if (!isCarryExecutionVenue(longVenueId) || !isCarryExecutionVenue(shortVenueId) || longVenueId === shortVenueId) {
      return null;
    }
    return Object.freeze({ longVenueId, shortVenueId });
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
