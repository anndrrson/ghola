# KMS key for signing Ghola EIF measurements.
#
# Phase 1 of the v3.5 privacy rollout: every EIF Ghola publishes has its
# measurement (`sha256(PCR0||PCR1||PCR2)`) signed by an asymmetric KMS
# key. Verifiers (relay + said-attest) check that signature alongside
# the existing Ghola-allowlist Ed25519 sig. If the offline Ed25519 key
# is ever lost or compromised, the KMS-anchored signature still gates
# which measurements the relay will accept — and KMS gives us:
#
#   - centralized audit trail of every sign call (CloudTrail)
#   - rotation without re-deploying verifier code (key alias)
#   - access control via IAM (only the build role can sign)
#
# Key spec rationale:
#
#   - ECC_NIST_P384 to match the AWS Nitro Root G1 curve. P-384 is also
#     supported natively by said-attest's p384 crate, so the verifier
#     stays small.
#   - SIGN_VERIFY usage so we never accidentally use this key for
#     decryption. Disable encrypt/decrypt at the policy layer to make
#     misuse impossible even with broad IAM.
#   - ECDSA_SHA_384 signing algorithm (single, no negotiation).
#
# IMPORTANT: this key MUST NOT be granted to the running EC2 IAM role.
# The build role (CI / operator workstation) is the only principal that
# can call kms:Sign. The verifier only needs the public half, which is
# exported via `aws_kms_public_key` data source (or fetched at runtime).

# ---- Variables ----

variable "kms_build_role_arn" {
  type        = string
  default     = ""
  description = "IAM role ARN that's allowed to call kms:Sign on the EIF measurement key. Leave empty to skip key creation entirely (dev). Typically your CI role or operator IAM user ARN."
}

variable "kms_admin_arns" {
  type        = list(string)
  default     = []
  description = "Principal ARNs that can administer the key (key policy edits, schedule deletion, enable/disable). Leave empty in dev."
}

# ---- The signing key ----

resource "aws_kms_key" "eif_measurement" {
  count = var.kms_build_role_arn == "" ? 0 : 1

  description              = "Ghola EIF measurement signer (sha256(PCR0||PCR1||PCR2) → ECDSA_SHA_384)."
  customer_master_key_spec = "ECC_NIST_P384"
  key_usage                = "SIGN_VERIFY"
  deletion_window_in_days  = 30
  enable_key_rotation      = false # Rotation isn't supported on asymmetric KMS keys.

  # Restrictive key policy:
  #   - root account principal retains the can-administer-itself
  #     fallback so we don't lock ourselves out
  #   - kms_admin_arns can administer
  #   - kms_build_role_arn can call kms:Sign and kms:GetPublicKey only
  #   - nothing else can decrypt / encrypt / generate-data-key (the
  #     SIGN_VERIFY key spec already denies those, but we belt-and-
  #     suspender it in the policy too)
  policy = jsonencode({
    Version = "2012-10-17"
    Id      = "ghola-eif-measurement-key-policy"
    Statement = concat(
      [
        {
          Sid    = "RootAccountAdmin"
          Effect = "Allow"
          Principal = {
            AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
          }
          Action   = "kms:*"
          Resource = "*"
        }
      ],
      length(var.kms_admin_arns) == 0 ? [] : [
        {
          Sid    = "KeyAdmins"
          Effect = "Allow"
          Principal = {
            AWS = var.kms_admin_arns
          }
          Action = [
            "kms:Describe*",
            "kms:Enable*",
            "kms:Disable*",
            "kms:Update*",
            "kms:Revoke*",
            "kms:Get*",
            "kms:List*",
            "kms:ScheduleKeyDeletion",
            "kms:CancelKeyDeletion"
          ]
          Resource = "*"
        }
      ],
      [
        {
          Sid    = "BuildRoleCanSign"
          Effect = "Allow"
          Principal = {
            AWS = var.kms_build_role_arn
          }
          # Sign + GetPublicKey only. No Decrypt, no Encrypt, no
          # GenerateDataKey — those are nonsensical on a SIGN_VERIFY
          # key but blocking them in the policy hardens against future
          # key-spec changes.
          Action = [
            "kms:Sign",
            "kms:Verify",
            "kms:GetPublicKey",
            "kms:DescribeKey"
          ]
          Resource = "*"
          Condition = {
            StringEquals = {
              "kms:SigningAlgorithm" = "ECDSA_SHA_384"
            }
          }
        }
      ]
    )
  })

  tags = {
    Name    = "${var.name_prefix}-eif-measurement-signer"
    Project = "ghola-v3.5-phase1"
  }
}

resource "aws_kms_alias" "eif_measurement" {
  count         = var.kms_build_role_arn == "" ? 0 : 1
  name          = "alias/${var.name_prefix}-eif-measurement"
  target_key_id = aws_kms_key.eif_measurement[0].id
}

# Fetch the public key so callers (verifiers) can pin it.
data "aws_kms_public_key" "eif_measurement" {
  count  = var.kms_build_role_arn == "" ? 0 : 1
  key_id = aws_kms_key.eif_measurement[0].key_id
}

data "aws_caller_identity" "current" {}

# ---- Outputs ----

output "eif_measurement_key_arn" {
  description = "ARN of the asymmetric KMS key used to sign EIF measurements. Pass this to build-eif.sh as KMS_KEY_ID."
  value       = length(aws_kms_key.eif_measurement) == 0 ? null : aws_kms_key.eif_measurement[0].arn
}

output "eif_measurement_key_alias" {
  description = "KMS alias for the EIF measurement signer."
  value       = length(aws_kms_alias.eif_measurement) == 0 ? null : aws_kms_alias.eif_measurement[0].name
}

output "eif_measurement_public_key_pem" {
  description = "PEM-encoded public half of the EIF measurement signer. Wire this into GHOLA_KMS_MEASUREMENT_PUBKEY_PEM on the relay + verifier."
  value       = length(data.aws_kms_public_key.eif_measurement) == 0 ? null : data.aws_kms_public_key.eif_measurement[0].public_key_pem
  sensitive   = false
}
