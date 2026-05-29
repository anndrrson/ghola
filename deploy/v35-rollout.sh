#!/usr/bin/env bash
# v35-rollout.sh — scriptable subset of deploy/ROLLOUT_V35.md.
#
# Wraps the deterministic, automatable parts of the v3.5 rollout:
#   - mint the OHTTP gateway keypair (Step 2)
#   - terraform apply the KMS signing key (Step 5)
#   - run build-eif.sh with KMS_KEY_ID (Step 7)
#   - upload EIF + .kms.sig to S3 (Step 8)
#   - print SSM commands the operator will run manually for secrets
#   - smoke-test /providers/attested (Step 10 partial)
#
# OUT OF SCOPE (by design):
#   - Render dashboard env vars (Steps 3, 4, 6) — user clicks these
#   - Writing production secrets to disk (printed to stdout only)
#   - The browser smoke test (Step 10 receipt badge)
#
# Usage:
#   ./deploy/v35-rollout.sh --dry-run
#   ./deploy/v35-rollout.sh ohttp-key
#   ./deploy/v35-rollout.sh kms-apply
#   ./deploy/v35-rollout.sh build-eif
#   ./deploy/v35-rollout.sh upload-eif
#   ./deploy/v35-rollout.sh print-ssm
#   ./deploy/v35-rollout.sh smoke
#   ./deploy/v35-rollout.sh all      # ohttp-key, kms-apply, build-eif, upload-eif, smoke

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "${SCRIPT_DIR}/.." && pwd )"
TF_DIR="${SCRIPT_DIR}/terraform"

DRY_RUN=0
RELAY_HOST="${RELAY_HOST:-ghola-relay.onrender.com}"
EIF_BUCKET="${EIF_BUCKET:-ghola-eifs}"
KMS_BUILD_ROLE_ARN="${KMS_BUILD_ROLE_ARN:-}"
KMS_ADMIN_ARNS_HCL="${KMS_ADMIN_ARNS_HCL:-[]}"

log() { printf '==> %s\n' "$*" >&2; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

run() {
    if (( DRY_RUN )); then
        printf 'DRY-RUN: %s\n' "$*" >&2
    else
        "$@"
    fi
}

# Eval-variant for shell-quoted command strings (pipelines, redirects).
run_sh() {
    if (( DRY_RUN )); then
        printf 'DRY-RUN: %s\n' "$*" >&2
    else
        bash -c "$*"
    fi
}

require_cmd() {
    command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

# ---- subcommand: ohttp-key ----
cmd_ohttp_key() {
    log "minting OHTTP gateway keypair (cargo run -p ghola-relay -- generate-ohttp-key)"
    if (( DRY_RUN )); then
        printf 'DRY-RUN: cargo run -p ghola-relay --bin ghola-relay -- generate-ohttp-key\n' >&2
        printf 'DRY-RUN: → would print GHOLA_OHTTP_KEY_SECRET_HEX / _PUBLIC_HEX / _KEYCONFIG_HEX\n' >&2
        return 0
    fi
    require_cmd cargo
    # Print to stdout so the operator can pipe into a file or 1Password.
    # Never write the secret into a file on disk from this script unless
    # --unsafe-secrets-to-stdout is passed (it always prints to stdout
    # already; the file write is the operator's choice).
    cd "${REPO_ROOT}"
    cargo run --quiet -p ghola-relay --bin ghola-relay -- generate-ohttp-key
    cat <<'EOF' >&2

NEXT (manual, Render dashboard — see ROLLOUT_V35.md Step 3):
  Paste GHOLA_OHTTP_KEY_SECRET_HEX into thumper-relay env.
  Set GHOLA_OHTTP_KEY_ID=1 (increment only on rotation).
EOF
}

# ---- subcommand: kms-apply ----
cmd_kms_apply() {
    [[ -n "${KMS_BUILD_ROLE_ARN}" ]] \
        || die "KMS_BUILD_ROLE_ARN env var required (the build IAM role allowed to call kms:Sign)"
    require_cmd terraform
    log "terraform apply -target=aws_kms_key.eif_measurement"
    cd "${TF_DIR}"
    run terraform init -input=false
    # The KMS resources are gated by count = 1 in kms.tf; we still need
    # the eif_s3_uri var because main.tf declares it as required (no
    # default). Pass a placeholder; this targeted apply won't read it.
    run terraform apply \
        -input=false \
        -auto-approve \
        -var="eif_s3_uri=s3://${EIF_BUCKET}/PLACEHOLDER" \
        -var="kms_build_role_arn=${KMS_BUILD_ROLE_ARN}" \
        -var="kms_admin_arns=${KMS_ADMIN_ARNS_HCL}" \
        -target=aws_kms_key.eif_measurement \
        -target=aws_kms_alias.eif_measurement

    if (( DRY_RUN )); then
        printf 'DRY-RUN: terraform output -raw eif_measurement_key_arn\n' >&2
        printf 'DRY-RUN: terraform output -raw eif_measurement_public_key_pem\n' >&2
        return 0
    fi
    log "capturing outputs to /tmp/ghola-kms-arn.txt and /tmp/ghola-kms-pub.pem"
    terraform output -raw eif_measurement_key_arn > /tmp/ghola-kms-arn.txt
    terraform output -raw eif_measurement_public_key_pem > /tmp/ghola-kms-pub.pem
    chmod 600 /tmp/ghola-kms-arn.txt /tmp/ghola-kms-pub.pem
    log "KMS ARN: $(cat /tmp/ghola-kms-arn.txt)"
    log "PEM length: $(wc -c < /tmp/ghola-kms-pub.pem) bytes"
}

# ---- subcommand: build-eif ----
cmd_build_eif() {
    local kms_arn="${KMS_KEY_ID:-}"
    if [[ -z "${kms_arn}" && -f /tmp/ghola-kms-arn.txt ]]; then
        kms_arn="$(cat /tmp/ghola-kms-arn.txt)"
    fi
    [[ -n "${kms_arn}" ]] || die "KMS_KEY_ID env or /tmp/ghola-kms-arn.txt required"
    log "build-eif.sh with KMS_KEY_ID=${kms_arn}"
    if (( DRY_RUN )); then
        printf 'DRY-RUN: KMS_KEY_ID=%s %s/nitro/build-eif.sh\n' "${kms_arn}" "${SCRIPT_DIR}" >&2
        return 0
    fi
    KMS_KEY_ID="${kms_arn}" "${SCRIPT_DIR}/nitro/build-eif.sh"
}

# ---- subcommand: upload-eif ----
cmd_upload_eif() {
    require_cmd aws
    require_cmd git
    cd "${REPO_ROOT}"
    local git_sha
    git_sha="$(git rev-parse HEAD)"
    local eif_path="${REPO_ROOT}/build/ghola-provider.eif"
    local sig_path="${SCRIPT_DIR}/nitro/measurements/${git_sha}.kms.sig"
    if (( ! DRY_RUN )); then
        [[ -f "${eif_path}" ]] || die "EIF not found at ${eif_path} — run build-eif first"
        [[ -f "${sig_path}" ]] || die "KMS sig not found at ${sig_path} — run build-eif with KMS_KEY_ID first"
    fi
    log "uploading EIF + KMS sig to s3://${EIF_BUCKET}/ (sha=${git_sha})"
    run aws s3 cp "${eif_path}" \
        "s3://${EIF_BUCKET}/ghola-provider-${git_sha}.eif"
    run aws s3 cp "${sig_path}" \
        "s3://${EIF_BUCKET}/ghola-provider-${git_sha}.kms.sig"
    log "uploaded; eif_s3_uri = s3://${EIF_BUCKET}/ghola-provider-${git_sha}.eif"
}

# ---- subcommand: print-ssm ----
#
# Does NOT execute aws ssm put-parameter. Prints the exact commands
# the operator should run, with placeholders for the secret values.
# This keeps secrets out of any script context, shell history, or
# CI log unless the operator copies them deliberately.
cmd_print_ssm() {
    cat <<EOF
# Run these manually after pasting in the secrets. Never paste into a
# shell that ships its history to a remote (e.g. zsh-with-cloud-sync).

# 1. Allowlist signature (output of deploy/nitro/sign-allowlist.sh):
aws ssm put-parameter \\
    --name /ghola/provider/allowlist-sig \\
    --value '<paste ALLOWLIST_SIG_B64 here>' \\
    --type SecureString \\
    --overwrite

# 2. Provider auth key (Ed25519 secret, base64; rotate on operator
#    handoff or suspected leak):
aws ssm put-parameter \\
    --name /ghola/provider/auth-key \\
    --value '<paste PROVIDER_AUTH_KEY_B64 here>' \\
    --type SecureString \\
    --overwrite

# 3. (Optional) Mirror the OHTTP gateway secret into SSM if you want
#    Render to read from SSM at boot instead of holding it as an env:
aws ssm put-parameter \\
    --name /ghola/relay/ohttp-key-secret \\
    --value '<paste GHOLA_OHTTP_KEY_SECRET_HEX here>' \\
    --type SecureString \\
    --overwrite
EOF
}

# ---- subcommand: smoke ----
cmd_smoke() {
    require_cmd curl
    local url="https://${RELAY_HOST}/providers/attested"
    log "smoke: GET ${url}"
    if (( DRY_RUN )); then
        printf 'DRY-RUN: curl -fsS %s | jq ...\n' "${url}" >&2
        return 0
    fi
    local body
    body="$(curl -fsS --max-time 15 "${url}")" \
        || die "smoke: GET ${url} failed"
    # Assert at least one provider has tee_kind == "nitro". Use jq if
    # available; fall back to grep otherwise.
    if command -v jq >/dev/null 2>&1; then
        local count
        count="$(printf '%s' "${body}" | jq '[.[] | select(.tee_kind == "nitro")] | length')"
        if [[ "${count}" -lt 1 ]]; then
            warn "no provider with tee_kind=nitro yet (count=${count})"
            warn "body: ${body}"
            die "smoke failed: expected at least one nitro provider"
        fi
        log "smoke OK: ${count} provider(s) with tee_kind=nitro"
    else
        warn "jq not installed; falling back to grep"
        if ! printf '%s' "${body}" | grep -q '"tee_kind"[[:space:]]*:[[:space:]]*"nitro"'; then
            die "smoke failed: no tee_kind=nitro in ${url} response"
        fi
        log "smoke OK (grep)"
    fi
}

# ---- dispatcher ----

usage() {
    sed -n '1,/^set -euo/p' "$0" | sed '$d'
}

main() {
    local cmd=""
    while (( $# > 0 )); do
        case "$1" in
            --dry-run) DRY_RUN=1; shift ;;
            -h|--help) usage; exit 0 ;;
            *) cmd="$1"; shift; break ;;
        esac
    done
    [[ -n "${cmd}" ]] || { usage; exit 1; }

    case "${cmd}" in
        ohttp-key)   cmd_ohttp_key ;;
        kms-apply)   cmd_kms_apply ;;
        build-eif)   cmd_build_eif ;;
        upload-eif)  cmd_upload_eif ;;
        print-ssm)   cmd_print_ssm ;;
        smoke)       cmd_smoke ;;
        all)
            cmd_ohttp_key
            cmd_kms_apply
            cmd_build_eif
            cmd_upload_eif
            log "skipping print-ssm in 'all' (operator must run manually)"
            cmd_smoke
            ;;
        *) die "unknown subcommand: ${cmd}" ;;
    esac
}

main "$@"
