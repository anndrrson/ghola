export interface CarryAccountConnections {
  accountCommitment: string | null;
  hyperliquid: boolean;
  aster: boolean;
  lighter: boolean;
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
  return {
    accountCommitment: stringValue(passport.account_commitment),
    hyperliquid:
      hyperliquid.ready === true ||
      hyperliquid.credentials_sealed === true ||
      hyperliquidVault.status === "sealed" ||
      managedAllocation.status === "allocated" ||
      ready("hyperliquid"),
    aster: ready("aster"),
    lighter: ready("lighter"),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
