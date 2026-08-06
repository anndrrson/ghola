#!/usr/bin/env bash
# Verify that two independent builds at the same source SHA produce
# byte-identical SRI manifests. This is the test that proves the
# Tier 1C reproducible-build claim — without it, the manifest at
# /.well-known/sri-manifest.json is auditable but not reproducible
# from source, and a reviewer cannot recover the deployed bundle by
# rebuilding.
#
# The build is deterministic because next.config.ts pins
# `generateBuildId` to `git rev-parse HEAD` (or the GIT_COMMIT env
# var, when CI provides one). Any other source of non-determinism
# that creeps in — random IDs, build timestamps in JS, asset
# ordering — will surface as a manifest_sha256 diff here.
#
# Run from apps/web:
#   ./scripts/verify-reproducible-build.sh
#
# Exits 0 on match, 1 on mismatch. Intended to run in CI on every
# PR that touches build config.

set -euo pipefail

cd "$(dirname "$0")/.."

build_and_capture() {
  local label="$1"
  # Diagnostics go to stderr so they don't leak into the captured hash
  # when the caller uses $(build_and_capture "x"). Only the final echo
  # — the bare hash — lands on stdout.
  echo "[$label] building…" >&2
  rm -rf .next public/.well-known/sri-manifest.json
  npm run build > "/tmp/repro-build-${label}.log" 2>&1
  local hash
  hash=$(jq -r '.manifest_sha256' public/.well-known/sri-manifest.json)
  echo "[$label] manifest_sha256: $hash" >&2
  echo "$hash"
}

h1=$(build_and_capture "first")
cp public/.well-known/sri-manifest.json /tmp/repro-manifest-first.json

h2=$(build_and_capture "second")
cp public/.well-known/sri-manifest.json /tmp/repro-manifest-second.json

if [ "$h1" = "$h2" ]; then
  echo ""
  echo "PASS — both builds produced manifest_sha256=$h1"
  exit 0
fi

echo ""
echo "FAIL — manifest hashes differ between builds:"
echo "  first:  $h1"
echo "  second: $h2"
echo ""
echo "Per-file diff:"
jq -r '.files[] | "\(.path)\t\(.sha256)"' /tmp/repro-manifest-first.json | sort > /tmp/repro-first.txt
jq -r '.files[] | "\(.path)\t\(.sha256)"' /tmp/repro-manifest-second.json | sort > /tmp/repro-second.txt
diff /tmp/repro-first.txt /tmp/repro-second.txt || true
exit 1
