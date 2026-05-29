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

# ---- -1. Pull per-deploy envs from the host over vsock ----
# Nitro enclaves do not inherit parent env (no --env flag on
# `nitro-cli run-enclave`). We pull PROVIDER_AUTH_KEY and
# ALLOWLIST_SIG_B64 from the host's vsock-env-server (default
# vsock://3:8444). The contents are non-secret (a sig + a per-deploy
# provider seed); attack surface is the host filesystem +
# vsock isolation.
echo "==> fetching envs from host via vsock-env-server"
if /usr/local/bin/vsock-env-client > /tmp/enclave-env.sh 2> /tmp/vsock-env-client.err; then
    fetched=$(grep -c '^export ' /tmp/enclave-env.sh 2>/dev/null || echo 0)
    echo "==> vsock-env-client returned $fetched env var(s)"
    # shellcheck disable=SC1091
    . /tmp/enclave-env.sh
else
    echo "==> WARNING: vsock-env-client failed; envs will be empty"
    cat /tmp/vsock-env-client.err 2>/dev/null || true
fi

# ---- 0. Bring up loopback interface ----
# linuxkit's init does NOT bring up `lo` by default. Without it,
# bind(127.0.0.1) succeeds (kernel takes the IP) but connect(127.0.0.1)
# from a sibling process gets ECONNREFUSED — the kernel won't route to
# a down interface. Symptom we hit on the first non-debug launch:
# enclave-vsock-client logged "TCP listener bound" then the provider's
# `tcp connect 127.0.0.1:8443` failed forever with no "accepted TCP
# conn" log on the vsock-client side (accept() never returned because
# no connection ever reached the listener).
echo "==> bringing up lo interface"
ip link set lo up 2>&1 || /sbin/ip link set lo up 2>&1 || true
ip addr show lo 2>&1 | head -3 || true

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
if kill -0 "${VSOCK_PID}" 2>/dev/null; then
    echo "==> enclave-vsock-client alive after 1s (pid ${VSOCK_PID})"
else
    echo "==> WARNING: enclave-vsock-client dead after 1s (pid ${VSOCK_PID})"
fi

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
# Run the provider in the background and `wait` so this entrypoint
# stays alive as the parent of all three children (vsock-client,
# ollama, provider). The earlier `exec provider` pattern caused
# enclave-vsock-client to stop processing connections immediately
# after `exec` — bash's PID got reused by the provider, and the
# vsock-client's accept loop went silent (TCP listener bound but no
# subsequent "accepted TCP conn" logs, observed via nitro-cli
# console). Keeping bash alive as the parent restores normal
# child-process management.
#
# When provider exits we exit too, and the enclave init tears the
# whole tree down — same semantics as `exec`, just with bash still
# in the chain to manage the children.
echo "==> enclave-vsock-client pid=${VSOCK_PID}, ollama pid=${OLLAMA_PID}"
/usr/local/bin/ghola-gpu-provider &
PROVIDER_PID=$!

# Propagate SIGTERM (nitro-cli terminate-enclave) to children cleanly.
trap 'kill -TERM "${VSOCK_PID}" "${OLLAMA_PID}" "${PROVIDER_PID}" 2>/dev/null; wait' TERM INT

wait "${PROVIDER_PID}"
