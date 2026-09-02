import { describe, expect, it } from "vitest";
import {
  CONNECTOR_SDK_VENUES,
  venueAdapterCapability,
} from "@ghola/execution-core";
import { listConnectorSdkSpecs } from "./connector-sdk";

describe("connector SDK venue registry", () => {
  it("derives every registered connector default without union drift", () => {
    const specs = listConnectorSdkSpecs();
    for (const venueId of CONNECTOR_SDK_VENUES) {
      const platformClass = venueAdapterCapability(venueId, "connector_sdk")?.platform_class;
      expect(typeof platformClass).toBe("string");
      expect(specs.find((spec) => spec.platform_class === platformClass)?.default_venue_id).toBe(venueId);
    }
    const registeredDefaults = specs
      .map((spec) => spec.default_venue_id)
      .filter((venueId) => CONNECTOR_SDK_VENUES.includes(venueId as typeof CONNECTOR_SDK_VENUES[number]));
    expect(registeredDefaults).toEqual(CONNECTOR_SDK_VENUES);
  });
});
