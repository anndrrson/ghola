import {
  CARRY_BROWSER_STREAM_VENUES as EXECUTION_CORE_BROWSER_STREAM_VENUES,
  CARRY_EXECUTION_VENUES as EXECUTION_CORE_CARRY_VENUES,
  CARRY_SHADOW_ASSETS as EXECUTION_CORE_SHADOW_ASSETS,
  CORE_PERP_VENUES as EXECUTION_CORE_PERP_VENUES,
  type CarryExecutionVenueId,
  type CorePerpVenueId,
} from "@ghola/execution-core";

export const CARRY_EXECUTION_VENUES: readonly CarryExecutionVenueId[] = EXECUTION_CORE_CARRY_VENUES;
export const CORE_PERP_VENUES: readonly CorePerpVenueId[] = EXECUTION_CORE_PERP_VENUES;
export const CARRY_BROWSER_STREAM_VENUES: readonly CorePerpVenueId[] = EXECUTION_CORE_BROWSER_STREAM_VENUES;
export const CARRY_SHADOW_ASSETS = EXECUTION_CORE_SHADOW_ASSETS;

export type CarryExecutionVenue = CarryExecutionVenueId;

export function isCarryExecutionVenue(value: unknown): value is CarryExecutionVenue {
  return typeof value === "string" && CARRY_EXECUTION_VENUES.includes(value as CarryExecutionVenue);
}
