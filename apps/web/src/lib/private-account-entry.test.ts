import { describe, expect, it } from "vitest";
import { privateAccountInitialFlow } from "./private-account-entry";

describe("private account entry routing", () => {
  it("keeps focused Hyperliquid setup on the account page", () => {
    expect(privateAccountInitialFlow({ setup: "hyperliquid" })).toBeNull();
  });

  it("keeps Carry setup on the account page", () => {
    expect(privateAccountInitialFlow({ setup: "carry" })).toBeNull();
  });

  it("preserves explicit terminal flows", () => {
    expect(privateAccountInitialFlow({ flow: "hyperliquid-live" })).toBe("hyperliquid-live");
  });

  it("uses the default trade terminal without a focused setup", () => {
    expect(privateAccountInitialFlow({})).toBe("trade");
  });
});
