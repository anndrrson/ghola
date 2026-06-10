export type GholaEnterpriseGateStatusValue = "ready" | "blocked";
export type GholaEnterpriseGateCheckStatus = "ready" | "missing" | "blocked";

export interface GholaEnterpriseGateCheck {
  check: string;
  status: GholaEnterpriseGateCheckStatus;
  reason: string | null;
}

export interface GholaEnterpriseBaselineEvidence {
  status: GholaEnterpriseGateCheckStatus;
  tag: string | null;
  commit: string | null;
  deployment_url: string | null;
  worker_image_digest: string | null;
  redacted_env_hash: string | null;
  artifacts_hash: string | null;
  frozen_at: string | null;
  reason_codes: string[];
}

export interface GholaExternalSecurityReviewEvidence {
  status: GholaEnterpriseGateCheckStatus;
  firms: string[];
  report_hash: string | null;
  report_date: string | null;
  retest_status: string | null;
  retest_hash: string | null;
  reason_codes: string[];
}

export interface GholaCustodyComplianceEvidence {
  status: GholaEnterpriseGateCheckStatus;
  custody_model: string | null;
  firm: string | null;
  signoff_hash: string | null;
  signed_at: string | null;
  reason_codes: string[];
}

export interface GholaSoc2Type2Evidence {
  status: GholaEnterpriseGateCheckStatus;
  auditor: string | null;
  report_hash: string | null;
  report_date: string | null;
  period_start: string | null;
  period_end: string | null;
  criteria: string[];
  reason_codes: string[];
}

export interface GholaRunbookDrillEvidence {
  status: GholaEnterpriseGateCheckStatus;
  evidence_hash: string | null;
  accepted_at: string | null;
  tabletop_drill_at: string | null;
  live_drill_at: string | null;
  reason_codes: string[];
}

export interface GholaEnterpriseFindingsEvidence {
  status: GholaEnterpriseGateCheckStatus;
  critical_open: number | null;
  high_open: number | null;
  reason_codes: string[];
}

export interface GholaEnterpriseGateStatus {
  version: 1;
  status: GholaEnterpriseGateStatusValue;
  full_enterprise_ready: boolean;
  checks: GholaEnterpriseGateCheck[];
  baseline: GholaEnterpriseBaselineEvidence;
  external_security_review: GholaExternalSecurityReviewEvidence;
  custody_compliance: GholaCustodyComplianceEvidence;
  soc2_type2: GholaSoc2Type2Evidence;
  runbook_drills: GholaRunbookDrillEvidence;
  findings: GholaEnterpriseFindingsEvidence;
  required_evidence: string[];
  checked_at: string;
}

const REQUIRED_EVIDENCE = [
  "Frozen enterprise review baseline with commit, tag, deployment URL, worker image digest, redacted env hash, and artifact hash.",
  "External protocol/crypto and web/API/cloud security reports with passing High/Critical retests.",
  "Outside counsel custody/compliance signoff for self-custody-only operation.",
  "Issued SOC 2 Type II report covering Security, Availability, and Confidentiality.",
  "Accepted tabletop and live non-destructive runbook drill evidence.",
  "Explicit zero Critical and zero High open finding counts.",
] as const;

const REQUIRED_SOC2_CRITERIA = ["security", "availability", "confidentiality"] as const;

export function enterpriseGateStatus(
  env: Record<string, string | undefined> = process.env,
  now: Date = new Date(),
): GholaEnterpriseGateStatus {
  const baseline = baselineEvidence(env);
  const externalReview = externalSecurityReviewEvidence(env);
  const custodyCompliance = custodyComplianceEvidence(env);
  const soc2Type2 = soc2Type2Evidence(env);
  const runbookDrills = runbookDrillEvidence(env);
  const findings = findingsEvidence(env);

  const checks: GholaEnterpriseGateCheck[] = [
    gateCheck("enterprise_review_baseline_frozen", baseline),
    gateCheck("external_security_review_passed", externalReview),
    gateCheck("custody_compliance_signed", custodyCompliance),
    gateCheck("soc2_type2_issued", soc2Type2),
    gateCheck("runbook_drills_accepted", runbookDrills),
    gateCheck("no_open_high_or_critical_findings", findings),
  ];
  const fullEnterpriseReady = checks.every((check) => check.status === "ready");
  return {
    version: 1,
    status: fullEnterpriseReady ? "ready" : "blocked",
    full_enterprise_ready: fullEnterpriseReady,
    checks,
    baseline,
    external_security_review: externalReview,
    custody_compliance: custodyCompliance,
    soc2_type2: soc2Type2,
    runbook_drills: runbookDrills,
    findings,
    required_evidence: [...REQUIRED_EVIDENCE],
    checked_at: now.toISOString(),
  };
}

function baselineEvidence(env: Record<string, string | undefined>): GholaEnterpriseBaselineEvidence {
  const tag = trimmed(env.GHOLA_ENTERPRISE_BASELINE_TAG);
  const commit = trimmed(env.GHOLA_ENTERPRISE_BASELINE_COMMIT);
  const deploymentUrl = trimmed(env.GHOLA_ENTERPRISE_BASELINE_DEPLOYMENT_URL);
  const workerImageDigest = trimmed(env.GHOLA_ENTERPRISE_BASELINE_WORKER_IMAGE_DIGEST);
  const redactedEnvHash = trimmed(env.GHOLA_ENTERPRISE_BASELINE_REDACTED_ENV_HASH);
  const artifactsHash = trimmed(env.GHOLA_ENTERPRISE_BASELINE_ARTIFACTS_HASH);
  const frozenAt = trimmed(env.GHOLA_ENTERPRISE_BASELINE_FROZEN_AT);
  const reasonCodes = [
    tag ? null : "enterprise_baseline_tag_missing",
    commit ? null : "enterprise_baseline_commit_missing",
    deploymentUrl ? null : "enterprise_baseline_deployment_url_missing",
    workerImageDigest ? null : "enterprise_baseline_worker_image_digest_missing",
    redactedEnvHash ? null : "enterprise_baseline_redacted_env_hash_missing",
    artifactsHash ? null : "enterprise_baseline_artifacts_hash_missing",
    frozenAt ? null : "enterprise_baseline_frozen_at_missing",
  ].filter(isString);
  return {
    status: statusFromReasons(reasonCodes),
    tag: tag || null,
    commit: commit || null,
    deployment_url: deploymentUrl || null,
    worker_image_digest: workerImageDigest || null,
    redacted_env_hash: redactedEnvHash || null,
    artifacts_hash: artifactsHash || null,
    frozen_at: frozenAt || null,
    reason_codes: reasonCodes,
  };
}

function externalSecurityReviewEvidence(
  env: Record<string, string | undefined>,
): GholaExternalSecurityReviewEvidence {
  const reviewStatus = trimmed(env.GHOLA_EXTERNAL_SECURITY_REVIEW_STATUS);
  const firms = listValue(env.GHOLA_EXTERNAL_SECURITY_REVIEW_FIRMS);
  const reportHash = trimmed(env.GHOLA_EXTERNAL_SECURITY_REVIEW_REPORT_HASH);
  const reportDate = trimmed(env.GHOLA_EXTERNAL_SECURITY_REVIEW_REPORT_DATE);
  const retestStatus = trimmed(env.GHOLA_EXTERNAL_SECURITY_REVIEW_RETEST_STATUS);
  const retestHash = trimmed(env.GHOLA_EXTERNAL_SECURITY_REVIEW_RETEST_HASH);
  const reasonCodes = [
    reviewStatus === "passed" ? null : "external_security_review_not_passed",
    firms.length > 0 ? null : "external_security_review_firms_missing",
    reportHash ? null : "external_security_review_report_hash_missing",
    reportDate ? null : "external_security_review_report_date_missing",
    retestStatus === "passed" ? null : "external_security_review_retest_not_passed",
    retestHash ? null : "external_security_review_retest_hash_missing",
  ].filter(isString);
  return {
    status: statusFromReasons(reasonCodes),
    firms,
    report_hash: reportHash || null,
    report_date: reportDate || null,
    retest_status: retestStatus || null,
    retest_hash: retestHash || null,
    reason_codes: reasonCodes,
  };
}

function custodyComplianceEvidence(
  env: Record<string, string | undefined>,
): GholaCustodyComplianceEvidence {
  const signoffStatus = trimmed(env.GHOLA_CUSTODY_COMPLIANCE_SIGNOFF_STATUS);
  const custodyModel = trimmed(env.GHOLA_CUSTODY_MODEL);
  const firm = trimmed(env.GHOLA_CUSTODY_COMPLIANCE_SIGNOFF_FIRM);
  const signoffHash = trimmed(env.GHOLA_CUSTODY_COMPLIANCE_SIGNOFF_HASH);
  const signedAt = trimmed(env.GHOLA_CUSTODY_COMPLIANCE_SIGNOFF_DATE);
  const reasonCodes = [
    custodyModel === "self_custody" ? null : "custody_model_not_self_custody",
    signoffStatus === "signed" ? null : "custody_compliance_signoff_not_signed",
    firm ? null : "custody_compliance_signoff_firm_missing",
    signoffHash ? null : "custody_compliance_signoff_hash_missing",
    signedAt ? null : "custody_compliance_signoff_date_missing",
  ].filter(isString);
  return {
    status: statusFromReasons(reasonCodes),
    custody_model: custodyModel || null,
    firm: firm || null,
    signoff_hash: signoffHash || null,
    signed_at: signedAt || null,
    reason_codes: reasonCodes,
  };
}

function soc2Type2Evidence(env: Record<string, string | undefined>): GholaSoc2Type2Evidence {
  const soc2Status = trimmed(env.GHOLA_SOC2_TYPE2_STATUS);
  const auditor = trimmed(env.GHOLA_SOC2_TYPE2_AUDITOR);
  const reportHash = trimmed(env.GHOLA_SOC2_TYPE2_REPORT_HASH);
  const reportDate = trimmed(env.GHOLA_SOC2_TYPE2_REPORT_DATE);
  const periodStart = trimmed(env.GHOLA_SOC2_TYPE2_PERIOD_START);
  const periodEnd = trimmed(env.GHOLA_SOC2_TYPE2_PERIOD_END);
  const criteria = listValue(env.GHOLA_SOC2_TYPE2_CRITERIA).map((item) => item.toLowerCase());
  const missingCriteria = REQUIRED_SOC2_CRITERIA.filter((item) => !criteria.includes(item));
  const reasonCodes = [
    soc2Status === "issued" ? null : "soc2_type2_not_issued",
    auditor ? null : "soc2_type2_auditor_missing",
    reportHash ? null : "soc2_type2_report_hash_missing",
    reportDate ? null : "soc2_type2_report_date_missing",
    periodStart ? null : "soc2_type2_period_start_missing",
    periodEnd ? null : "soc2_type2_period_end_missing",
    missingCriteria.length === 0 ? null : `soc2_type2_required_criteria_missing:${missingCriteria.join(",")}`,
  ].filter(isString);
  return {
    status: statusFromReasons(reasonCodes),
    auditor: auditor || null,
    report_hash: reportHash || null,
    report_date: reportDate || null,
    period_start: periodStart || null,
    period_end: periodEnd || null,
    criteria,
    reason_codes: reasonCodes,
  };
}

function runbookDrillEvidence(env: Record<string, string | undefined>): GholaRunbookDrillEvidence {
  const drillStatus = trimmed(env.GHOLA_RUNBOOK_DRILLS_STATUS);
  const evidenceHash = trimmed(env.GHOLA_RUNBOOK_DRILLS_EVIDENCE_HASH);
  const acceptedAt = trimmed(env.GHOLA_RUNBOOK_DRILLS_ACCEPTED_AT);
  const tabletopDrillAt = trimmed(env.GHOLA_RUNBOOK_TABLETOP_DRILL_AT);
  const liveDrillAt = trimmed(env.GHOLA_RUNBOOK_LIVE_DRILL_AT);
  const reasonCodes = [
    drillStatus === "accepted" ? null : "runbook_drills_not_accepted",
    evidenceHash ? null : "runbook_drills_evidence_hash_missing",
    acceptedAt ? null : "runbook_drills_accepted_at_missing",
    tabletopDrillAt ? null : "runbook_tabletop_drill_at_missing",
    liveDrillAt ? null : "runbook_live_drill_at_missing",
  ].filter(isString);
  return {
    status: statusFromReasons(reasonCodes),
    evidence_hash: evidenceHash || null,
    accepted_at: acceptedAt || null,
    tabletop_drill_at: tabletopDrillAt || null,
    live_drill_at: liveDrillAt || null,
    reason_codes: reasonCodes,
  };
}

function findingsEvidence(env: Record<string, string | undefined>): GholaEnterpriseFindingsEvidence {
  const criticalOpen = nonNegativeInteger(env.GHOLA_SECURITY_FINDINGS_CRITICAL_OPEN);
  const highOpen = nonNegativeInteger(env.GHOLA_SECURITY_FINDINGS_HIGH_OPEN);
  const reasonCodes = [
    criticalOpen === null ? "critical_findings_count_missing" : null,
    highOpen === null ? "high_findings_count_missing" : null,
    criticalOpen !== null && criticalOpen > 0 ? "critical_findings_open" : null,
    highOpen !== null && highOpen > 0 ? "high_findings_open" : null,
  ].filter(isString);
  return {
    status: reasonCodes.some((reason) => reason.endsWith("_open"))
      ? "blocked"
      : statusFromReasons(reasonCodes),
    critical_open: criticalOpen,
    high_open: highOpen,
    reason_codes: reasonCodes,
  };
}

function gateCheck(
  checkName: string,
  evidence: { status: GholaEnterpriseGateCheckStatus; reason_codes: string[] },
): GholaEnterpriseGateCheck {
  return {
    check: checkName,
    status: evidence.status,
    reason: evidence.reason_codes[0] ?? null,
  };
}

function statusFromReasons(reasonCodes: string[]): GholaEnterpriseGateCheckStatus {
  return reasonCodes.length === 0 ? "ready" : "missing";
}

function nonNegativeInteger(value: string | undefined): number | null {
  const input = trimmed(value);
  if (!/^\d+$/.test(input)) return null;
  return Number.parseInt(input, 10);
}

function listValue(value: string | undefined): string[] {
  return trimmed(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function trimmed(value: string | undefined): string {
  return value?.trim() ?? "";
}

function isString(value: string | null): value is string {
  return typeof value === "string" && value.length > 0;
}
