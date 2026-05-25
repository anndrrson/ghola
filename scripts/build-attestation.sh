#!/usr/bin/env bash
#
# build-attestation.sh — emit SLSA Provenance v0.2 JSON for an Anchor build.
#
# Stream 8 of the Phase-45 production-hardening pass.
#
# Usage:
#   scripts/build-attestation.sh <program_name>
#
# Example:
#   scripts/build-attestation.sh said_shielded_pool > attestation.json
#
# The script gathers:
#   - git remote URL + commit SHA  (configSource)
#   - cargo / rustc / cargo-build-sbf versions  (materials)
#   - sha256 of Cargo.lock                       (materials)
#   - sha256 of the resolved .so under the program's target/deploy/  (subject)
#
# Output is a single JSON document on stdout conforming to SLSA Provenance
# v0.2 (https://slsa.dev/provenance/v0.2). It is NOT signed — sign it
# downstream with `cosign attest-blob` or the sbom.yml workflow.

set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <program_name>" >&2
  exit 1
fi

PROGRAM="$1"

# Resolve repo root from this script's location (scripts/ lives at repo root).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Anchor convention: program dir uses hyphens (programs/<name-with-hyphens>),
# the built .so uses snake_case. Resolve both.
PROGRAM_DIR="$REPO_ROOT/programs/$PROGRAM"
SNAKE="$(echo "$PROGRAM" | tr '-' '_')"
SO_PATH="$PROGRAM_DIR/target/deploy/$SNAKE.so"
# Common fallback locations:
if [ ! -f "$SO_PATH" ]; then
  for cand in \
    "$REPO_ROOT/target/deploy/$SNAKE.so" \
    "$REPO_ROOT/programs/$SNAKE/target/deploy/$SNAKE.so" \
    "$REPO_ROOT/target/deploy/$PROGRAM.so"; do
    if [ -f "$cand" ]; then
      SO_PATH="$cand"
      break
    fi
  done
fi

if [ ! -f "$SO_PATH" ]; then
  echo "error: built artifact not found at $SO_PATH" >&2
  exit 1
fi

# sha256 helper (Linux sha256sum, macOS shasum).
if command -v sha256sum >/dev/null 2>&1; then
  SHA() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  SHA() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  echo "error: no sha256 binary available" >&2
  exit 1
fi

SO_HASH="$(SHA "$SO_PATH")"
SO_NAME="$(basename "$SO_PATH")"
SO_SIZE="$(wc -c < "$SO_PATH" | tr -d ' ')"

CARGO_LOCK="$REPO_ROOT/Cargo.lock"
LOCK_HASH=""
if [ -f "$CARGO_LOCK" ]; then
  LOCK_HASH="$(SHA "$CARGO_LOCK")"
fi

# Git context. Tolerate detached HEAD and missing remotes.
GIT_COMMIT="$(cd "$REPO_ROOT" && git rev-parse HEAD 2>/dev/null || echo unknown)"
GIT_REMOTE="$(cd "$REPO_ROOT" && git config --get remote.origin.url 2>/dev/null || echo unknown)"
GIT_BRANCH="$(cd "$REPO_ROOT" && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"

# Toolchain versions. Each is captured raw so the verifier can compare
# byte-for-byte against the build environment.
CARGO_VER="$(cargo --version 2>/dev/null || echo unknown)"
RUSTC_VER="$(rustc --version 2>/dev/null || echo unknown)"
# cargo-build-sbf may be at one of two locations depending on which Solana
# toolchain is installed (see docs/shielded-pool/OPERATIONS.md § 3).
SBF_VER="unknown"
if command -v cargo-build-sbf >/dev/null 2>&1; then
  SBF_VER="$(cargo-build-sbf --version 2>/dev/null | head -1 || echo unknown)"
elif [ -x "$HOME/.local/share/solana/install/active_release/bin/cargo-build-sbf" ]; then
  SBF_VER="$($HOME/.local/share/solana/install/active_release/bin/cargo-build-sbf --version 2>/dev/null | head -1 || echo unknown)"
fi
ANCHOR_VER="$(anchor --version 2>/dev/null || echo unknown)"

BUILD_STARTED_ON="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

# Emit canonical-ish JSON. We don't have a JSON canonicalizer in plain
# bash, so we hand-write the structure with strict key ordering and
# escape only what we need (toolchain version strings contain spaces).
esc() {
  # Escape backslash and double-quote for JSON string embedding. Strips
  # any literal newlines (toolchain versions are single-line anyway).
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/ }"
  printf '%s' "$s"
}

cat <<EOF
{
  "_type": "https://in-toto.io/Statement/v0.1",
  "predicateType": "https://slsa.dev/provenance/v0.2",
  "subject": [
    {
      "name": "$(esc "$SO_NAME")",
      "digest": {
        "sha256": "$SO_HASH"
      },
      "annotations": {
        "size": $SO_SIZE
      }
    }
  ],
  "predicate": {
    "builder": {
      "id": "https://github.com/anndrrson/ghola/scripts/build-attestation.sh"
    },
    "buildType": "https://solana.com/build/anchor-build-sbf@v1",
    "invocation": {
      "configSource": {
        "uri": "$(esc "$GIT_REMOTE")",
        "digest": {
          "sha1": "$GIT_COMMIT"
        },
        "entryPoint": "programs/$(esc "$PROGRAM")"
      },
      "parameters": {
        "program": "$(esc "$PROGRAM")",
        "branch": "$(esc "$GIT_BRANCH")"
      },
      "environment": {
        "cargo": "$(esc "$CARGO_VER")",
        "rustc": "$(esc "$RUSTC_VER")",
        "cargo-build-sbf": "$(esc "$SBF_VER")",
        "anchor": "$(esc "$ANCHOR_VER")"
      }
    },
    "metadata": {
      "buildStartedOn": "$BUILD_STARTED_ON",
      "completeness": {
        "parameters": true,
        "environment": true,
        "materials": true
      },
      "reproducible": false
    },
    "materials": [
      {
        "uri": "$(esc "$GIT_REMOTE")",
        "digest": {
          "sha1": "$GIT_COMMIT"
        }
      }$( [ -n "$LOCK_HASH" ] && cat <<MAT
,
      {
        "uri": "git+$(esc "$GIT_REMOTE")#Cargo.lock@$GIT_COMMIT",
        "digest": {
          "sha256": "$LOCK_HASH"
        }
      }
MAT
)
    ]
  }
}
EOF
