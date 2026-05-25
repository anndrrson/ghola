# Ghola Security Program (2026 Q2)

Last updated: 2026-05-14
Scope: `ghola.xyz` web + relay + sealed private path + production release process

## Goal

Drive risk to a minimum practical level for privacy-sensitive workloads by combining:

- fail-closed technical controls,
- independent external testing,
- strict release gates,
- fast remediation,
- continuous detection and response.

This program targets "maximum practical security," not literal bug-free software.

## Non-Negotiable Production Gate

A production deploy is blocked unless all are true:

1. Full CI is green.
2. Latest canary is green and fresh.
3. Relay private readiness is healthy (`private_ready=true`).
4. Known `High` findings = `0`.
5. Known `Critical` findings = `0`.

Tracked source of truth:

- [`.github/security/security-findings.json`](/Users/andersonobrien/Downloads/ghola/.github/security/security-findings.json)

## Remediation SLA

1. Critical: mitigate within 24 hours.
2. High: mitigate within 72 hours.
3. A finding is not "closed" until retest evidence is attached.

## 90-Day Execution Timeline

## Phase 0: Lock Runtime + Release Controls (May 14-16, 2026)

Outcomes:

1. Release gate enforcement active on `main`.
2. Canary checks active and failing hard on regressions.
3. Security findings file enforced in CI.

## Phase 1: Threat Model + Attack Surface Freeze (May 17-21, 2026)

Outcomes:

1. Current-state threat model signed off.
2. Crown-jewel data inventory finalized.
3. Trust boundaries and fail-closed invariants documented.

## Phase 2: External Testing Wave (May 22-June 5, 2026)

Outcomes:

1. External web/API pentest complete.
2. External protocol/crypto review complete.
3. All findings triaged with severity + exploit narrative + PoC.

## Phase 3: High/Critical Remediation Sprint (June 6-20, 2026)

Outcomes:

1. Critical/High findings fixed and retested.
2. Regression tests added per finding.
3. Findings tracker reflects true remaining risk.

## Phase 4: Detection + Incident Readiness (June 21-27, 2026)

Outcomes:

1. Alerting in place for private-path regressions and downgrade signals.
2. Incident runbooks complete and tested.
3. Tabletop and restore drills executed.

## Phase 5: Continuous Offensive Security (June 28 onward)

Outcomes:

1. Private bug bounty live.
2. Quarterly red-team cadence established.
3. Weekly security review and monthly policy audit running.

## Security KPIs

Track weekly:

1. Open Critical count.
2. Open High count.
3. Canary pass rate.
4. Private readiness incident count.
5. Time-to-mitigate for Critical/High.
6. Time-to-detect for private-path regressions.
7. Time-to-recover for production incidents.

## Operating Cadence

## Weekly Security Review (30 min)

Agenda:

1. Open Critical/High and SLA breaches.
2. Canary and readiness trend.
3. Production exceptions and overrides.
4. New findings from scans, bounty, or external review.
5. Required decisions and owner assignment.

Attendees:

1. Security owner.
2. Web owner.
3. Relay owner.
4. Infra owner.
5. Incident commander backup.

## Monthly Control Audit (60 min)

Checklist:

1. IAM least-privilege review.
2. Secret rotation evidence.
3. Network segmentation verification.
4. Backup/restore verification evidence.
5. Runbook freshness check.

## External Review Requirements

Every external assessment must provide:

1. Exploit narrative.
2. Reproduction steps.
3. Severity justification.
4. Affected assets and blast radius.
5. Concrete remediation guidance.
6. Retest result after fix.

## Exit Criteria (Program Success)

Program considered successful when:

1. Zero known High/Critical findings sustained for 90 days.
2. No silent Private downgrade path exists in code or runtime.
3. External retest passes on all previously High/Critical items.
4. Incident drills meet target response times.
