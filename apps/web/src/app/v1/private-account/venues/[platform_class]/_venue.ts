import {
  isVenueId,
} from "../../_lib";
import {
  venueIdForPlatformClass,
  type GholaVenueId,
} from "@/lib/private-account";

export function venueIdFromParams(params: unknown): GholaVenueId | null {
  const value =
    params && typeof params === "object" && "platform_class" in params
      ? (params as { platform_class?: unknown }).platform_class
      : null;
  if (typeof value !== "string") return null;
  if (isVenueId(value)) return value;
  return venueIdForPlatformClass(value as never);
}
