# Ghola v3.5 — Signing Key Custody Policy

Two offline-controlled signing keys gate Ghola's enclave trust model.
This document is the single source of truth on where they live, who
can use them, how they rotate, and the leak playbook. It is intended
to be readable end-to-end in five minutes.

Cross-references:
- Provisioning: see [`ROLLOUT_V35.md`](./ROLLOUT_V35.md) (KMS key in
  Step 5; allowlist key is bootstrapped in [`runbook.md`](./runbook.md)
  §1.1 and re-used here).
- Verifier code path: `crates/said-attest::verify_attestation_with_kms`.

---

## Key 1 — `said-attest` measurement allowlist (Ed25519)

| Field | Value |
|---|---|
| Algorithm | Ed25519 (RFC 8032) |
| Public half | Pinned in `crates/said-attest` or loaded from env `GHOLA_ATTEST_SIGNING_PUB` (relay + receipts service) |
| Private half | `~/.ghola-prod-keys/ghola-attest-signing.key` on the offline operator workstation (mode 0400) |
| Used by | Ops human, when stamping a new enclave measurement via `deploy/nitro/sign-allowlist.sh` |
| Signs | `sha256(PCR0 \|\| PCR1 \|\| PCR2)` for each promoted EIF |
| Consumed by | Relay (`/providers/attested` admission check) — only enclaves whose measurement carries a valid allowlist signature are admitted |

**Who can use it.** Single operator today (Anderson). The key never
leaves the offline workstation; signing happens there and the
resulting base64 sig is hand-carried to SSM via
`aws ssm put-parameter --type SecureString /ghola/provider/allowlist-sig`.

**Rotation cadence.** Event-driven, not calendar-driven. Rotate on:
- suspected leak or workstation compromise,
- operator handoff,
- annual review if neither of the above fired (defensive lower bound).

The rotation procedure (deploy a new pub via `GHOLA_ATTEST_SIGNING_PUB_NEXT`,
overlap window, swap) is in [`runbook.md`](./runbook.md) §6.

**Quorum.** Single-operator today — **not in place; v4 hardening item.**
Plan for v4: 2-of-3 Shamir split across (a) operator 1Password, (b)
Glacier cold storage, (c) printed paper in a safe deposit box.
Reconstitution requires any two; ops signing requires any two in a
co-located 30-minute window.

**Backups.** Today: 1Password encrypted attachment on the operator
device + one paper printout in a sealed envelope. **Glacier mirror is
not in place — v4 hardening.**

**Leak playbook.**
1. Revoke: deploy a fresh keypair, push the new pub to
   `GHOLA_ATTEST_SIGNING_PUB_NEXT` on relay + receipts.
2. Re-sign every active measurement with the replacement key and
   refresh `/ghola/provider/allowlist-sig` in SSM.
3. After all active enclaves are re-stamped (≤ 1 hour), promote
   `_NEXT` → primary and drop the compromised pub.
4. Recovery is Ghola-side only: the COSE chain at `said-attest`
   still validates via the AWS Nitro Root G1 path, so receipts
   anchored *before* the leak remain verifiable. There is no relay
   outage during recovery — admission falls back to vendor-cert-only
   verification during the swap window if needed.

---

## Key 2 — KMS-signed EIF measurement key (ECDSA P-384)

| Field | Value |
|---|---|
| Algorithm | ECDSA_SHA_384 over NIST P-384 (matches AWS Nitro Root G1 curve) |
| Resource | AWS KMS asymmetric `SIGN_VERIFY` key, alias `alias/<name_prefix>-eif-measurement` |
| ARN | `terraform output -raw eif_measurement_key_arn` (see [`ROLLOUT_V35.md`](./ROLLOUT_V35.md) Step 5) |
| Public half | `terraform output -raw eif_measurement_public_key_pem` → pinned on the relay as `GHOLA_KMS_MEASUREMENT_PUBKEY_PEM` |
| Private half | Inside KMS — never extractable |
| Signs | `sha384(PCR0 \|\| PCR1 \|\| PCR2)` per build (see [`nitro/build-eif.sh`](./nitro/build-eif.sh) §5) |
| Consumed by | `said-attest::verify_attestation_with_kms` on the relay |

**Who can use it.** Defined by the key policy in
[`terraform/kms.tf`](./terraform/kms.tf):
- `kms_build_role_arn` — the only principal that can call `kms:Sign`
  and `kms:GetPublicKey`. This is the CI / operator-workstation IAM
  role, never the running EC2 instance role.
- `kms_admin_arns` — can administer the key (enable/disable/schedule
  deletion). Should be a break-glass role, not the daily-driver one.
- Root account principal retains `kms:*` as a lockout-prevention
  fallback.

The running EC2 instance role (`aws_iam_role.host` in `main.tf`) has
**zero** `kms:Sign` permission. The instance never touches the
private half; it only consumes signatures the relay validates.

**Rotation cadence.** Annual. AWS does not support automatic rotation
on asymmetric KMS keys (see `enable_key_rotation = false` in
`kms.tf`), so rotation is a planned operation:
1. Provision a second key (Terraform `count = 2` pattern or a new
   resource block).
2. Re-sign every active EIF with both keys during the overlap window.
3. Update `GHOLA_KMS_MEASUREMENT_PUBKEY_PEM` on the relay to the new
   pub; verifier accepts both for the overlap window via the
   `_NEXT` env pattern used for the allowlist key.
4. Schedule the old key for deletion (30-day window per `kms.tf`).

**Quorum.** None on `kms:Sign` itself — IAM is single-principal. CloudTrail
captures every Sign call (the audit trail is the after-the-fact quorum
substitute). **Pre-sign quorum is not in place — v4 hardening item**
(would require an AWS Lambda + Step Functions approval gate, or a
manual SSO approval workflow on the build role).

**Backups.** None required — KMS holds the master copy and AWS
operates the redundancy. The PEM of the public half is checked into
Terraform state and exported as a Terraform output; lose the state
file and you re-derive the pub via `aws kms get-public-key`.

**Leak playbook.** "Leak" of a KMS key means a stolen build-role
credential that called `kms:Sign` for unauthorized measurements.
KMS itself does not leak the private half.

1. Disable the leaked build-role credential (IAM); rotate any
   workstation credentials.
2. `aws kms disable-key --key-id <arn>` to stop further signs.
3. Audit CloudTrail for every `kms:Sign` call in the suspect window;
   any measurement signed in that window is considered tainted.
4. Provision a replacement key (rotation procedure above).
5. Re-sign every legitimate active EIF with the replacement; update
   relay's `GHOLA_KMS_MEASUREMENT_PUBKEY_PEM`.
6. Schedule the compromised key for deletion.

As with Key 1, this is Ghola-side recovery. The AWS Nitro Root G1
COSE chain in `said-attest` still validates independently, so the
relay admits enclaves on the vendor cert path while the KMS pub is
being rotated. **No customer-visible outage.**

---

## Summary of v4 hardening items

The honest list of controls that are *not* in place today but should
land before this doc claims production-grade custody:

- 2-of-3 quorum on the allowlist signing key (Shamir split).
- Glacier cold-storage mirror of the allowlist key.
- Pre-sign approval gate on `kms:Sign` (Step Functions or SSO approval).
- Auto-rotation tooling so annual KMS rotation is one command, not a
  manual checklist.
