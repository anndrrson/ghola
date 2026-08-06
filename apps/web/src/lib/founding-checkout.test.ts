import { describe, expect, it } from "vitest";
import { foundingCheckoutIsOpen } from "./founding-checkout";

describe("founding checkout readiness", () => {
  it("fails closed while cohort status is missing or incomplete", () => {
    expect(foundingCheckoutIsOpen(true, null)).toBe(false);
    expect(foundingCheckoutIsOpen(true, {})).toBe(false);
  });

  it("requires both the rollout flag and an explicitly open backend", () => {
    expect(foundingCheckoutIsOpen(false, { checkout_open: true })).toBe(false);
    expect(foundingCheckoutIsOpen(true, { checkout_open: false })).toBe(false);
    expect(foundingCheckoutIsOpen(true, { checkout_open: true })).toBe(true);
  });
});
