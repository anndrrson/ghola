#!/usr/bin/env node
import {
  createHash,
  createHmac,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalCarryCommitmentJson,
  carryPrivatePrimeWorkerAuthenticationMessage,
} from "@ghola/execution-core";
import { assessCarryExecutionReadiness } from "../../private-agent-worker/src/execution/carry-readiness.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CARRY_NO_SUBMIT_EVIDENCE_PATH = resolve(
  HERE,
  "../../../deploy/evidence/carry-three-venue-no-submit.json",
);

export function readCarryNoSubmitEvidenceFile(path = DEFAULT_CARRY_NO_SUBMIT_EVIDENCE_PATH) {
  try {
    return JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    throw new Error(code === "ENOENT"
      ? `Carry no-submit evidence unavailable: carry_no_submit_evidence_missing:${resolve(path)}`
      : `Carry no-submit evidence unavailable: carry_no_submit_evidence_invalid:${resolve(path)}`);
  }
}

export function verifyCarryNoSubmitEvidence(evidence, {
  expected_preview_url: expectedPreviewUrl,
  expected_web_commit_sha: expectedWebCommitSha,
  expected_worker_image_digest: expectedWorkerImageDigest,
  expected_signer_public_keys_b64: expectedSignerPublicKeysB64,
  shared_secret: sharedSecret = "",
  now_ms: nowMs = Date.now(),
} = {}) {
  const failures = [];
  const fail = (condition, code) => { if (!condition) failures.push(code); };
  const source = record(evidence?.source);
  const request = record(evidence?.request);
  const response = record(evidence?.response);
  const readinessEvidence = record(response.readiness_evidence);
  const readiness = record(response.readiness);
  const privatePrime = record(response.private_prime_readiness);
  const authentication = record(response.private_prime_authentication);
  const context = record(authentication.context);
  const capturedAtMs = integer(evidence?.captured_at_ms);
  const checkedAtMs = integer(readiness.checked_at_ms);
  const expiresAtMs = integer(readiness.expires_at_ms);
  const privatePrimeCheckedAtMs = integer(privatePrime.checked_at_ms);
  const privatePrimeExpiresAtMs = integer(privatePrime.expires_at_ms);
  const signerKeys = new Set(array(expectedSignerPublicKeysB64).filter(nonemptyString));

  fail(evidence?.version === 1, "no_submit_version_invalid");
  fail(evidence?.kind === "ghola_three_venue_no_submit_proof", "no_submit_kind_invalid");
  fail(evidence?.network === "mainnet", "no_submit_network_invalid");
  fail(nonemptyString(expectedPreviewUrl) && source.preview_url === expectedPreviewUrl,
    "no_submit_preview_identity_mismatch");
  fail(nonemptyString(expectedWebCommitSha) && source.web_commit_sha === expectedWebCommitSha,
    "no_submit_web_revision_mismatch");
  fail(nonemptyString(expectedWorkerImageDigest) && source.worker_image_digest === expectedWorkerImageDigest,
    "no_submit_worker_image_mismatch");
  fail(/^https:\/\/[^/]+\.vercel\.app$/i.test(String(source.preview_url || "")),
    "no_submit_preview_url_invalid");
  fail(/^[0-9a-f]{7,40}$/i.test(String(source.web_commit_sha || "")), "no_submit_web_revision_invalid");
  fail(/^sha256:[a-f0-9]{12,128}$/.test(String(source.worker_image_digest || "")),
    "no_submit_worker_image_invalid");
  fail(capturedAtMs !== null, "no_submit_capture_time_invalid");

  fail(request.operation_class === "matrix_no_submit", "no_submit_operation_invalid");
  fail(nonemptyString(request.owner_commitment), "no_submit_owner_missing");
  fail(/^[A-Z0-9]{2,16}$/.test(String(request.asset || "")), "no_submit_asset_invalid");
  fail(nonemptyString(request.work_order_commitment), "no_submit_work_order_missing");
  fail(response.mode === "carry_execution_no_submit_matrix", "no_submit_matrix_mode_invalid");
  fail(response.no_submit_ready === true, "no_submit_matrix_unready");
  fail(response.transaction_broadcast === false, "no_submit_matrix_broadcast_detected");
  fail(array(response.failures).length === 0, "no_submit_matrix_failures_present");

  const readinessMaxAgeMs = checkedAtMs !== null && expiresAtMs !== null
    ? expiresAtMs - checkedAtMs
    : null;
  const assessed = assessCarryExecutionReadiness({
    evidence: readinessEvidence,
    owner_commitment: request.owner_commitment,
    venue_access: request.venue_access,
    asset: request.asset,
    notional_usd: request.notional_usd,
    horizon_days: request.horizon_days,
    now_ms: capturedAtMs ?? 0,
    env: {
      PHALA_CVM_IMAGE_DIGEST: String(expectedWorkerImageDigest || ""),
      ...(readinessMaxAgeMs !== null
        ? { PRIVATE_AGENT_CARRY_READINESS_MAX_AGE_MS: String(readinessMaxAgeMs) }
        : {}),
    },
  });
  fail(assessed.ready === true, `no_submit_readiness_evidence_invalid:${assessed.reasons?.[0] || "unknown"}`);
  fail(sameRecord(assessed, readiness), "no_submit_readiness_result_mismatch");
  fail(readinessEvidence.evidence_commitment === readiness.evidence_commitment,
    "no_submit_readiness_commitment_mismatch");
  fail(capturedAtMs !== null && checkedAtMs !== null && expiresAtMs !== null
    && capturedAtMs >= checkedAtMs && capturedAtMs < expiresAtMs,
  "no_submit_capture_outside_readiness_window");

  fail(privatePrime.kind === "ghola_private_prime_no_submit_readiness",
    "no_submit_private_prime_kind_invalid");
  fail(privatePrime.owner_commitment === request.owner_commitment, "no_submit_private_prime_owner_mismatch");
  fail(privatePrime.asset === request.asset, "no_submit_private_prime_asset_mismatch");
  fail(privatePrime.transaction_broadcast === false, "no_submit_private_prime_broadcast_detected");
  fail(privatePrime.owner_only_funding === true
    && privatePrime.owner_only_transfers === true
    && privatePrime.owner_only_withdrawals === true,
  "no_submit_private_prime_authority_invalid");
  const threeVenue = record(privatePrime.three_venue_execution);
  fail(threeVenue.ready === true, "no_submit_three_venue_execution_unready");
  fail(threeVenue.evidence_commitment === readiness.evidence_commitment,
    "no_submit_three_venue_evidence_detached");
  fail(threeVenue.readiness_commitment === readiness.readiness_commitment,
    "no_submit_three_venue_result_detached");
  fail(privatePrime.evidence_commitment === privatePrimeCommitment(privatePrime),
    "no_submit_private_prime_commitment_invalid");

  fail(authentication.version === 1
    && authentication.algorithm === "hmac-sha256"
    && authentication.request_bound === true
    && authentication.signature_algorithm === "ed25519"
    && authentication.attestation_bound === true,
  "no_submit_worker_authentication_shape_invalid");
  fail(context.route_path === "/carry/preflight-matrix"
    && context.owner_commitment === request.owner_commitment
    && context.asset === request.asset
    && context.operation_class === request.operation_class
    && context.work_order_commitment === request.work_order_commitment
    && context.evidence_commitment === privatePrime.evidence_commitment
    && context.checked_at_ms === privatePrimeCheckedAtMs
    && context.expires_at_ms === privatePrimeExpiresAtMs,
  "no_submit_worker_context_mismatch");
  fail(capturedAtMs !== null && privatePrimeCheckedAtMs !== null && privatePrimeExpiresAtMs !== null
    && capturedAtMs >= privatePrimeCheckedAtMs && capturedAtMs < privatePrimeExpiresAtMs,
  "no_submit_capture_outside_authentication_window");
  const signerPublicKeyB64 = String(authentication.signer_public_key_b64 || "");
  fail(signerKeys.size > 0 && signerKeys.has(signerPublicKeyB64), "no_submit_worker_signer_unpinned");
  const message = carryPrivatePrimeWorkerAuthenticationMessage(context);
  fail(attestedSignatureValid(authentication.signature_b64, signerPublicKeyB64, message),
    "no_submit_worker_signature_invalid");
  const macVerified = nonemptyString(sharedSecret)
    ? safeHexEqual(
      String(authentication.mac_hex || ""),
      createHmac("sha256", sharedSecret).update(message).digest("hex"),
    )
    : false;
  if (nonemptyString(sharedSecret)) fail(macVerified, "no_submit_worker_mac_invalid");

  if (failures.length > 0) {
    throw new Error(`Carry no-submit evidence failed: ${[...new Set(failures)].join(", ")}`);
  }
  return Object.freeze({
    ok: true,
    captured_at_ms: capturedAtMs,
    fresh_now: privatePrimeExpiresAtMs > nowMs,
    three_venue_ready: true,
    transaction_broadcast: false,
    mac_verified: macVerified,
    signer_fingerprint: createHash("sha256").update(signerPublicKeyB64).digest("hex").slice(0, 16),
    evidence_commitment: privatePrime.evidence_commitment,
    readiness_commitment: readiness.readiness_commitment,
  });
}

function privatePrimeCommitment(value) {
  const { evidence_commitment: _ignored, ...material } = value;
  return `carry:private-prime:${createHash("sha256")
    .update(canonicalCarryCommitmentJson(material))
    .digest("hex")
    .slice(0, 40)}`;
}

function attestedSignatureValid(signatureB64, signerPublicKeyB64, message) {
  try {
    const signature = Buffer.from(String(signatureB64 || ""), "base64");
    const key = createPublicKey({
      key: Buffer.from(signerPublicKeyB64, "base64"),
      format: "der",
      type: "spki",
    });
    return signature.length === 64 && verifySignature(null, Buffer.from(message, "utf8"), key, signature);
  } catch {
    return false;
  }
}

function safeHexEqual(left, right) {
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function sameRecord(left, right) {
  return stableJson(left) === stableJson(right);
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function integer(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function nonemptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function cliEvidencePath(args) {
  if (args.length === 0) return DEFAULT_CARRY_NO_SUBMIT_EVIDENCE_PATH;
  if (args.length === 2 && args[0] === "--evidence") return resolve(args[1]);
  throw new Error("Usage: verify-carry-no-submit-evidence.mjs [--evidence <path>]");
}

function cliExpectations(env = process.env) {
  const primarySecret = String(env.PRIVATE_AGENT_WORKER_CAPABILITY_SECRET || "").trim();
  const legacySecret = String(env.GHOLA_WORKER_CAPABILITY_SECRET || "").trim();
  if (primarySecret && legacySecret && primarySecret !== legacySecret) {
    throw new Error("worker_capability_secret_alias_mismatch");
  }
  return {
    expected_preview_url: env.CARRY_PROOF_EXPECTED_PREVIEW_URL,
    expected_web_commit_sha: env.CARRY_PROOF_EXPECTED_WEB_COMMIT_SHA,
    expected_worker_image_digest: env.CARRY_PROOF_EXPECTED_WORKER_IMAGE_DIGEST
      || env.PHALA_CVM_IMAGE_DIGEST
      || env.PRIVATE_AGENT_IMAGE_DIGEST,
    expected_signer_public_keys_b64: String(env.GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64 || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    shared_secret: primarySecret || legacySecret,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = verifyCarryNoSubmitEvidence(
      readCarryNoSubmitEvidenceFile(cliEvidencePath(process.argv.slice(2))),
      cliExpectations(),
    );
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
