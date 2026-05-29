# Ghola v3.5 — Production Rollout Runbook

Cheat sheet for going from "code merged on `main`, nothing deployed"
to "Private mode in `ghola.xyz/chat` actually shows
`tee_kind: nitro`". Each step lists a command/action, the success
signal, the failure signal, and the rollback action.

Companion docs:
- [`CUSTODY.md`](./CUSTODY.md) — who can use the signing keys
- [`nitro/PHASE1_RUNBOOK.md`](./nitro/PHASE1_RUNBOOK.md) — deeper Phase 1 detail
- [`runbook.md`](./runbook.md) — long-form v2 ops manual

A scripted subset of the steps below lives in
[`v35-rollout.sh`](./v35-rollout.sh).

---

## Step 1 — Confirm `ghola-cloud` builds clean from `main`

**Command.**
```bash
cd /path/to/ghola && cargo build -p ghola-cloud
```

**Success.** Build finishes with `Finished` and no warnings about
unresolved imports.

**Failure.** Compile errors — Agent A's PR did not land, or `main`
regressed. Do not proceed; the relay → cloud `/v1/did-set` push will
404 at runtime.

**Rollback.** `git revert <bad-merge-sha>` on `main` or wait for Agent
A's fix to land. No infra state changes yet, so no infra rollback
needed.

---

## Step 2 — Mint the OHTTP gateway keypair

**Command.**
```bash
cargo run -p ghola-relay --bin ghola-relay -- generate-ohttp-key \
    > ohttp.key.env
chmod 600 ohttp.key.env
```

The subcommand prints three lines:
- `GHOLA_OHTTP_KEY_SECRET_HEX=...` (private half)
- `GHOLA_OHTTP_KEY_PUBLIC_HEX=...` (public half)
- `GHOLA_OHTTP_KEYCONFIG_HEX=...` (RFC 9458 keyconfig)

**Success.** Three non-empty hex lines in `ohttp.key.env`.

**Failure.** Subcommand panics or doesn't exist (binary built before
the OHTTP feature landed). Verify `crates/ghola-relay/src/main.rs`
has the `generate-ohttp-key` arm; rebuild.

**Rollback.** `rm ohttp.key.env`. No deployed state touched.

---

## Step 3 — Set Render envs on `ghola-relay`

Open the Render dashboard → `ghola-relay` service → Environment.
Add / update:

| Key | Value source |
|---|---|
| `GHOLA_OHTTP_KEY_SECRET_HEX` | the secret line from Step 2 |
| `GHOLA_OHTTP_KEY_ID` | `1` (increment only on key rotation) |
| `GHOLA_CLOUD_DID_SET_URL` | `https://thumper-cloud.onrender.com/v1/did-set` |
| `GHOLA_CLOUD_RELAY_API_KEY` | 32+ random bytes; same value as Step 4 |
| `GHOLA_KMS_MEASUREMENT_PUBKEY_PEM` | placeholder for now; populated in Step 6 |

**Success.** Render redeploys the relay; `/health` returns 200 and
its log line `OHTTP gateway enabled (key id = 1)` appears (instead
of the previous "disabled" warning).

**Failure.** `OHTTP gateway disabled — set GHOLA_OHTTP_KEY_SECRET_HEX`
still appears in logs → env wasn't saved or pasted with a stray newline.

**Rollback.** Delete the four new env vars; Render redeploys; the
relay returns to non-OHTTP behaviour and the `/inference/sealed`
non-OHTTP path keeps working.

---

## Step 4 — Set Render envs on `ghola-cloud`

Render dashboard → `ghola-cloud` → Environment.

| Key | Value source |
|---|---|
| `GHOLA_CLOUD_RELAY_API_KEY` | identical to the value set in Step 3 |

**Success.** Cloud redeploys; subsequent calls to
`POST /v1/did-set` with the matching API key in
`x-relay-api-key` return 200. The relay's
`did_set` refresh task starts logging successful refreshes.

**Failure.** Cloud logs `GHOLA_CLOUD_RELAY_API_KEY unset; refusing
/v1/did-set` → env wasn't saved. Cloud returns 500 on the route.

**Rollback.** Delete the env; the did_set refresh task on the relay
gracefully no-ops with a warning.

---

## Step 5 — `terraform apply` the KMS signing key

**Command.**
```bash
cd deploy/terraform
terraform init
terraform apply \
    -var="eif_s3_uri=s3://ghola-eifs/PLACEHOLDER" \
    -var="kms_build_role_arn=arn:aws:iam::<ACCOUNT_ID>:role/<build-role>" \
    -var='kms_admin_arns=["arn:aws:iam::<ACCOUNT_ID>:role/<admin-role>"]' \
    -target=aws_kms_key.eif_measurement \
    -target=aws_kms_alias.eif_measurement
```

Then capture outputs:
```bash
terraform output -raw eif_measurement_key_arn > /tmp/ghola-kms-arn.txt
terraform output -raw eif_measurement_public_key_pem > /tmp/ghola-kms-pub.pem
```

**Success.** `terraform apply` reports two resources added, and the
two `/tmp` files contain a valid ARN and a PEM beginning with
`-----BEGIN PUBLIC KEY-----`.

**Failure.** `AccessDenied` on `kms:CreateKey` — your local AWS creds
are not the admin role. `InvalidArnException` — the
`kms_build_role_arn` is wrong; double-check `aws sts get-caller-identity`.

**Rollback.** `terraform destroy -target=aws_kms_alias.eif_measurement
-target=aws_kms_key.eif_measurement`. NB the key enters the 30-day
deletion window, not instant deletion.

---

## Step 6 — Wire the KMS pubkey into the relay

In the Render dashboard, set on `ghola-relay`:

| Key | Value source |
|---|---|
| `GHOLA_KMS_MEASUREMENT_PUBKEY_PEM` | full contents of `/tmp/ghola-kms-pub.pem` from Step 5 (preserve newlines) |

**Success.** Relay redeploys; the verifier path now activates
`said-attest::verify_attestation_with_kms` and the log line
`KMS measurement pubkey loaded (P-384)` appears at boot.

**Failure.** `failed to parse PEM` at boot → newlines collapsed
during paste. Use Render's multi-line env entry or the `aws ssm
put-parameter` path.

**Rollback.** Delete the env; relay falls back to allowlist-only
verification (Phase 0 behaviour). No outage.

---

## Step 7 — Build the EIF with KMS signature

**Command.** On an x86_64 Linux build host:
```bash
export KMS_KEY_ID="$(cat /tmp/ghola-kms-arn.txt)"
./deploy/nitro/build-eif.sh
```

**Success.** The script prints `==> wrote
deploy/nitro/measurements/<git-sha>.kms.sig (NN bytes DER)`. The
file exists and is between 60–144 bytes (DER P-384 sig length).

**Failure.** `aws kms sign` returns `AccessDeniedException` →
caller is not the build role. `nitro-cli build-enclave` fails →
Docker daemon down or insufficient disk; the script aborts before
the KMS step.

**Rollback.** Delete `build/ghola-provider.eif` and the new
`measurements/<git-sha>.*` files. Nothing on AWS was mutated except
a CloudTrail audit entry on the `kms:Sign` call.

---

## Step 8 — Upload EIF + KMS sig to S3

**Command.**
```bash
GIT_SHA=$(git rev-parse HEAD)
aws s3 cp build/ghola-provider.eif \
    "s3://ghola-eifs/ghola-provider-${GIT_SHA}.eif"
aws s3 cp "deploy/nitro/measurements/${GIT_SHA}.kms.sig" \
    "s3://ghola-eifs/ghola-provider-${GIT_SHA}.kms.sig"
```

**Success.** Both `aws s3 cp` calls report bytes uploaded with
no error. `aws s3 ls s3://ghola-eifs/` shows the two new objects.

**Failure.** `AccessDenied` on `s3:PutObject` → caller lacks
`PutObject` on the bucket. Recall the build role only needs
`s3:GetObject` for runtime; the operator's *own* IAM identity needs
`s3:PutObject`.

**Rollback.** `aws s3 rm` both objects; the EC2 will refuse to start
on the next `terraform apply` (good — that is the desired safe state).

---

## Step 9 — `terraform apply` user-data on the m5.xlarge

**Command.**
```bash
cd deploy/terraform
terraform apply \
    -var="eif_s3_uri=s3://ghola-eifs/ghola-provider-${GIT_SHA}.eif" \
    -var="kms_build_role_arn=arn:aws:iam::<ACCOUNT_ID>:role/<build-role>" \
    -var="relay_host=ghola-relay.onrender.com"
```

`user_data_replace_on_change = true` in `main.tf` forces a clean EC2
replacement, so the host comes up fresh with the new EIF URI baked
into user-data.

**Success.** New EC2 enters `running`. SSH (if `ops_ssh_cidr` set)
and confirm:
- `sudo systemctl status ghola-vsock-proxy.service` → active
- `nitro-cli describe-enclaves` → one entry, `"Flags": "NONE"`
- `sudo journalctl -u ghola-provider.service -n 50` → no panics

**Failure.** Enclave fails to launch with `EIF_NOT_FOUND` → check
the S3 URI matches the file from Step 8. Vsock-proxy fails to start
→ the `s3://<bucket>/ghola-vsock-proxy` artifact is missing
(see [`nitro/PHASE1_RUNBOOK.md`](./nitro/PHASE1_RUNBOOK.md) Step 2).

**Rollback.** Re-`terraform apply` with the previous good
`eif_s3_uri`; the user-data replacement re-creates the EC2 with the
prior EIF. The KMS key and S3 objects stay; they are forward-compatible.

---

## Step 10 — Smoke test from the browser

1. Open `https://ghola.xyz/chat` in a fresh browser session.
2. Toggle the sovereignty selector to **Private** mode.
3. Send a message (e.g. `"hello"`).
4. When the reply renders, click the receipt badge.
5. Confirm the JSON modal shows:
   - `"mode": "private"`
   - `"tee_kind": "nitro"` ← the headline check
   - a non-null `attestation_hash` (64 hex chars)
6. Resolve the hash:
   ```bash
   curl https://ghola-relay.onrender.com/attestations/<attestation_hash>
   ```
   Should return the full attestation document JSON.

**Success.** All three of (`tee_kind: nitro`, non-null
`attestation_hash`, `GET /attestations/:hash` returns 200).

**Failure.** `tee_kind: "none"` → relay isn't seeing an authenticated
provider; check `/providers/attested` returns a non-empty array. If
the array is empty, the provider failed handshake — re-check Step 9
and `ProviderAttest verified: …, kms=OK` should appear in relay logs.

**Rollback.** Revert env vars from Steps 3, 4, 6 to restore the
pre-v3.5 behaviour (relay accepts non-attested providers as
`tee_kind: "none"`). The browser flow continues to work; private
mode just falls back to v2 trust.

---

## Post-rollout

- Update `STATUS.md` with the deployed git SHA and the live
  `tee_kind: "nitro"` evidence (a sample `attestation_hash`).
- Add the KMS key ARN to `CUSTODY.md` if the placeholder is still
  there (it should reference the Terraform output, not the raw ARN).
- File a v4 issue for the hardening items called out in
  [`CUSTODY.md`](./CUSTODY.md) §"v4 hardening items".
