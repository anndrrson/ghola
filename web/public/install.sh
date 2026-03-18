#!/bin/sh
# ghola CLI installer
# Usage: curl -fsSL https://ghola.xyz/install.sh | sh
set -e

REPO="anndrrson/thumper"
BIN_NAME="ghola"

# Detect OS
OS="$(uname -s)"
case "$OS" in
  Linux)  OS="linux" ;;
  Darwin) OS="macos" ;;
  *)
    echo "Unsupported OS: $OS"
    exit 1
    ;;
esac

# Detect architecture
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64)  ARCH="x86_64" ;;
  aarch64|arm64) ARCH="aarch64" ;;
  *)
    echo "Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

BINARY="${BIN_NAME}-${OS}-${ARCH}"
URL="https://github.com/${REPO}/releases/latest/download/${BINARY}"

echo "ghola CLI installer"
echo "  OS:   $OS"
echo "  Arch: $ARCH"
echo ""

# Try downloading pre-built binary
echo "Downloading ${BIN_NAME} from ${URL}..."
TMPFILE="$(mktemp)"
if curl -fsSL -o "$TMPFILE" "$URL" 2>/dev/null; then
  chmod +x "$TMPFILE"

  # Install to /usr/local/bin or ~/.local/bin
  if [ -w /usr/local/bin ]; then
    mv "$TMPFILE" "/usr/local/bin/${BIN_NAME}"
    echo "Installed to /usr/local/bin/${BIN_NAME}"
  elif sudo -n true 2>/dev/null; then
    sudo mv "$TMPFILE" "/usr/local/bin/${BIN_NAME}"
    echo "Installed to /usr/local/bin/${BIN_NAME}"
  else
    mkdir -p "${HOME}/.local/bin"
    mv "$TMPFILE" "${HOME}/.local/bin/${BIN_NAME}"
    echo "Installed to ${HOME}/.local/bin/${BIN_NAME}"
    case ":$PATH:" in
      *":${HOME}/.local/bin:"*) ;;
      *)
        echo ""
        echo "Add this to your shell profile:"
        echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
        ;;
    esac
  fi

  echo ""
  echo "Run 'ghola up' to start earning."
  exit 0
fi

rm -f "$TMPFILE"

# Fallback: build from source
echo "Pre-built binary not available. Trying cargo install..."

if command -v cargo >/dev/null 2>&1; then
  cargo install thumper-cli --git "https://github.com/${REPO}" --bin ghola
  echo ""
  echo "Run 'ghola up' to start earning."
  exit 0
fi

echo ""
echo "Cargo not found. Install Rust first:"
echo "  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
echo ""
echo "Then re-run this installer, or install directly:"
echo "  cargo install thumper-cli --git https://github.com/${REPO} --bin ghola"
exit 1
