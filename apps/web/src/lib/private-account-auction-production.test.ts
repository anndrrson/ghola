import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  auctionClearingProverArtifactStatus,
  institutionalAuctionReadinessStatus,
} from "./private-account-auction-production";

function tempArtifactsDir() {
  return mkdtempSync(path.join(tmpdir(), "ghola-auction-artifacts-"));
}

function writeArtifactSet(dir: string) {
  mkdirSync(path.join(dir, "auctionClearing_js"), { recursive: true });
  writeFileSync(path.join(dir, "auctionClearing_final.zkey"), "zkey");
  writeFileSync(path.join(dir, "auctionClearing_js", "auctionClearing.wasm"), "wasm");
  writeFileSync(path.join(dir, "auctionClearing_verification_key.json"), "{}");
}

function enterpriseReadyEnv(): Record<string, string> {
  return {
    GHOLA_ENTERPRISE_BASELINE_TAG: "enterprise-review-2026-05-28",
    GHOLA_ENTERPRISE_BASELINE_COMMIT: "abcdef1234567890",
    GHOLA_ENTERPRISE_BASELINE_DEPLOYMENT_URL: "https://ghola.xyz",
    GHOLA_ENTERPRISE_BASELINE_WORKER_IMAGE_DIGEST: "sha256:worker",
    GHOLA_ENTERPRISE_BASELINE_REDACTED_ENV_HASH: "sha256:env",
    GHOLA_ENTERPRISE_BASELINE_ARTIFACTS_HASH: "sha256:artifacts",
    GHOLA_ENTERPRISE_BASELINE_FROZEN_AT: "2026-05-28T00:00:00.000Z",
    GHOLA_EXTERNAL_SECURITY_REVIEW_STATUS: "passed",
    GHOLA_EXTERNAL_SECURITY_REVIEW_FIRMS: "Trail of Bits,NCC Group",
    GHOLA_EXTERNAL_SECURITY_REVIEW_REPORT_HASH: "sha256:security-report",
    GHOLA_EXTERNAL_SECURITY_REVIEW_REPORT_DATE: "2026-07-01",
    GHOLA_EXTERNAL_SECURITY_REVIEW_RETEST_STATUS: "passed",
    GHOLA_EXTERNAL_SECURITY_REVIEW_RETEST_HASH: "sha256:security-retest",
    GHOLA_CUSTODY_MODEL: "self_custody",
    GHOLA_CUSTODY_COMPLIANCE_SIGNOFF_STATUS: "signed",
    GHOLA_CUSTODY_COMPLIANCE_SIGNOFF_FIRM: "outside-counsel",
    GHOLA_CUSTODY_COMPLIANCE_SIGNOFF_HASH: "sha256:custody-memo",
    GHOLA_CUSTODY_COMPLIANCE_SIGNOFF_DATE: "2026-07-02",
    GHOLA_SOC2_TYPE2_STATUS: "issued",
    GHOLA_SOC2_TYPE2_AUDITOR: "cpa-firm",
    GHOLA_SOC2_TYPE2_REPORT_HASH: "sha256:soc2",
    GHOLA_SOC2_TYPE2_REPORT_DATE: "2026-12-01",
    GHOLA_SOC2_TYPE2_PERIOD_START: "2026-06-01",
    GHOLA_SOC2_TYPE2_PERIOD_END: "2026-11-30",
    GHOLA_SOC2_TYPE2_CRITERIA: "Security,Availability,Confidentiality",
    GHOLA_RUNBOOK_DRILLS_STATUS: "accepted",
    GHOLA_RUNBOOK_DRILLS_EVIDENCE_HASH: "sha256:runbooks",
    GHOLA_RUNBOOK_DRILLS_ACCEPTED_AT: "2026-07-03T00:00:00.000Z",
    GHOLA_RUNBOOK_TABLETOP_DRILL_AT: "2026-07-02T00:00:00.000Z",
    GHOLA_RUNBOOK_LIVE_DRILL_AT: "2026-07-03T00:00:00.000Z",
    GHOLA_SECURITY_FINDINGS_CRITICAL_OPEN: "0",
    GHOLA_SECURITY_FINDINGS_HIGH_OPEN: "0",
  };
}

describe("institutional auction production readiness", () => {
  it("reports missing auction clearing prover artifacts", () => {
    const dir = tempArtifactsDir();
    try {
      const status = auctionClearingProverArtifactStatus({
        GHOLA_AUCTION_PROVER_ARTIFACTS_DIR: dir,
      });

      expect(status.ready).toBe(false);
      expect(status.missing).toEqual(["zkey", "wasm", "verification_key"]);

      const readiness = institutionalAuctionReadinessStatus({
        GHOLA_AUCTION_PROVER_ARTIFACTS_DIR: dir,
      });
      const check = readiness.checks.find((item) => item.check === "auction_clearing_prover_artifacts");
      expect(check?.status).toBe("informational");
      expect(check?.blocking).toBe(false);
      expect(readiness.auction_prover_artifacts.ready).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks auction clearing prover artifacts ready when zkey, wasm, and verification key are present", () => {
    const dir = tempArtifactsDir();
    try {
      writeArtifactSet(dir);

      const status = auctionClearingProverArtifactStatus({
        GHOLA_AUCTION_PROVER_ARTIFACTS_DIR: dir,
      });

      expect(status.ready).toBe(true);
      expect(status.zkey_present).toBe(true);
      expect(status.wasm_present).toBe(true);
      expect(status.verification_key_present).toBe(true);
      expect(status.missing).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks full production readiness until the enterprise external gate is ready", () => {
    const readiness = institutionalAuctionReadinessStatus({
      GHOLA_INSTITUTIONAL_FULL_PRODUCTION_ENABLED: "true",
      GHOLA_SHIELDED_POOL_PROGRAM_ID: "5bmCDeaQceBpWgK8aADB4Tz4JzqZ9hkCi3qedC6oZR8A",
      GHOLA_SHIELDED_POOL_MINT: "So11111111111111111111111111111111111111112",
    }, new Date("2026-05-28T00:00:00.000Z"));
    const gate = readiness.checks.find((item) => item.check === "enterprise_external_gate");

    expect(readiness.status).toBe("blocked");
    expect(readiness.full_enterprise_ready).toBe(false);
    expect(gate).toMatchObject({
      status: "blocked",
      blocking: true,
      reason: "enterprise_external_gate_not_ready",
    });
  });

  it("does not block production readiness on enterprise evidence after signed external gates are present", () => {
    const readiness = institutionalAuctionReadinessStatus({
      ...enterpriseReadyEnv(),
      GHOLA_INSTITUTIONAL_FULL_PRODUCTION_ENABLED: "true",
      GHOLA_SHIELDED_POOL_PROGRAM_ID: "5bmCDeaQceBpWgK8aADB4Tz4JzqZ9hkCi3qedC6oZR8A",
      GHOLA_SHIELDED_POOL_MINT: "So11111111111111111111111111111111111111112",
    }, new Date("2026-12-01T00:00:00.000Z"));
    const gate = readiness.checks.find((item) => item.check === "enterprise_external_gate");

    expect(readiness.full_enterprise_ready).toBe(true);
    expect(gate).toMatchObject({
      status: "ready",
      blocking: true,
      reason: null,
    });
  });
});
