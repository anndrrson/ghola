import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "src/components/carry/CarryAccountSetup.tsx"),
  "utf8",
);

describe("Lighter activation readiness UI", () => {
  it("separates the verified owner account from both network-fee requirements", () => {
    expect(source).toContain("fetchLighterActivationReadiness");
    expect(source).toContain('label="Lighter collateral · ≥5 USDC"');
    expect(source).toContain('label="Base network fee"');
    expect(source).toContain('label="Lighter owner account"');
    expect(source).toContain('label="Ethereum association fee"');
    expect(source).toContain("!lighterReadiness?.ready");
  });

  it("states that the check is read-only", () => {
    expect(source).toContain("No payment, transfer, key, or order is submitted by this check.");
  });

  it("rechecks once when the user returns from Lighter without polling or submitting", () => {
    expect(source).toContain('window.addEventListener("focus", refreshOnReturn)');
    expect(source).toContain('document.addEventListener("visibilitychange", refreshOnReturn)');
    expect(source).toContain("lighterReadinessRequestRef.current");
    expect(source).not.toContain("setInterval(() => void refreshLighterReadiness");
  });
});
