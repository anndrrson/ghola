import { describe, expect, it } from "vitest";
import { subscriptionNeedsAttention } from "./billing-status";

describe("billing status", () => {
  it("shows recovery guidance for a failed subscription payment", () => {
    expect(subscriptionNeedsAttention("past_due")).toBe(true);
    expect(subscriptionNeedsAttention("unpaid")).toBe(true);
    expect(subscriptionNeedsAttention("incomplete")).toBe(true);
  });

  it("does not show recovery guidance for healthy or absent subscriptions", () => {
    expect(subscriptionNeedsAttention("active")).toBe(false);
    expect(subscriptionNeedsAttention("trialing")).toBe(false);
    expect(subscriptionNeedsAttention(null)).toBe(false);
    expect(subscriptionNeedsAttention(undefined)).toBe(false);
  });
});
