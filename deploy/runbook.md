# Ghola v2 — Confidential AI Ops Runbook

This is the working operator manual for the v2 confidential-AI stack:
sealed inference + Nitro attestation + on-chain receipt anchoring.

**IaC choice:** Terraform (HCL). Lives under `deploy/terraform/`. We
considered CDK but chose Terraform for parity with the rest of the
Ghola infra and to keep the IaC stack toolchain-agnostic (no Node.js
required on the ops box).

## Architecture at a glance

```
Web (ghola.xyz) ──seal()──► ghola-relay ──WS──► ghola-gpu-provider
                                                  (inside Nitro EIF)
                              │                          │
                              │                          ├─ /dev/nsm attest
                              │                          ├─ open() → Ollama
                              │                          └─ seal(reply) + sign receipt
                              │
                              ├─ verify attestation against allowlist
                              └─ relay opaque bytes back

receipts ──POST /v1/receipts──► said-receipts-service ──hourly Merkle batch──►
                                                       said-receipts Solana program
                                                       (devnet then mainnet)
```

## Key material inventory

There are four long-lived keypairs in the v2 system. Treat them with
the corresponding care.

| Key | Storage | Used by | Public half published as |
|---|---|---|---|
| **Ghola allowlist signing key** (Ed25519) | Offline / HSM. Air-gapped laptop, paper backup. | Ops, when stamping each new enclave measurement. | `GHOLA_ATTEST_SIGNING_PUB` env on relay and said-receipts. |
| **Provider auth key** (Ed25519) | AWS SSM Parameter Store SecureString `/ghola/provider/auth-key`. | The ghola-gpu-provider EIF (loaded by user-data at boot). | Registered in the relay's accept-list table. |
| **said-receipts deploy keypair** (Solana Ed25519) | Offline; the operator wallet that holds upgrade authority. | `anchor deploy` and subsequent `set-upgrade-authority` runs. | Pinned in `Anchor.toml` under `[programs.devnet]` / `[programs.mainnet]`. |
| **Turnkey KEK** (P-256, server-side) | Inside Turnkey — never leaves the HSM. | said-turnkey crate via `TURNKEY_PRIVATE_KEY_KEK_ID`. | Not published; only the Turnkey key ID is. |

## 1. Bootstrap (one-time, per environment)

### 1.1 Generate the Ghola allowlist signing key

```bash
# Pick ONE of these. The HSM path is recommended for production.

# Option A — local file (dev / staging)
openssl rand 32 > ~/ghola-attest.key
chmod 400 ~/ghola-attest.key

# Option B — YubiKey / HSM-backed (production)
#   Out of scope for this script; provision via your HSM tooling and
#   pin the public key into the relay env.
```

Compute the public key once for downstream consumers:

```bash
deploy/nitro/sign-allowlist/target/release/ghola-sign-allowlist \
    $(printf '00%.0s' $(seq 1 32)) \
    ~/ghola-attest.key 2>&1 >/dev/null
# Reads:
#   verifying_key_hex: <64 hex chars>
```

Publish the resulting hex string to:

- `crates/ghola-relay`: env `GHOLA_ATTEST_SIGNING_PUB=<hex>`
- `crates/said-receipts-service`: env `GHOLA_ATTEST_SIGNING_PUB=<hex>`
- (recorded in 1Password under "Ghola / allowlist pubkey".)

### 1.2 Generate the provider auth key

```bash
openssl rand 32 | base64 > ~/provider-auth.b64

# Push to SSM (one per environment).
aws ssm put-parameter \
    --name /ghola/provider/auth-key \
    --type SecureString \
    --value "$(cat ~/provider-auth.b64)" \
    --region us-east-1

# Derive the public half (Ed25519 from the seed). Use any Ed25519
# library — example with Python + pynacl:
python3 - <<'PY'
import base64, sys
import nacl.signing
seed = base64.b64decode(open('/tmp/provider-auth.b64').read())[:32]
sk = nacl.signing.SigningKey(seed)
print("pub hex:", sk.verify_key.encode().hex())
PY
```

Register the public hex with the relay's accept-list. Today this is a
manual edit to `crates/ghola-relay/src/config.rs` (`ProviderAcceptList`);
v2.1 will move it into Postgres.

### 1.3 Generate the said-receipts Solana keypair

```bash
solana-keygen new --no-bip39-passphrase \
    --outfile ~/.config/solana/said-receipts-upgrade.json

# Capture program ID by deriving from the keypair.
solana-keygen pubkey ~/.config/solana/said-receipts-upgrade.json
```

Paste the program ID into `Anchor.toml` (`[programs.devnet]` and
`[programs.mainnet]`) and into the source `declare_id!()` in
`programs/said-receipts/src/lib.rs`. Both must match — see
`MEMORY.md` for the bite mark from past Anchor deploys.

### 1.4 Turnkey KEK provisioning

The said-turnkey crate uses a long-lived P-256 KEK (Key Encryption Key)
inside Turnkey to wrap/unwrap user secrets. Provision it once:

```bash
# Script lives at scripts/turnkey/create-kek.sh in the parent repo.
# It calls Turnkey's POST /public/v1/submit/create_private_keys
# endpoint with curve=CURVE_P256, captures the returned key_id, and
# writes it to stdout.
TURNKEY_ORG_ID=... TURNKEY_API_KEY=... \
    bash scripts/turnkey/create-kek.sh > kek.json

# Push the key_id to the relay env (NOT a secret on its own; the
# private half stays in Turnkey).
TURNKEY_PRIVATE_KEY_KEK_ID="$(jq -r .private_key_id kek.json)"
fly secrets set TURNKEY_PRIVATE_KEY_KEK_ID="$TURNKEY_PRIVATE_KEY_KEK_ID" \
    --app ghola-relay
```

### 1.5 said-receipts program deploy

```bash
# Build (uses the pinned Solana 1.18.26 toolchain; see MEMORY.md).
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
anchor build

# Devnet first.
anchor deploy \
    --provider.cluster devnet \
    --program-keypair target/deploy/said_receipts-keypair.json

# Capture program ID and push to receipts service.
PROGRAM_ID="$(solana-keygen pubkey target/deploy/said_receipts-keypair.json)"
fly secrets set SAID_RECEIPTS_PROGRAM_ID="$PROGRAM_ID" \
    --app said-receipts

# Smoke (publishes a no-op root and asserts it lands).
cargo run -p said-receipts-service --bin smoke -- --cluster devnet

# Mainnet, once devnet has run for at least a week without an emit gap.
anchor deploy --provider.cluster mainnet ...
fly secrets set SAID_RECEIPTS_PROGRAM_ID=...   # update for prod stack
```

## 2. Build and deploy a new enclave image

```bash
# From the repo root, on a Linux box with docker + nitro-cli installed.
deploy/nitro/build-eif.sh
# → prints PCR0..2 and the measurement digest (sha256 of pcr0||pcr1||pcr2)
# → writes deploy/nitro/measurements/<git-sha>.json

# Sign the measurement on the air-gapped laptop.
deploy/nitro/sign-allowlist.sh <measurement-hex> ~/ghola-attest.key
# → prints base64 Ed25519 signature

# Upload the signature to SSM.
aws ssm put-parameter \
    --name /ghola/provider/allowlist-sig \
    --type SecureString \
    --overwrite \
    --value '<base64-sig>'

# Upload the EIF to S3.
aws s3 cp build/ghola-provider.eif \
    s3://ghola-eifs/ghola-provider-<git-sha>.eif

# Apply Terraform with the new EIF URI.
cd deploy/terraform
terraform apply \
    -var="eif_s3_uri=s3://ghola-eifs/ghola-provider-<git-sha>.eif"

# Verify on the host.
ssh ec2-user@<public-ip>
sudo nitro-cli describe-enclaves
sudo journalctl -u ghola-provider.service -f
```

The relay should pick up the new provider's `ProviderAttest` message
within ~5s and start advertising it under `GET /providers/attested`.

## 3. Rotate the enclave (zero-downtime)

The relay keeps multiple attested enclaves of the same model class.
Rotate by deploying the new image alongside the old:

1. Build and sign the new EIF (section 2).
2. `terraform apply -var-file=second-host.tfvars` — provisions a second
   m5.xlarge with the new EIF.
3. Watch `/providers/attested` — both enclaves should appear.
4. Wait for the old enclave's TTL (default 24h) to come close to expiry
   without renewal; the relay garbage-collects it.
5. `terraform destroy -var-file=old-host.tfvars` once the old enclave
   has been GC'd.

## 4. Rotate the Ghola allowlist signing key

Allowlist key rotation is the highest-blast-radius rotation in v2: if
the relay starts rejecting every attestation, every Private chat fails.
Use dual-write.

1. Generate the new key (section 1.1) but keep the old one online.
2. Re-sign the latest measurement(s) with the new key:
   ```bash
   deploy/nitro/sign-allowlist.sh <measurement-hex> ~/ghola-attest-new.key
   ```
3. Push the new signature to SSM as `/ghola/provider/allowlist-sig-next`.
4. Deploy the relay with `GHOLA_ATTEST_SIGNING_PUB_NEXT=<new-pub-hex>`
   set in addition to `GHOLA_ATTEST_SIGNING_PUB`. The relay accepts a
   sig from either key during the rollover window.
5. Re-run all hosts' user-data so each enclave reads the new sig:
   ```bash
   aws ssm put-parameter \
       --name /ghola/provider/allowlist-sig \
       --overwrite --value '<new-sig>' --type SecureString
   ```
6. After 48h with the new sig in place, flip:
   - Move `GHOLA_ATTEST_SIGNING_PUB_NEXT` → `GHOLA_ATTEST_SIGNING_PUB`.
   - Unset `..._NEXT`.
   - Destroy the old key (zeroize + paper backup destruction).

## 5. Incident response — suspected enclave compromise

If you suspect a deployed enclave is compromised (anomalous outbound
egress on the host, a vulnerability in an enclave dependency, a leaked
provider auth key):

1. **Revoke the measurement.** The relay exposes
   `POST /admin/revoked-measurements` (auth: bearer
   `GHOLA_ADMIN_TOKEN`). Body:
   ```json
   { "measurement_digest": "<hex>", "reason": "CVE-2026-XXXX" }
   ```
   The relay drops all attested enclaves matching that digest and
   refuses to re-attest them. This is a CRL-style mechanism: revocations
   are persisted in Postgres and re-applied on relay restart.

2. **Terminate the host.**
   ```bash
   terraform destroy -target=aws_instance.host
   ```
   (Or `aws ec2 terminate-instances` for the affected instance ID.)

3. **Rotate the provider auth key.** Section 1.2, then re-register the
   new pub in the relay's accept-list and force a redeploy of any
   surviving enclaves.

4. **Optionally rotate the allowlist signing key.** If you believe the
   signing key itself leaked, follow section 4.

5. **Postmortem note.** Append a row to `deploy/nitro/measurements/`
   with `revoked: true` and the incident ticket URL. Future Verify
   buttons should fail-closed against this measurement.

## 6. Deployment checklist (release engineer)

- [ ] PR merged to `main`.
- [ ] `deploy/nitro/build-eif.sh` ran clean on the Linux build host.
- [ ] Measurement file in `deploy/nitro/measurements/<sha>.json` is
      committed (audit trail).
- [ ] Signature uploaded to SSM.
- [ ] EIF uploaded to S3.
- [ ] Terraform applied.
- [ ] `/providers/attested?model=<m>` reports ≥1 enclave for the model.
- [ ] `tests/e2e/v2-private-flow.sh` passed against staging.
- [ ] Investor-demo dry run done (cmd-F `deploy/investor-demo.md`).
