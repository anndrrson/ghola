#!/usr/bin/env bash
# Enclave entrypoint. Starts Ollama in the background, then execs the
# provider so that signals propagate cleanly (Ollama is killed when
# this script exits because the enclave init reaps it).
set -euo pipefail

# Ollama needs a writable model cache. The enclave gives us an empty
# tmpfs at /var/lib/ollama; bake models in via `ollama pull` during
# the image build if cold-start latency matters.
export OLLAMA_HOST="${OLLAMA_HOST:-127.0.0.1:11434}"
export OLLAMA_MODELS="${OLLAMA_MODELS:-/var/lib/ollama}"
mkdir -p "${OLLAMA_MODELS}"

# Launch Ollama in the background. Logs go to the same fd as us so
# nitro-cli captures the full stream.
/usr/local/bin/ollama serve &
OLLAMA_PID=$!

# Give Ollama a couple of seconds to bind 11434. The provider has its
# own retry loop, so we don't need a strict readiness check.
sleep 2

# Hand off to the provider. `exec` so PID 1 inside the enclave init
# tree is the provider — when it dies, the enclave dies, and ops sees
# the failure cleanly in nitro-cli describe-enclaves.
exec /usr/local/bin/thumper-gpu-provider
