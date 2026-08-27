import { describe, expect, it } from "vitest";
import { shouldResumeUnsignedTurnkeySetup } from "./carry-setup-auth-recovery";

describe("Carry setup authentication recovery", () => {
  it("reauthenticates an exact prepared action when Turnkey expires before authorization", () => {
    expect(shouldResumeUnsignedTurnkeySetup({
      usingTurnkeyOwner: true,
      authorizationProofCreated: false,
      error: new Error("No active session found"),
    })).toBe(true);
  });

  it("never reauthenticates as a substitute for reconciling an authorization proof", () => {
    expect(shouldResumeUnsignedTurnkeySetup({
      usingTurnkeyOwner: true,
      authorizationProofCreated: true,
      error: new Error("No active session found"),
    })).toBe(false);
  });

  it("does not relabel wallet rejection or an injected-owner failure as session expiry", () => {
    expect(shouldResumeUnsignedTurnkeySetup({
      usingTurnkeyOwner: true,
      authorizationProofCreated: false,
      error: new Error("User rejected the request"),
    })).toBe(false);
    expect(shouldResumeUnsignedTurnkeySetup({
      usingTurnkeyOwner: false,
      authorizationProofCreated: false,
      error: new Error("Requires a valid session"),
    })).toBe(false);
  });
});
