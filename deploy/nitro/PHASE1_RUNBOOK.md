# Ghola v3.5 Phase 1 — Production Launch Runbook

This runbook walks through the first production launch with the new
Phase 1 pieces in place: KMS-signed EIF measurements, vsock-only
egress, and non-DEBUG enclaves. Time budget: ~90 minutes end-to-end if
nothing is on fire.

## What changed

| Piece                  | Before                                   | After                                                                |
| ---------------------- | ---------------------------------------- | -------------------------------------------------------------------- |
| Enclave egress         | Native EC2 networking (host MITM-capable) | `enclave-vsock-client` → vsock → `vsock-proxy` on host → relay      |
| TLS termination        | Provider rustls to relay                  | Same, but SNI overridden to `ghola-relay.onrender.com` for loopback |
| Enclave launch flags   | `--debug-mode --attach-console` (taints PCRs) | Neither flag (clean PCRs)                                           |
| Measurement signing    | Offline Ed25519 only                      | Ed25519 + KMS-anchored ECDSA P-384                                  |
| Verifier               | `said-attest::verify_attestation`         | `said-attest::verify_attestation_with_kms`                          |

## Prerequisites

  - AWS account with:
      - Build IAM role/user ARN that will own `kms:Sign` (NOT the EC2
        instance role)
      - S3 bucket for EIF + vsock-proxy artifacts
      - Existing SSM SecureString params `/ghola/provider/auth-key` and
        `/ghola/provider/allowlist-sig`
  - Docker + nitro-cli on a Linux build machine (or AL2023 EC2 with
    `aws-nitro-enclaves-cli` installed; macOS hosts won't work)
  - `aws` CLI with credentials for the build role
  - `terraform` ≥ 1.5

## Step 1 — Provision the KMS signing key

```bash
cd deploy/terraform
terraform init
terraform apply \
  -var="eif_s3_uri=s3://PLACEHOLDER" \
  -var="kms_build_role_arn=arn:aws:iam::ACCOUNT_ID:role/your-build-role" \
  -var="kms_admin_arns=[\"arn:aws:iam::ACCOUNT_ID:role/your-admin-role\"]" \
  -target=aws_kms_key.eif_measurement[0] \
  -target=aws_kms_alias.eif_measurement[0]
```

Capture the outputs:

```bash
KMS_KEY_ID=$(terraform output -raw eif_measurement_key_arn)
terraform output -raw eif_measurement_public_key_pem > /tmp/ghola-kms-pub.pem
```

Stash `/tmp/ghola-kms-pub.pem` somewhere safe — the relay will pin
this PEM as `GHOLA_KMS_MEASUREMENT_PUBKEY_PEM`.

## Step 2 — Build the host-side vsock-proxy binary

The host runs the `vsock-proxy` binary outside the enclave. Build it
on an x86_64 Linux machine (AL2023 ideally, for libc compat):

```bash
cd deploy/nitro/vsock-proxy
cargo build --release --target x86_64-unknown-linux-gnu --bin vsock-proxy
aws s3 cp target/x86_64-unknown-linux-gnu/release/vsock-proxy \
    "s3://ghola-eifs/ghola-vsock-proxy"
```

The user-data script expects this artifact at
`s3://<eif-bucket>/ghola-vsock-proxy` (same bucket as the EIF).

## Step 3 — Build the EIF

```bash
cd /path/to/ghola
export KMS_KEY_ID="$KMS_KEY_ID"
./deploy/nitro/build-eif.sh
```

Outputs:

  - `build/ghola-provider.eif`
  - `deploy/nitro/measurements/<git-sha>.json` (records PCRs, KMS sig
    file path, sig algorithm, sig digest input)
  - `deploy/nitro/measurements/<git-sha>.kms.sig` (raw DER)
  - `deploy/nitro/measurements/<git-sha>.kms.sig.b64` (clipboard mirror)

Verify the KMS sig locally before deploying:

```bash
# Sanity: re-verify the KMS signature against the public key.
openssl dgst -sha384 -verify /tmp/ghola-kms-pub.pem \
    -signature deploy/nitro/measurements/<git-sha>.kms.sig \
    <(printf '%s%s%s' "$PCR0" "$PCR1" "$PCR2" | xxd -r -p)
# → "Verified OK"
```

## Step 4 — Sign the allowlist (existing flow, unchanged)

```bash
./deploy/nitro/sign-allowlist.sh "$MEASUREMENT_DIGEST" \
    /path/to/ghola-attest-signing.key
```

Push the resulting base64 sig to SSM:

```bash
aws ssm put-parameter \
    --name /ghola/provider/allowlist-sig \
    --value "$ALLOWLIST_SIG_B64" \
    --type SecureString \
    --overwrite
```

## Step 5 — Upload the EIF + vsock-proxy to S3

```bash
aws s3 cp build/ghola-provider.eif "s3://ghola-eifs/ghola-provider-<sha>.eif"
# vsock-proxy was already uploaded in Step 2.
```

## Step 6 — Apply Terraform

```bash
cd deploy/terraform
terraform apply \
    -var="eif_s3_uri=s3://ghola-eifs/ghola-provider-<sha>.eif" \
    -var="kms_build_role_arn=arn:aws:iam::ACCOUNT_ID:role/your-build-role" \
    -var="relay_host=ghola-relay.onrender.com"
```

Watch the host come up. `terraform output public_ip` gives the IP for
SSH (if `ops_ssh_cidr` is set).

## Step 7 — Verify on the host

SSH in (if enabled) and check:

```bash
# vsock-proxy listening
sudo journalctl -u ghola-vsock-proxy.service -n 20
sudo ss -lpn | grep 8443

# enclave running
nitro-cli describe-enclaves
# → expect a single entry with "Flags": "NONE" (NOT "DEBUG_MODE")

# enclave logs are NOT visible via --attach-console (intentional). All
# observability is via the relay + vsock-proxy logs.
sudo journalctl -u ghola-provider.service -n 50
```

## Step 8 — Verify on the relay

Once the provider connects, the relay logs should show:

```
gpu_provider authenticated
ProviderAdvertise accepted
ProviderAttest verified: vendor=OK, allowlist=OK, kms=OK, tee_kind=Nitro
```

Hit `/health` on the relay — `gpu_providers` count should be ≥ 1.

## Rollback

If anything fails:

  1. `terraform destroy` (or just `terraform apply` with the previous
     `eif_s3_uri`).
  2. The Phase-0 EIF (sha = c07fe3f) still works without any of the new
     env vars (`RELAY_SNI_OVERRIDE` unset → falls back to URL host
     SNI, vsock-proxy absent → provider can't reach relay → enclave
     fails fast).

For an in-place patch without re-applying Terraform, manually SSH to
the host, replace `/opt/ghola/eif/ghola-provider.eif` with the
previous version, and `systemctl restart ghola-provider.service`.

## Known caveats

  - **No console for ops.** Removing `--attach-console` is the price of
    a clean PCR0. Diagnose via relay logs and vsock-proxy logs only.
  - **vsock-proxy is a single point of failure.** It's a single
    process on a single EC2 instance. systemd `Restart=always` covers
    crashes, but a kernel-level network hang would isolate the
    enclave from the relay. Phase 2 will add a heartbeat probe.
  - **KMS key rotation requires re-signing every active EIF.** AWS
    does not support automatic rotation on asymmetric keys. Plan a
    quarterly rotation window with all-hands.
  - **`relay_host` must match the relay's TLS cert subject.** If
    Render renames the service, both `relay_host` (Terraform var) and
    `RELAY_SNI_OVERRIDE` (Dockerfile.nitro ENV) must be updated and
    the EIF rebuilt (PCRs will change).
