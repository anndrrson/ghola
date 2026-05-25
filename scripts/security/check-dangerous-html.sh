#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

# Prefer ripgrep; fall back to grep so the check works on runners /
# workstations without `rg` installed.
if command -v rg >/dev/null 2>&1; then
  matches="$(rg -n "dangerouslySetInnerHTML" apps/web/src -g"*.ts" -g"*.tsx" || true)"
else
  matches="$(grep -rn "dangerouslySetInnerHTML" apps/web/src \
    --include="*.ts" --include="*.tsx" || true)"
fi

if [ -z "${matches}" ]; then
  exit 0
fi

# Files allowed to use dangerouslySetInnerHTML. Each MUST either:
#   - render only first-party, non-user-controlled content (e.g. a
#     JSON-LD <script> built from a static object), OR
#   - sanitize its input through DOMPurify before injection.
# The DOMPurify requirement is enforced below for every allowlisted
# file that is NOT in DOMPURIFY_EXEMPT.
allowlist=(
  # JSON-LD Organization schema injected from a static, code-defined
  # object — no user/LLM-controlled content reaches this sink.
  "apps/web/src/app/page.tsx"
  # Renders assistant/markdown output, but only after
  # DOMPurify.sanitize() with a tight tag/attr allowlist.
  "apps/web/src/components/chat/ChatMessages.tsx"
)

# Allowlisted files that legitimately do NOT need DOMPurify because the
# injected content is fully static / first-party (no untrusted input).
dompurify_exempt=(
  "apps/web/src/app/page.tsx"
)

in_list() {
  local needle="$1"; shift
  local item
  for item in "$@"; do
    [ "${item}" = "${needle}" ] && return 0
  done
  return 1
}

violations=""
while IFS= read -r line; do
  [ -z "${line}" ] && continue
  file="${line%%:*}"
  if ! in_list "${file}" "${allowlist[@]}"; then
    violations+="${line}"$'\n'
  fi
done <<< "${matches}"

if [ -n "${violations}" ]; then
  echo "Forbidden dangerouslySetInnerHTML usage detected:"
  printf "%s" "${violations}"
  echo "Allowed files:"
  printf '  %s\n' "${allowlist[@]}"
  echo
  echo "If a new sink is legitimate, sanitize its input via DOMPurify and"
  echo "add the file to the allowlist in scripts/security/check-dangerous-html.sh."
  exit 1
fi

# Every allowlisted file that injects potentially untrusted content MUST
# import/use DOMPurify. This catches a future refactor that removes the
# sanitizer while keeping the dangerous sink.
missing_sanitizer=""
for file in "${allowlist[@]}"; do
  in_list "${file}" "${dompurify_exempt[@]}" && continue
  [ -f "${file}" ] || continue
  # Require BOTH a DOMPurify import AND a .sanitize() call so that
  # renaming the call (while keeping the import) or dropping the import
  # (while keeping a same-named helper) both trip the gate.
  if ! grep -Eqi "from ['\"]dompurify['\"]|require\(['\"]dompurify['\"]\)" "${file}" \
     || ! grep -Eq "\.sanitize\(" "${file}"; then
    missing_sanitizer+="  ${file}"$'\n'
  fi
done

if [ -n "${missing_sanitizer}" ]; then
  echo "Allowlisted dangerouslySetInnerHTML file(s) no longer sanitize via DOMPurify:"
  printf "%s" "${missing_sanitizer}"
  echo "Restore DOMPurify.sanitize() on the injected content, or move the file"
  echo "to dompurify_exempt only if its content is fully static/first-party."
  exit 1
fi
