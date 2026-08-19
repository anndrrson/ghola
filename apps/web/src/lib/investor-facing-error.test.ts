import { describe, expect, it } from "vitest";
import { investorFacingErrorMessage } from "./investor-facing-error";

describe("investorFacingErrorMessage", () => {
  it.each([
    ["verified_email_required", "Verify the invited email account, then recheck access."],
    ["private_agent_subscription_required", "Investor access is not active. Reopen the original invitation link or review your plan."],
    ["access_pass_email_mismatch", "This investor pass belongs to a different email. Sign out and use the exact invited account."],
  ])("maps %s to safe investor guidance", (code, expected) => {
    expect(investorFacingErrorMessage(new Error(code), "Fallback")).toBe(expected);
  });

  it("does not expose an unknown internal error code", () => {
    expect(investorFacingErrorMessage(new Error("unexpected_internal_code"), "Try again later."))
      .toBe("Try again later.");
  });
});
