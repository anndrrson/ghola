#!/usr/bin/env bash
# Host bootstrap script. Runs once on first boot via cloud-init.
#
# Variables substituted by Terraform's templatefile():
#   ${eif_s3_uri}  — s3://bucket/key.eif
#   ${aws_region}  — used by aws cli + ssm calls
#   ${relay_host}  — DNS name of the relay (vsock-proxy dials this)
#   ${relay_port}  — TCP port (default 443)
#
# What this script does:
#   1. Installs nitro-cli + jq + aws-cli.
#   2. Reserves 2 vCPUs + 4096 MiB for enclaves and starts the
#      nitro-enclaves-allocator service.
#   3. Pulls the EIF + vsock-proxy binary from S3.
#   4. Fetches the provider auth key + allowlist sig from SSM and
#      stages them under /opt/ghola/env/.
#   5. Installs and enables the ghola-vsock-proxy.service AND
#      ghola-provider.service systemd units. The provider service
#      requires-and-after vsock-proxy so the enclave's egress path is
#      live before the enclave boots.
#
# Phase 1 of the v3.5 privacy rollout (May 2026): the enclave is launched
# *without* `--debug-mode` and *without* `--attach-console`. The
# previous user-data baked in --attach-console for ops convenience; that
# tainted the PCR0/PCR1/PCR2 measurements and made attestation
# meaningless. We now launch in production mode unconditionally and
# rely on the vsock-proxy + relay logs for observability.
set -euo pipefail

exec > >(tee -a /var/log/ghola-bootstrap.log) 2>&1
echo "==> ghola bootstrap starting at $(date -u +%FT%TZ)"

# ---- 1. Packages ----
dnf -y update
dnf -y install aws-nitro-enclaves-cli aws-nitro-enclaves-cli-devel jq awscli

usermod -aG ne ec2-user || true
usermod -aG docker ec2-user || true

# ---- 2. Enclave allocator ----
# Reserve 2 vCPUs and 4096 MiB. The m5.xlarge has 4 vCPUs total, so we
# leave 2 for the host (one for the vsock-proxy, one for housekeeping).
sed -i 's/^cpu_count:.*/cpu_count: 2/'    /etc/nitro_enclaves/allocator.yaml
sed -i 's/^memory_mib:.*/memory_mib: 4096/' /etc/nitro_enclaves/allocator.yaml

systemctl enable --now nitro-enclaves-allocator.service

# ---- 3. EIF + vsock-proxy binary ----
install -d -m 0755 /opt/ghola /opt/ghola/bin /opt/ghola/eif
aws s3 cp "${eif_s3_uri}" /opt/ghola/eif/ghola-provider.eif --region "${aws_region}"

# The vsock-proxy binary ships alongside the EIF. By convention the
# operator uploads `s3://<bucket>/ghola-vsock-proxy` to the same bucket;
# the URI is derived from $${eif_s3_uri} by replacing the basename.
EIF_BUCKET_PATH="$(dirname "${eif_s3_uri}")"
aws s3 cp "$${EIF_BUCKET_PATH}/ghola-vsock-proxy" /opt/ghola/bin/vsock-proxy --region "${aws_region}"
chmod 0755 /opt/ghola/bin/vsock-proxy

# ---- 4. Secrets via SSM ----
install -d -m 0700 /opt/ghola/env

aws ssm get-parameter \
    --name /ghola/provider/auth-key \
    --with-decryption \
    --region "${aws_region}" \
    --query 'Parameter.Value' \
    --output text > /opt/ghola/env/PROVIDER_AUTH_KEY
chmod 0600 /opt/ghola/env/PROVIDER_AUTH_KEY

aws ssm get-parameter \
    --name /ghola/provider/allowlist-sig \
    --with-decryption \
    --region "${aws_region}" \
    --query 'Parameter.Value' \
    --output text > /opt/ghola/env/ALLOWLIST_SIG_B64
chmod 0600 /opt/ghola/env/ALLOWLIST_SIG_B64

# ---- 5. systemd: vsock-proxy ----
# Runs on the host, listens on vsock, dials the relay over TCP/443.
# The provider inside the enclave terminates its rustls session at the
# relay (SNI=${relay_host}) — the bytes through here are ciphertext.
cat > /etc/systemd/system/ghola-vsock-proxy.service <<EOF
[Unit]
Description=Ghola vsock<->TCP egress for the Nitro enclave
After=nitro-enclaves-allocator.service network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=RELAY_HOST=${relay_host}
Environment=RELAY_PORT=${relay_port}
Environment=VSOCK_LISTEN_PORT=8443
Environment=RUST_LOG=info
ExecStart=/opt/ghola/bin/vsock-proxy
Restart=always
RestartSec=2
User=root
# Hardening: this process touches no FS state and only opens vsock +
# outbound TCP. Lock the rest down.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_VSOCK

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now ghola-vsock-proxy.service

# ---- 6. systemd: enclave runner ----
# Production launch: NO --debug-mode, NO --attach-console. Either would
# perturb the EIF measurement (PCRs) and make attestation worthless.
# Ops observability comes from the vsock-proxy + relay logs.
cat > /usr/local/bin/ghola-run-enclave.sh <<'WRAP'
#!/usr/bin/env bash
set -euo pipefail

# Tear down any stale enclave from a previous boot.
for eid in $(nitro-cli describe-enclaves | jq -r '.[].EnclaveID // empty'); do
    nitro-cli terminate-enclave --enclave-id "$eid" || true
done

# Non-debug, non-console launch. CID is fixed (16) so the in-enclave
# stub knows where to dial back to the host vsock-proxy (CID=3, which
# is VMADDR_CID_HOST and is constant for the parent).
exec nitro-cli run-enclave \
    --eif-path /opt/ghola/eif/ghola-provider.eif \
    --cpu-count 2 \
    --memory 4096 \
    --enclave-cid 16
WRAP
chmod 0755 /usr/local/bin/ghola-run-enclave.sh

cat > /etc/systemd/system/ghola-provider.service <<'EOF'
[Unit]
Description=Ghola provider Nitro enclave (production, non-debug)
After=ghola-vsock-proxy.service
Requires=ghola-vsock-proxy.service

[Service]
Type=simple
ExecStart=/usr/local/bin/ghola-run-enclave.sh
Restart=always
RestartSec=5
# nitro-cli needs root.
User=root

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now ghola-provider.service

echo "==> ghola bootstrap complete at $(date -u +%FT%TZ)"
