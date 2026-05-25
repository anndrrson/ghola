#!/usr/bin/env bash
set -euo pipefail

backend="${1:-}"
required_symbol="ghola_shielded_pool_prove_to_file"

if [[ -z "$backend" ]]; then
  echo "usage: $0 /absolute/path/libghola_shielded_pool_backend.so" >&2
  exit 64
fi

if [[ ! -f "$backend" ]]; then
  echo "missing backend: $backend" >&2
  exit 66
fi

file_output="$(file "$backend")"
case "$file_output" in
  *ELF*ARM\ aarch64*|*ELF*ARM64*)
    ;;
  *)
    echo "backend is not an ARM64 ELF shared library: $file_output" >&2
    exit 65
    ;;
esac

nm_bin="${NM:-}"
if [[ -z "$nm_bin" ]]; then
  if command -v llvm-nm >/dev/null 2>&1; then
    nm_bin="llvm-nm"
  elif command -v nm >/dev/null 2>&1; then
    nm_bin="nm"
  else
    echo "neither llvm-nm nor nm is available" >&2
    exit 69
  fi
fi

if ! "$nm_bin" -D "$backend" 2>/dev/null | grep -q " ${required_symbol}$"; then
  echo "backend does not export ${required_symbol}" >&2
  exit 65
fi

echo "ok: $backend exports ${required_symbol}"
