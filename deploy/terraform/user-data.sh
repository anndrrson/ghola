#!/usr/bin/env bash
# Host bootstrap script. Runs once on first boot via cloud-init.
#
# Variables substituted by Terraform's templatefile():
#   ${eif_s3_uri}  — s3://bucket/key.eif
#   ${aws_region}  — used by aws cli + ssm calls
#
# What this script does:
#   1. Installs nitro-cli + jq + aws-cli.
#   2. Reserves 2 vCPUs + 4096 MiB for enclaves and starts the
#      nitro-enclaves-allocator service.
#   3. Pulls the EIF from S3.
#   4. Fetches the provider auth key + allowlist sig from SSM and
#      stages them under /opt/ghola/env/.
#   5. Installs and enables the ghola-provider.service systemd unit
#      that runs `nitro-cli run-enclave`.
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
# leave 2 for the host (one for the WS bridge daemon nitro-cli forks,
# one for housekeeping).
sed -i 's/^cpu_count:.*/cpu_count: 2/'    /etc/nitro_enclaves/allocator.yaml
sed -i 's/^memory_mib:.*/memory_mib: 4096/' /etc/nitro_enclaves/allocator.yaml

systemctl enable --now nitro-enclaves-allocator.service

# ---- 3. EIF ----
install -d -m 0755 /opt/ghola
aws s3 cp "${eif_s3_uri}" /opt/ghola/ghola-provider.eif --region "${aws_region}"

# ---- 4. Secrets via SSM ----
# Both parameters are SecureString; --with-decryption decrypts via the
# AWS-managed SSM KMS key (or your CMK if the SSM policy was updated).
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

# ---- 5. systemd unit ----
# Note: nitro-cli run-enclave needs the secrets passed in as
# environment variables of the *enclave*, not the host. We do this by
# rendering a `--env-file` for nitro-cli describe-eif-options or by
# baking values into the image. Today we go with the env-file path —
# see the wrapper script below.
cat > /usr/local/bin/ghola-run-enclave.sh <<'WRAP'
#!/usr/bin/env bash
set -euo pipefail

# Read secrets from disk into env vars for the wrapper. nitro-cli
# itself doesn't accept --env yet (as of nitro-cli 1.3), so we publish
# values via the host->enclave vsock socat side-channel started by
# /opt/ghola/bin/vsock-env.sh — keeping this comment in the runbook so
# the next op understands the architecture without re-reading the docs.
PROVIDER_AUTH_KEY="$(cat /opt/ghola/env/PROVIDER_AUTH_KEY)"
ALLOWLIST_SIG_B64="$(cat /opt/ghola/env/ALLOWLIST_SIG_B64)"
export PROVIDER_AUTH_KEY ALLOWLIST_SIG_B64

# Tear down any stale enclave from a previous boot.
for eid in $(nitro-cli describe-enclaves | jq -r '.[].EnclaveID // empty'); do
    nitro-cli terminate-enclave --enclave-id "$eid" || true
done

exec nitro-cli run-enclave \
    --eif-path /opt/ghola/ghola-provider.eif \
    --cpu-count 2 \
    --memory 4096 \
    --enclave-cid 16 \
    --attach-console
WRAP
chmod 0755 /usr/local/bin/ghola-run-enclave.sh

cat > /etc/systemd/system/ghola-provider.service <<EOF
[Unit]
Description=Ghola provider Nitro enclave
After=nitro-enclaves-allocator.service network-online.target
Wants=network-online.target

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
