#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="aarch64-linux-android"
android_api="${ANDROID_API:-28}"

find_ndk() {
  if [[ -n "${ANDROID_NDK_HOME:-}" && -d "${ANDROID_NDK_HOME}" ]]; then
    printf '%s\n' "${ANDROID_NDK_HOME}"
    return 0
  fi
  if [[ -n "${ANDROID_NDK_ROOT:-}" && -d "${ANDROID_NDK_ROOT}" ]]; then
    printf '%s\n' "${ANDROID_NDK_ROOT}"
    return 0
  fi
  local sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
  if [[ -d "$sdk/ndk" ]]; then
    find "$sdk/ndk" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -n 1
    return 0
  fi
  return 1
}

ndk="$(find_ndk || true)"
if [[ -z "$ndk" || ! -d "$ndk" ]]; then
  echo "Android NDK not found. Set ANDROID_NDK_HOME or install the Android NDK." >&2
  exit 66
fi

case "$(uname -s)" in
  Darwin)
    if [[ -d "$ndk/toolchains/llvm/prebuilt/darwin-aarch64" ]]; then
      host_tag="darwin-aarch64"
    else
      host_tag="darwin-x86_64"
    fi
    ;;
  Linux)
    host_tag="linux-x86_64"
    ;;
  *)
    echo "unsupported host OS for Android NDK toolchain: $(uname -s)" >&2
    exit 65
    ;;
esac

toolchain="$ndk/toolchains/llvm/prebuilt/$host_tag"
clang="$toolchain/bin/aarch64-linux-android${android_api}-clang"
llvm_ar="$toolchain/bin/llvm-ar"
llvm_nm="$toolchain/bin/llvm-nm"

if [[ ! -x "$clang" ]]; then
  echo "missing Android clang linker: $clang" >&2
  exit 66
fi

rustup target add "$target" >/dev/null

ANDROID_NDK_HOME="$ndk" \
CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$clang" \
CC_aarch64_linux_android="$clang" \
AR_aarch64_linux_android="$llvm_ar" \
  cargo build \
    --manifest-path "$repo_root/Cargo.toml" \
    -p ghola-shielded-pool-mobile-backend \
    --features mobile-arkworks \
    --target "$target" \
    --release

backend="$repo_root/target/$target/release/libghola_shielded_pool_backend.so"
NM="$llvm_nm" "$repo_root/scripts/security/verify-android-shielded-pool-backend.sh" "$backend"
echo "$backend"
