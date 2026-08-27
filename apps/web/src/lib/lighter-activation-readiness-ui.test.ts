import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "src/components/carry/CarryAccountSetup.tsx"),
  "utf8",
);

describe("Lighter activation readiness UI", () => {
  it("shows collateral and both network-fee requirements before retrying", () => {
    expect(source).toContain("fetchLighterActivationReadiness");
    expect(source).toContain('label="Lighter collateral"');
    expect(source).toContain('label="Base network fee"');
    expect(source).toContain('label="Ethereum owner association"');
    expect(source).toContain("!lighterReadiness?.ready");
  });

  it("states that the check is read-only", () => {
    expect(source).toContain("No payment, transfer, key, or order is submitted by this check.");
  });
});
