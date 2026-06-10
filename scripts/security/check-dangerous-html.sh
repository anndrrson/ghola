#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"

scan_paths=(
  "apps/web/src"
)

pattern='dangerouslySetInnerHTML|[.]innerHTML[[:space:]]*=|[.]outerHTML[[:space:]]*=|insertAdjacentHTML|document[.]write'
matches="$(rg -n "$pattern" "${scan_paths[@]}" || true)"

if [ -z "$matches" ]; then
  echo "[html-sinks] no dangerous HTML sinks found"
  exit 0
fi

filtered="$(
  printf '%s\n' "$matches" |
    grep -v 'dangerouslySetInnerHTML={{ __html: JSON.stringify(orgSchema) }}' |
    grep -v 'dangerouslySetInnerHTML={{ __html: sanitizeHtml(inlineMarkdown(part)) }}' ||
    true
)"

if [ -n "$filtered" ]; then
  {
    echo "[html-sinks] blocked unapproved raw HTML sink(s):"
    printf '%s\n' "$filtered"
    echo ""
    echo "Use text rendering, a typed React tree, or sanitizeHtml(...) with a narrow review."
  } >&2
  exit 1
fi

echo "[html-sinks] approved sinks only"
