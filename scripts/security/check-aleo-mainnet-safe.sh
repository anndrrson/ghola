#!/usr/bin/env bash
set -euo pipefail

# check-aleo-mainnet-safe.sh
#
# Machine gate replacing "audit the bytecode by inspection" for the Aleo
# shielded-payment program. Fails (non-zero exit) if the MAINNET program
# tree (programs/aleo/ghola_pay/) is not safe to deploy. Specifically it
# refuses any artifact that:
#
#   1. Defines any transition/function OTHER than `pay` in src/main.leo
#      (a stray `mint_for_testing` or any other mint = infinite-mint hole).
#   2. Still carries the placeholder-USDCx marker / local token record
#      (deploying the self-defined placeholder token instead of canonical
#      bridged USDC.a settles a worthless self-minted token).
#   3. If a built artifact exists at build/main.aleo, that bytecode
#      declares any `function`/`closure` other than `pay`.
#
# The DEVNET-only mint lives in a physically separate program
# (programs/aleo/ghola_pay_devnet/) which is intentionally NOT checked
# here — it is never a mainnet artifact.
#
# MODES:
#   --mode=merge   (default) Block-on-merge severity. Enforces ONLY the
#                  checks that must never regress on any commit: no mint /
#                  no extra callable in src or build artifact (Check 1 &
#                  Check 3). Does NOT fail on the placeholder marker, since
#                  the canonical bridged USDC.a type cannot be imported
#                  until bridge integration lands — that would block every
#                  PR until then.
#   --mode=deploy  Pre-mainnet-deploy severity. Enforces everything,
#                  INCLUDING the placeholder/TODO markers (Check 2). Run
#                  this immediately before any mainnet deploy; it must pass
#                  for the artifact to be deployable.
#
# Exit codes: 0 = safe, 1 = unsafe artifact (gate failure),
#             2 = script/usage error.

MODE="merge"
for arg in "$@"; do
  case "$arg" in
    --mode=merge)  MODE="merge" ;;
    --mode=deploy) MODE="deploy" ;;
    -h|--help)
      grep -E '^#( |$)' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      printf 'check-aleo-mainnet-safe: unknown argument: %s (expected --mode=merge|--mode=deploy)\n' "$arg" >&2
      exit 2
      ;;
  esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

PROGRAM_DIR="programs/aleo/ghola_pay"
SRC="${PROGRAM_DIR}/src/main.leo"
BUILD_ARTIFACT="${PROGRAM_DIR}/build/main.aleo"

fail() {
  printf 'ALEO MAINNET-SAFETY GATE FAILED: %s\n' "$1" >&2
  exit 1
}

if [ ! -f "${SRC}" ]; then
  printf 'check-aleo-mainnet-safe: source not found at %s\n' "${SRC}" >&2
  exit 2
fi

# --- Strip comments so markers/keywords inside comments do not trip or
# --- mask the checks. Leo uses C-style // line comments; we drop them.
src_code="$(sed 's#//.*##' "${SRC}")"

# --- Check 1: exactly the `pay` transition, nothing else. -----------------
# Match Leo callable declarations: transition / function / closure.
transitions="$(printf '%s\n' "${src_code}" \
  | grep -oE '\b(transition|function|closure)[[:space:]]+[A-Za-z_][A-Za-z0-9_]*' \
  | awk '{print $2}' | sort -u || true)"

if [ -z "${transitions}" ]; then
  fail "no transition/function found in ${SRC} — expected exactly one (\`pay\`)."
fi

unexpected="$(printf '%s\n' "${transitions}" | grep -vx 'pay' || true)"
if [ -n "${unexpected}" ]; then
  fail "${SRC} declares callable(s) other than \`pay\`: $(printf '%s' "${unexpected}" | tr '\n' ' '). A mint or any extra transition in the mainnet program is an infinite-mint / unaudited-surface risk. Move dev-only helpers to programs/aleo/ghola_pay_devnet/."
fi

# Belt-and-suspenders: explicitly reject any mint-shaped name even if the
# above logic were ever loosened.
if printf '%s\n' "${transitions}" | grep -qiE 'mint'; then
  fail "${SRC} contains a mint-shaped transition. Mainnet program must not mint."
fi

# --- Check 2 (deploy mode only): placeholder USDCx record must be replaced.
# The placeholder marker is the literal "INTERIM — replace with USDC.a"
# string in the record-def comment, and the TODO(verify-before-mainnet)
# tag attached to it. Either one present = not integration-ready for
# mainnet. (We grep the RAW file here, since the marker lives in comments.)
#
# This is only enforced in --mode=deploy: in merge mode we still ship with
# the placeholder because the canonical bridged USDC.a type isn't
# importable yet. The marker is REQUIRED to remain (and Check 1 still
# blocks any mint) until that integration lands; --mode=deploy then forces
# it to be resolved before a real mainnet deploy.
if [ "${MODE}" = "deploy" ]; then
  if grep -qE 'INTERIM .* replace with USDC\.a' "${SRC}"; then
    fail "${SRC} still carries the placeholder-USDCx marker ('INTERIM — replace with USDC.a'). The mainnet program must import/declare the canonical bridged USDC.a record type, not a self-defined placeholder token."
  fi
  if grep -qE 'TODO\(verify-before-mainnet\)' "${SRC}"; then
    fail "${SRC} still carries a TODO(verify-before-mainnet) marker. Resolve all pre-mainnet TODOs (placeholder record type, etc.) before deploying."
  fi
fi

# --- Check 3: if a compiled artifact exists, scan its bytecode too. -------
# leo build emits Aleo bytecode (build/main.aleo) which declares callables
# with `function <name>:` / `closure <name>:`. Verify it carries nothing
# but `pay`. This catches a build produced from an older/unsafe source.
if [ -f "${BUILD_ARTIFACT}" ]; then
  art_callables="$(grep -oE '^[[:space:]]*(function|closure)[[:space:]]+[A-Za-z_][A-Za-z0-9_]*' "${BUILD_ARTIFACT}" \
    | awk '{print $2}' | sort -u || true)"
  if [ -n "${art_callables}" ]; then
    art_unexpected="$(printf '%s\n' "${art_callables}" | grep -vx 'pay' || true)"
    if [ -n "${art_unexpected}" ]; then
      fail "built artifact ${BUILD_ARTIFACT} declares callable(s) other than \`pay\`: $(printf '%s' "${art_unexpected}" | tr '\n' ' '). Rebuild from the current (pay-only) source: \`leo clean && leo build\`."
    fi
    if printf '%s\n' "${art_callables}" | grep -qiE 'mint'; then
      fail "built artifact ${BUILD_ARTIFACT} contains a mint-shaped function. Rebuild from the current source."
    fi
  fi
fi

if [ "${MODE}" = "deploy" ]; then
  printf 'Aleo mainnet-safety gate passed (deploy mode): %s declares only `pay`, carries no mint, and no placeholder/TODO markers. Artifact is mainnet-deployable.\n' "${SRC}"
else
  printf 'Aleo mainnet-safety gate passed (merge mode): %s declares only `pay` and carries no mint (source + any build artifact). NOTE: placeholder USDCx type intentionally not enforced in merge mode — run with --mode=deploy before any mainnet deploy.\n' "${SRC}"
fi
exit 0
