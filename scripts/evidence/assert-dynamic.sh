#!/usr/bin/env bash
# Stream 10 — production-hardening Evidence Gate: dynamic-outcome gate.
#
# Usage: scripts/evidence/assert-dynamic.sh <path-to-evidence.json>
#
# Hard-asserts the DYNAMIC-run outcomes captured in evidence.json. This
# is the half of the gate that the commitment-only verify.sh deliberately
# does NOT cover: rather than re-deriving a document hash, these checks
# fail the build when a security run actually went wrong.
#
# Enforced invariants (any failure => exit 1):
#   - fuzz.executed     == true   (the fuzz run was not skipped)
#   - fuzz.crashes      == 0       (no libFuzzer crash artifacts produced)
#   - fuzz.minutes      >  0       (non-trivial wall-clock budget spent)
#   - supply_chain.deny_pass  == true  (cargo deny --all-features check)
#   - supply_chain.audit_pass == true  (cargo audit)
#   - every stream's fail_count == 0   (invariants/replay/secrets/chaos/
#                                       telemetry/malicious test failures)
#
# The evidence.json is produced by collect.sh + commit.sh from a real run.

set -euo pipefail

EV="${1:-}"
if [ -z "${EV}" ] || [ ! -f "${EV}" ]; then
  echo "usage: $0 <path-to-evidence.json>" >&2
  exit 2
fi

fail=0
note() { echo "  $1"; }
bad()  { echo "  FAIL: $1"; fail=1; }

jqr() { jq -r "$1" "${EV}"; }

echo "dynamic-stream gate: ${EV}"

# ---- fuzz ----
fuzz_executed="$(jqr '.streams.fuzz.executed')"
fuzz_crashes="$(jqr '.streams.fuzz.crashes // 0')"
fuzz_minutes="$(jqr '.streams.fuzz.minutes // 0')"
if [ "${fuzz_executed}" = "true" ]; then
  note "fuzz.executed = true"
else
  bad "fuzz was not executed (fuzz.executed=${fuzz_executed}). Run cargo-fuzz in CI; do not set EVIDENCE_SKIP_FUZZ on the gate."
fi
if [ "${fuzz_crashes}" = "0" ]; then
  note "fuzz.crashes = 0"
else
  bad "fuzz produced ${fuzz_crashes} crash artifact(s); triage fuzz/artifacts/*."
fi
if [ "${fuzz_minutes}" -gt 0 ] 2>/dev/null; then
  note "fuzz.minutes = ${fuzz_minutes}"
else
  bad "fuzz.minutes=${fuzz_minutes}; expected a non-zero wall-clock budget."
fi

# ---- supply chain ----
deny_pass="$(jqr '.streams.supply_chain.deny_pass')"
audit_pass="$(jqr '.streams.supply_chain.audit_pass')"
if [ "${deny_pass}" = "true" ]; then
  note "supply_chain.deny_pass = true"
else
  bad "cargo deny --all-features check did not pass (deny_pass=${deny_pass}). Resolve the ban/license/source/advisory, or document a specific exception in deny.toml."
fi
if [ "${audit_pass}" = "true" ]; then
  note "supply_chain.audit_pass = true"
else
  bad "cargo audit did not pass (audit_pass=${audit_pass}). Resolve the advisory or document an ignore in .cargo/audit.toml."
fi

# ---- per-stream test failures ----
for stream in invariants replay secrets chaos telemetry malicious; do
  fc="$(jqr ".streams.${stream}.fail_count // 0")"
  [[ "${fc}" =~ ^[0-9]+$ ]] || fc="unknown"
  if [ "${fc}" = "0" ]; then
    note "${stream}.fail_count = 0"
  else
    bad "${stream} reported fail_count=${fc}."
  fi
done

echo
if [ "${fail}" -ne 0 ]; then
  echo "dynamic-stream gate: FAILED"
  exit 1
fi
echo "dynamic-stream gate: PASSED"
exit 0
