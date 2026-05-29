# Security Backlog (2026 Q2)

Last updated: 2026-05-14
Status values: `todo` | `in_progress` | `blocked` | `done`

Owner placeholders should be replaced with real GitHub handles.

## P0: Release and Runtime Hard Gates

| ID | Priority | Status | Owner | Due | Task | Acceptance Criteria | Evidence |
|---|---|---|---|---|---|---|---|
| SEC-001 | P0 | done | `@security-owner` | 2026-05-16 | Enforce deploy gate: CI + canary + `private_ready=true` + zero High/Critical | Merge to `main` blocked when any condition fails | [`.github/workflows/ci.yml`](/Users/andersonobrien/Downloads/ghola/.github/workflows/ci.yml) |
| SEC-002 | P0 | done | `@relay-owner` | 2026-05-16 | Keep `/ready/private` as deploy/runtime SLO signal | Endpoint returns 200 only when private stack ready | [`crates/ghola-relay/src/handlers.rs`](/Users/andersonobrien/Downloads/ghola/crates/ghola-relay/src/handlers.rs) |
| SEC-003 | P0 | todo | `@secops-owner` | 2026-05-16 | Define formal severity and SLA policy | Critical=24h, High=72h documented and acknowledged | Policy doc link + approval comment |
| SEC-004 | P0 | todo | `@secops-owner` | 2026-05-16 | Establish findings tracker lifecycle | Findings file update process documented | Process doc + sample update PR |

## P1: Threat Model and Data Risk Mapping

| ID | Priority | Status | Owner | Due | Task | Acceptance Criteria | Evidence |
|---|---|---|---|---|---|---|---|
| SEC-010 | P0 | todo | `@security-owner` | 2026-05-21 | Build threat model for sealed/OHTTP/attestation/relay/web | Threat model reviewed and signed off by web+relay+infra leads | Threat model doc + sign-off |
| SEC-011 | P0 | todo | `@platform-owner` | 2026-05-21 | Crown-jewel inventory (prompts, keys, DID mappings, receipt artifacts) | Data classes and handling requirements defined | Data inventory doc |
| SEC-012 | P1 | todo | `@platform-owner` | 2026-05-21 | Trust-boundary and fail-closed invariant map | All private-path boundaries explicitly documented | Architecture/security appendix |

## P2: External Validation

| ID | Priority | Status | Owner | Due | Task | Acceptance Criteria | Evidence |
|---|---|---|---|---|---|---|---|
| SEC-020 | P0 | todo | `@security-owner` | 2026-05-24 | Contract external web/API pentest | Vendor signed; test plan approved | SOW + kickoff notes |
| SEC-021 | P0 | todo | `@security-owner` | 2026-05-24 | Contract external protocol/crypto review | Vendor signed; scope includes sealed proof chain | SOW + scope matrix |
| SEC-022 | P0 | todo | `@security-owner` | 2026-06-05 | Complete pentest execution window | Final report received with findings + PoCs | Final report link |
| SEC-023 | P0 | todo | `@security-owner` | 2026-06-05 | Complete crypto/protocol review window | Final report includes attestation and key-validation conclusions | Final report link |

## P3: Remediation and Regression Hardening

| ID | Priority | Status | Owner | Due | Task | Acceptance Criteria | Evidence |
|---|---|---|---|---|---|---|---|
| SEC-030 | P0 | todo | `@engineering-manager` | 2026-06-20 | Triage all external findings and assign owners | Every finding has owner, severity, due date | Triage board snapshot |
| SEC-031 | P0 | todo | `@web-owner` | 2026-06-20 | Fix all web-side High/Critical findings | No open High/Critical on web scope | Merged PRs + retest notes |
| SEC-032 | P0 | todo | `@relay-owner` | 2026-06-20 | Fix all relay-side High/Critical findings | No open High/Critical on relay scope | Merged PRs + retest notes |
| SEC-033 | P0 | todo | `@qa-owner` | 2026-06-20 | Add regression tests per resolved High/Critical finding | Test exists and fails when vulnerability is reintroduced | Test paths and CI green run |
| SEC-034 | P0 | todo | `@security-owner` | 2026-06-20 | External retest for all closed High/Critical | Independent retest says pass | Retest report |

## P4: Detection and Incident Readiness

| ID | Priority | Status | Owner | Due | Task | Acceptance Criteria | Evidence |
|---|---|---|---|---|---|---|---|
| SEC-040 | P0 | in_progress | `@secops-owner` | 2026-06-27 | Alert on private-path degradation events | Alerts fire for readiness fail, forced-open-switch, proof verification fail | Frontend/relay structured events in [`apps/web/src/app/chat/page.tsx`](/Users/andersonobrien/Downloads/ghola/apps/web/src/app/chat/page.tsx), [`apps/web/src/lib/sealed-stream.ts`](/Users/andersonobrien/Downloads/ghola/apps/web/src/lib/sealed-stream.ts), [`crates/ghola-relay/src/handlers.rs`](/Users/andersonobrien/Downloads/ghola/crates/ghola-relay/src/handlers.rs) |
| SEC-041 | P1 | todo | `@infra-owner` | 2026-06-27 | DB exfiltration and credential abuse detection | Detection rules cover suspicious access and privilege spikes | Rule config + test events |
| SEC-042 | P0 | todo | `@incident-owner` | 2026-06-27 | Incident runbooks for privacy downgrade, key compromise, DB compromise | Runbooks complete and linked in on-call handbook | Runbook links |
| SEC-043 | P0 | todo | `@incident-owner` | 2026-06-27 | Run tabletop + restore drill | Drill completed with action items tracked | Postmortem + action tracker |

## P5: Continuous Offensive Security

| ID | Priority | Status | Owner | Due | Task | Acceptance Criteria | Evidence |
|---|---|---|---|---|---|---|---|
| SEC-050 | P1 | todo | `@security-owner` | 2026-07-15 | Launch private bug bounty | Program live with defined scope and payout policy | Program URL + scope doc |
| SEC-051 | P1 | todo | `@security-owner` | 2026-07-31 | Run first red-team exercise | Simulated objective includes privacy bypass or data exfil path | Red-team report |
| SEC-052 | P1 | todo | `@secops-owner` | 2026-07-31 | Build monthly control audit ritual | IAM, secrets, network, backup checks executed monthly | Audit checklist results |
| SEC-053 | P1 | todo | `@security-owner` | 2026-08-15 | Establish quarterly external revalidation cadence | Next two review windows booked | Calendar + SOW links |
| SEC-060 | P0 | done | `@web-owner` | 2026-05-14 | Remove chat HTML sink and enforce CI guard against new dangerous sinks | Chat rendering path has no `dangerouslySetInnerHTML`; CI fails on unapproved usage | [`apps/web/src/components/chat/ChatMessages.tsx`](/Users/andersonobrien/Downloads/ghola/apps/web/src/components/chat/ChatMessages.tsx), [`scripts/security/check-dangerous-html.sh`](/Users/andersonobrien/Downloads/ghola/scripts/security/check-dangerous-html.sh), [`.github/workflows/ci.yml`](/Users/andersonobrien/Downloads/ghola/.github/workflows/ci.yml) |
| SEC-061 | P0 | done | `@web-owner` | 2026-05-14 | Move Thumper web auth token from `localStorage` to HttpOnly session cookie with server-side API proxy | Browser JS no longer reads/stores `thumper_token`; auth session bound to HttpOnly cookie; upstream Thumper API calls proxied server-side | [`apps/web/src/app/api/auth/session/_lib.ts`](/Users/andersonobrien/Downloads/ghola/apps/web/src/app/api/auth/session/_lib.ts), [`apps/web/src/app/api/auth/session/me/route.ts`](/Users/andersonobrien/Downloads/ghola/apps/web/src/app/api/auth/session/me/route.ts), [`apps/web/src/app/api/thumper/[...path]/route.ts`](/Users/andersonobrien/Downloads/ghola/apps/web/src/app/api/thumper/[...path]/route.ts), [`apps/web/src/lib/thumper-api.ts`](/Users/andersonobrien/Downloads/ghola/apps/web/src/lib/thumper-api.ts), [`apps/web/src/lib/thumper-auth-context.tsx`](/Users/andersonobrien/Downloads/ghola/apps/web/src/lib/thumper-auth-context.tsx) |

## Current Mandatory Metrics

Track and review weekly:

1. `critical_open`
2. `high_open`
3. `canary_pass_rate`
4. `private_readiness_failures`
5. `critical_mttr_hours`
6. `high_mttr_hours`
7. `private_path_mttd_minutes`
8. `incident_mttr_minutes`

## First 72 Hours Checklist

1. Assign real owners to `SEC-001..SEC-004`.
2. Approve SLA policy language.
3. Kick off `SEC-020` and `SEC-021` procurement.
4. Schedule weekly security review meeting.
5. Open GitHub issues for all `SEC-*` tasks and link back here.
