import { describe, expect, it } from "vitest";
import { enterpriseGateStatus } from "./enterprise-gate-status";

const READY_ENTERPRISE_ENV = {
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
} satisfies Record<string, string>;

describe("enterprise gate status", () => {
  it("blocks full enterprise readiness until signed evidence exists", () => {
    const status = enterpriseGateStatus({}, new Date("2026-05-28T00:00:00.000Z"));

    expect(status.status).toBe("blocked");
    expect(status.full_enterprise_ready).toBe(false);
    expect(status.checks.map((check) => check.reason)).toEqual(expect.arrayContaining([
      "enterprise_baseline_tag_missing",
      "external_security_review_not_passed",
      "custody_model_not_self_custody",
      "soc2_type2_not_issued",
      "runbook_drills_not_accepted",
      "critical_findings_count_missing",
    ]));
  });

  it("marks the gate ready only with external review, custody, SOC 2, runbook, and findings evidence", () => {
    const status = enterpriseGateStatus(READY_ENTERPRISE_ENV, new Date("2026-12-01T00:00:00.000Z"));

    expect(status.status).toBe("ready");
    expect(status.full_enterprise_ready).toBe(true);
    expect(status.checks.every((check) => check.status === "ready")).toBe(true);
    expect(status.external_security_review.firms).toEqual(["Trail of Bits", "NCC Group"]);
    expect(status.soc2_type2.criteria).toEqual(["security", "availability", "confidentiality"]);
  });

  it("does not leak unrelated secrets and blocks open High/Critical findings", () => {
    const status = enterpriseGateStatus({
      ...READY_ENTERPRISE_ENV,
      GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "super-secret-token",
      GHOLA_SECURITY_FINDINGS_HIGH_OPEN: "1",
    }, new Date("2026-12-01T00:00:00.000Z"));

    expect(status.status).toBe("blocked");
    expect(status.findings.status).toBe("blocked");
    expect(status.findings.reason_codes).toContain("high_findings_open");
    expect(JSON.stringify(status)).not.toContain("super-secret-token");
  });
});
