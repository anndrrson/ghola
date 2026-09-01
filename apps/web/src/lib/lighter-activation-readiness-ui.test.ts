import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "src/components/carry/CarryAccountSetup.tsx"),
  "utf8",
);
const turnkeyProviderSource = readFileSync(
  resolve(process.cwd(), "src/lib/perps-turnkey-provider.tsx"),
  "utf8",
);

describe("Lighter activation readiness UI", () => {
  it("separates the verified owner account from both network-fee requirements", () => {
    expect(source).toContain("fetchLighterActivationReadiness");
    expect(source).toContain('label="Owner wallet staging balance"');
    expect(source).toContain("USDC · not deposited");
    expect(source).toContain('label="Base network fee"');
    expect(source).toContain('label="Lighter owner account"');
    expect(source).toContain('label="Ethereum association fee"');
    expect(source).toContain("!lighterReadiness?.ready");
  });

  it("states that the check is read-only", () => {
    expect(source).toContain("No payment, transfer, key, or order is submitted by this check.");
    expect(source).toContain("Account identity · not a deposit address");
    expect(source).toContain("View official Lighter requirements");
    expect(source).toContain('scopedActivationNeeded.venue === "aster" && (');
  });

  it("shows a copy action only after the authenticated UDA contract verifies every field", () => {
    expect(source).toContain("fetchVerifiedLighterDepositDestination");
    expect(source).toContain("validateVerifiedLighterDepositDestination");
    expect(source).toContain("signLighterDepositAuthorization: perpsTurnkey.signLighterDepositAuthorization");
    expect(source).toContain('data-lighter-deposit-verified="false"');
    expect(source).toContain('data-lighter-deposit-verified="true"');
    expect(source).toContain("Verified Lighter deposit address");
    expect(source).toContain("Generate verified deposit address");
    expect(source).toContain("Never send to the owner address.");
    expect(turnkeyProviderSource).toContain("const signLighterDepositAuthorization = useCallback");
    expect(turnkeyProviderSource).toContain("validateLighterDepositAuthorizationMessage(message, expectedOwnerAddress)");
    expect(turnkeyProviderSource).toContain("withOneStableTurnkeyRefresh");
    expect(turnkeyProviderSource).toContain("pair.owner.address.toLowerCase() !== expectedOwnerAddress.toLowerCase()");
    expect(turnkeyProviderSource).not.toContain("signOwnerMessage:");
    expect(source.match(/void refreshLighterDepositDestination\(/g)).toHaveLength(1);
  });

  it("locks address generation after an ambiguous provider result", () => {
    expect(source).toContain("isLighterDepositRetryForbidden(caught)");
    expect(source).toContain("if (lighterDepositRetryForbidden) return;");
    expect(source).toContain("ghola_lighter_uda_retry_forbidden_v1:");
    expect(source).toContain("provider history alone stays locked.");
    expect(source).toContain("reconcileExistingLighterDepositDestination(");
    expect(source).toContain("!lighterFundingEligibilityAccepted");
    expect(source).toContain('retryForbidden ? (');
    expect(source).toContain('onClick={onReconcile}');
    expect(source).toContain("Check provider status");
    expect(source).toContain("provider history alone never unlocks funding.");
    expect(source).toContain("perpsTurnkey.authenticated && !lighterDepositRetryForbidden");
    expect(source).toContain("perpsTurnkey.authenticated && lighterDepositRetryForbidden");
  });

  it("rechecks once when the user returns from Lighter without polling or submitting", () => {
    expect(source).toContain('window.addEventListener("focus", refreshOnReturn)');
    expect(source).toContain('document.addEventListener("visibilitychange", refreshOnReturn)');
    expect(source).toContain("lighterReadinessRequestRef.current");
    expect(source).not.toContain("setInterval(() => void refreshLighterReadiness");
  });
});
