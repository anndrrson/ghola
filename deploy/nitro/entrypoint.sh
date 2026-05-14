#!/usr/bin/env bash
# Enclave entrypoint. Starts the byte-tunnel stub + Ollama in the
# background, then execs the provider so that signals propagate cleanly
# (children are reaped when this script exits because the enclave init
# replaces them with PID 1).
#
# Boot order:
#   1. enclave-vsock-client: TCP listener on 127.0.0.1:8443 that
#      tunnels to the host's vsock-proxy. This is the provider's
#      egress path to the relay. Must be up *before* the provider
#      tries its first WS dial.
#   2. Ollama: inference engine on 127.0.0.1:11434.
#   3. Provider (exec): authenticates to the relay, advertises models,
#      sends ProviderAttest, serves sealed inference requests.
set -euo pipefail

# ---- 1. vsock egress stub ----
# Default listen on 127.0.0.1:8443; the provider's RELAY_URL points
# here. Override VSOCK_HOST_CID/VSOCK_HOST_PORT for dev testing.
#
# VSOCK_HOST_CID=3 is the AWS Nitro Enclaves *parent* CID. The
# `tokio-vsock` library's `VMADDR_CID_HOST` constant is 2, which is the
# generic VM-host convention but NOT what Nitro uses for the parent EC2
# instance. We pin to 3 here so the enclave-vsock-client dials the
# correct vsock peer (the host-side vsock-proxy on the m5.xlarge).
export LISTEN_ADDR="${LISTEN_ADDR:-127.0.0.1:8443}"
export VSOCK_HOST_CID="${VSOCK_HOST_CID:-3}"
export VSOCK_HOST_PORT="${VSOCK_HOST_PORT:-8443}"
/usr/local/bin/enclave-vsock-client &
VSOCK_PID=$!

# Give the listener a beat to bind 127.0.0.1:8443 before the provider
# tries to connect. The provider's reconnect loop would recover from a
# transient ECONNREFUSED, but logging a clean boot is nicer.
sleep 1

# ---- 2. Ollama ----
# Ollama needs a writable model cache. The enclave gives us an empty
# tmpfs at /var/lib/ollama; bake models in via `ollama pull` during
# the image build if cold-start latency matters.
#
# Ollama also reads $HOME at startup to locate its config dir. The
# enclave init doesn't set HOME, so we have to or Ollama exits with
# "Error: $HOME is not defined" before binding 127.0.0.1:11434.
export HOME="${HOME:-/var/lib/ollama}"
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

# ---- 3. Provider ----
# Hand off to the provider. `exec` so PID 1 inside the enclave init
# tree is the provider — when it dies, the enclave dies, and ops sees
# the failure cleanly in nitro-cli describe-enclaves.
#
# Sanity log of children (debug only — these PIDs don't leak outside
# the enclave so it's safe to print).
echo "==> enclave-vsock-client pid=${VSOCK_PID}, ollama pid=${OLLAMA_PID}"
exec /usr/local/bin/thumper-gpu-provider
