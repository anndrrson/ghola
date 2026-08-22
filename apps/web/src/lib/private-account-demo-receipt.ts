import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import { didKeyFromVerifying, verifyingFromDidKey } from "./envelope";
import type { PublicPrivateAgentDemoRun } from "./private-account-demo";

const TOKEN_TYPE = "GHOLA-PRIVATE-AGENT-REVIEW-PROOF";
const TOKEN_VERSION = 1;
const TOKEN_SEGMENT_COUNT = 3;
const MAX_TOKEN_LENGTH = 32_768;
const DEFAULT_PUBLIC_ORIGIN = "https://ghola.xyz";

export interface PublicPrivateAgentDemoVerification {
  version: 1;
  status: "signed_exact_receipt";
  method: "Ed25519";
  signer_did: string;
  receipt_sha256: string;
  token: string;
  verification_url: string;
  public_key_url: string;
  scope: "exact_no_submit_receipt_integrity";
  limitation: string;
}

export interface PublicPrivateAgentDemoVerificationUnavailable {
  version: 1;
  status: "unavailable";
  reason_code:
    | "review_proof_signing_key_missing"
    | "review_proof_signer_did_mismatch"
    | "review_proof_signing_failed"
    | "review_proof_no_submit_invariant_failed";
  scope: "exact_no_submit_receipt_integrity";
}

export type PublicPrivateAgentDemoVerificationResult =
  | PublicPrivateAgentDemoVerification
  | PublicPrivateAgentDemoVerificationUnavailable;

interface ReviewProofHeader {
  alg: "EdDSA";
  kid: string;
  typ: typeof TOKEN_TYPE;
  v: 1;
}

export interface PublicPrivateAgentExactReviewReceipt {
  version: 1;
  checked_at: string;
  status: PublicPrivateAgentDemoRun["status"];
  demo_run_id: string;
  execution_mode: "public_no_submit";
  wallet_required: false;
  deposit_required: false;
  broadcast: false;
  scenario: PublicPrivateAgentDemoRun["scenario"];
  execution_ticket: PublicPrivateAgentDemoRun["execution_ticket"];
  proof_chain: PublicPrivateAgentDemoRun["proof_chain"];
  worker: PublicPrivateAgentDemoRun["worker"];
}

interface ReviewProofPayload {
  schema: "ghola.private-agent.review-proof.v1";
  issuer: string;
  signer_did: string;
  receipt_sha256: string;
  receipt: PublicPrivateAgentExactReviewReceipt;
}

export interface VerifiedPublicPrivateAgentDemoToken {
  valid: true;
  signature_valid: true;
  receipt_hash_matches: true;
  signer_did: string;
  receipt_sha256: string;
  receipt: PublicPrivateAgentExactReviewReceipt;
}

export interface InvalidPublicPrivateAgentDemoToken {
  valid: false;
  signature_valid: boolean;
  receipt_hash_matches: boolean;
  reason_code:
    | "review_proof_signing_key_missing"
    | "review_proof_signer_did_mismatch"
    | "review_proof_token_malformed"
    | "review_proof_header_invalid"
    | "review_proof_signer_mismatch"
    | "review_proof_signature_invalid"
    | "review_proof_payload_invalid"
    | "review_proof_receipt_hash_mismatch"
    | "review_proof_no_submit_invariant_failed";
}

export type PublicPrivateAgentDemoTokenVerification =
  | VerifiedPublicPrivateAgentDemoToken
  | InvalidPublicPrivateAgentDemoToken;

export function signPublicPrivateAgentDemoRun(
  receipt: PublicPrivateAgentDemoRun,
  env: Record<string, string | undefined> = process.env,
): PublicPrivateAgentDemoVerificationResult {
  const signingKey = reviewProofSigningKey(env);
  if (!signingKey) return unavailable("review_proof_signing_key_missing");

  try {
    const publicKey = ed25519.getPublicKey(signingKey);
    const signerDid = didKeyFromVerifying(publicKey);
    if (!reviewProofSignerDidMatches(signerDid, env)) {
      return unavailable("review_proof_signer_did_mismatch");
    }
    const origin = publicOrigin(env);
    const exactReceipt = exactReviewReceipt(receipt);
    if (!hasNoSubmitReceiptInvariants(exactReceipt)) {
      return unavailable("review_proof_no_submit_invariant_failed");
    }
    const receiptJson = stableJson(exactReceipt);
    const receiptSha256 = sha256Hex(receiptJson);
    const header: ReviewProofHeader = {
      alg: "EdDSA",
      kid: signerDid,
      typ: TOKEN_TYPE,
      v: TOKEN_VERSION,
    };
    const payload: ReviewProofPayload = {
      schema: "ghola.private-agent.review-proof.v1",
      issuer: origin,
      signer_did: signerDid,
      receipt_sha256: receiptSha256,
      receipt: exactReceipt,
    };
    const encodedHeader = encodeJson(header);
    const encodedPayload = encodeJson(payload);
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const signature = ed25519.sign(new TextEncoder().encode(signingInput), signingKey);
    const token = `${signingInput}.${Buffer.from(signature).toString("base64url")}`;
    const verifyPath = "/v1/private-account/demo/verify";

    return {
      version: 1,
      status: "signed_exact_receipt",
      method: "Ed25519",
      signer_did: signerDid,
      receipt_sha256: receiptSha256,
      token,
      verification_url: `${origin}${verifyPath}?token=${encodeURIComponent(token)}`,
      public_key_url: `${origin}/v1/private-account/demo/verification-key`,
      scope: "exact_no_submit_receipt_integrity",
      limitation:
        "The issuer signature proves the exact receipt was not altered. It does not replace independent venue, chain, or TEE-vendor verification.",
    };
  } catch {
    return unavailable("review_proof_signing_failed");
  }
}

function exactReviewReceipt(receipt: PublicPrivateAgentDemoRun): PublicPrivateAgentExactReviewReceipt {
  return {
    version: receipt.version,
    checked_at: receipt.checked_at,
    status: receipt.status,
    demo_run_id: receipt.demo_run_id,
    execution_mode: receipt.execution_mode,
    wallet_required: receipt.wallet_required,
    deposit_required: receipt.deposit_required,
    broadcast: receipt.broadcast,
    scenario: receipt.scenario,
    execution_ticket: receipt.execution_ticket,
    proof_chain: receipt.proof_chain,
    worker: receipt.worker,
  };
}

export function verifyPublicPrivateAgentDemoToken(
  token: string,
  env: Record<string, string | undefined> = process.env,
): PublicPrivateAgentDemoTokenVerification {
  const signingKey = reviewProofSigningKey(env);
  if (!signingKey) return invalid("review_proof_signing_key_missing");
  const publicKey = ed25519.getPublicKey(signingKey);
  const signerDid = didKeyFromVerifying(publicKey);
  if (!reviewProofSignerDidMatches(signerDid, env)) {
    return invalid("review_proof_signer_did_mismatch");
  }
  if (!token || token.length > MAX_TOKEN_LENGTH) return invalid("review_proof_token_malformed");

  const segments = token.split(".");
  if (segments.length !== TOKEN_SEGMENT_COUNT || segments.some((segment) => !segment)) {
    return invalid("review_proof_token_malformed");
  }
  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  const header = decodeJson(encodedHeader);
  if (!isReviewProofHeader(header)) return invalid("review_proof_header_invalid");

  if (header.kid !== signerDid) return invalid("review_proof_signer_mismatch");

  let signature: Uint8Array;
  try {
    signature = Uint8Array.from(Buffer.from(encodedSignature, "base64url"));
  } catch {
    return invalid("review_proof_token_malformed");
  }
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signatureValid = signature.length === 64 && ed25519.verify(
    signature,
    new TextEncoder().encode(signingInput),
    verifyingFromDidKey(signerDid),
  );
  if (!signatureValid) return invalid("review_proof_signature_invalid");

  const payload = decodeJson(encodedPayload);
  if (!isReviewProofPayload(payload, signerDid)) {
    return invalid("review_proof_payload_invalid", true);
  }
  const receiptSha256 = sha256Hex(stableJson(payload.receipt));
  if (receiptSha256 !== payload.receipt_sha256) {
    return invalid("review_proof_receipt_hash_mismatch", true, false);
  }
  if (!hasNoSubmitReceiptInvariants(payload.receipt)) {
    return invalid("review_proof_no_submit_invariant_failed", true, true);
  }

  return {
    valid: true,
    signature_valid: true,
    receipt_hash_matches: true,
    signer_did: signerDid,
    receipt_sha256: receiptSha256,
    receipt: payload.receipt,
  };
}

export function publicReviewProofKey(
  env: Record<string, string | undefined> = process.env,
): { configured: true; algorithm: "Ed25519"; signer_did: string; public_key_b64url: string } |
  {
    configured: false;
    algorithm: "Ed25519";
    reason_code: "review_proof_signing_key_missing" | "review_proof_signer_did_mismatch";
  } {
  const signingKey = reviewProofSigningKey(env);
  if (!signingKey) {
    return {
      configured: false,
      algorithm: "Ed25519",
      reason_code: "review_proof_signing_key_missing",
    };
  }
  const publicKey = ed25519.getPublicKey(signingKey);
  const signerDid = didKeyFromVerifying(publicKey);
  if (!reviewProofSignerDidMatches(signerDid, env)) {
    return {
      configured: false,
      algorithm: "Ed25519",
      reason_code: "review_proof_signer_did_mismatch",
    };
  }
  return {
    configured: true,
    algorithm: "Ed25519",
    signer_did: signerDid,
    public_key_b64url: Buffer.from(publicKey).toString("base64url"),
  };
}

function reviewProofSigningKey(env: Record<string, string | undefined>): Uint8Array | null {
  const raw = env.GHOLA_REVIEW_PROOF_SIGNING_KEY_B64?.trim();
  if (!raw) return null;
  try {
    const bytes = /^[0-9a-f]{64}$/i.test(raw)
      ? Buffer.from(raw, "hex")
      : Buffer.from(raw, raw.includes("-") || raw.includes("_") ? "base64url" : "base64");
    return bytes.length === 32 ? Uint8Array.from(bytes) : null;
  } catch {
    return null;
  }
}

function reviewProofSignerDidMatches(
  signerDid: string,
  env: Record<string, string | undefined>,
): boolean {
  const expected = env.GHOLA_REVIEW_PROOF_SIGNER_DID?.trim();
  return !expected || expected === signerDid;
}

function publicOrigin(env: Record<string, string | undefined>): string {
  const raw = env.GHOLA_PUBLIC_ORIGIN?.trim() || DEFAULT_PUBLIC_ORIGIN;
  try {
    const url = new URL(raw);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
      return DEFAULT_PUBLIC_ORIGIN;
    }
    return url.origin;
  } catch {
    return DEFAULT_PUBLIC_ORIGIN;
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function encodeJson(value: unknown): string {
  return Buffer.from(stableJson(value), "utf8").toString("base64url");
}

function decodeJson(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function isReviewProofHeader(value: unknown): value is ReviewProofHeader {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const header = value as Record<string, unknown>;
  return header.alg === "EdDSA" &&
    typeof header.kid === "string" &&
    header.kid.startsWith("did:key:z") &&
    header.typ === TOKEN_TYPE &&
    header.v === TOKEN_VERSION;
}

function isReviewProofPayload(value: unknown, signerDid: string): value is ReviewProofPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  return payload.schema === "ghola.private-agent.review-proof.v1" &&
    typeof payload.issuer === "string" &&
    payload.signer_did === signerDid &&
    typeof payload.receipt_sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(payload.receipt_sha256) &&
    Boolean(payload.receipt) &&
    typeof payload.receipt === "object" &&
    !Array.isArray(payload.receipt);
}

function hasNoSubmitReceiptInvariants(receipt: unknown): receipt is PublicPrivateAgentExactReviewReceipt {
  if (!isRecord(receipt)) return false;
  const ticket = isRecord(receipt.execution_ticket) ? receipt.execution_ticket : null;
  const scenario = isRecord(receipt.scenario) ? receipt.scenario : null;
  const worker = isRecord(receipt.worker) ? receipt.worker : null;
  if (!ticket || !scenario || !worker || !Array.isArray(receipt.proof_chain)) return false;

  const ticketId = ticket.ticket_id;
  const commitments = [
    "policy_commitment",
    "private_intent_commitment",
    "strategy_commitment",
    "sealed_envelope_commitment",
    "work_order_commitment",
    "attestation_commitment",
    "result_commitment",
  ];
  return receipt.version === 1 &&
    typeof receipt.checked_at === "string" &&
    Number.isFinite(Date.parse(receipt.checked_at)) &&
    ["verified_no_submit_structural", "degraded", "blocked"].includes(String(receipt.status)) &&
    receipt.execution_mode === "public_no_submit" &&
    receipt.wallet_required === false &&
    receipt.deposit_required === false &&
    receipt.broadcast === false &&
    typeof ticketId === "string" &&
    ticketId.length > 0 &&
    receipt.demo_run_id === ticketId &&
    ticket.version === 1 &&
    commitments.every((field) => typeof ticket[field] === "string" && ticket[field].length > 0) &&
    typeof ticket.expires_at === "string" &&
    Number.isFinite(Date.parse(ticket.expires_at)) &&
    typeof scenario.scenario_id === "string" &&
    typeof scenario.venue_id === "string" &&
    typeof scenario.market_id === "string" &&
    typeof worker.ready === "boolean" &&
    typeof worker.attested_ready === "boolean" &&
    receipt.proof_chain.length > 0 &&
    receipt.proof_chain.every((step) =>
      isRecord(step) && typeof step.step === "string" && typeof step.commitment === "string"
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unavailable(
  reasonCode: PublicPrivateAgentDemoVerificationUnavailable["reason_code"],
): PublicPrivateAgentDemoVerificationUnavailable {
  return {
    version: 1,
    status: "unavailable",
    reason_code: reasonCode,
    scope: "exact_no_submit_receipt_integrity",
  };
}

function invalid(
  reasonCode: InvalidPublicPrivateAgentDemoToken["reason_code"],
  signatureValid = false,
  receiptHashMatches = false,
): InvalidPublicPrivateAgentDemoToken {
  return {
    valid: false,
    signature_valid: signatureValid,
    receipt_hash_matches: receiptHashMatches,
    reason_code: reasonCode,
  };
}
