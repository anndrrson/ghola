import { createHmac, timingSafeEqual } from "node:crypto";
import { carryPrivatePrimeWorkerAuthenticationMessage } from "@ghola/execution-core";
import { ed25519 } from "@noble/curves/ed25519";

type VerificationInput = {
  route_path: string;
  body: Record<string, unknown>;
  response: unknown;
  secret: string;
  now_ms?: number;
  env?: Record<string, string | undefined>;
};

export type CarryPrivatePrimeWorkerAuthenticationResult =
  | { ok: true }
  | {
      ok: false;
      error: "carry_private_prime_worker_authentication_invalid";
      reason: "shape" | "response_age" | "request_binding" | "signer_pin" | "mac" | "signature";
    };

const MAX_AUTHENTICATED_RESPONSE_AGE_MS = 30_000;

export function verifyCarryPrivatePrimeWorkerAuthentication({
  route_path,
  body,
  response,
  secret,
  now_ms = Date.now(),
  env = process.env,
}: VerificationInput): CarryPrivatePrimeWorkerAuthenticationResult {
  const result = record(response);
  const readiness = record(result.private_prime_readiness);
  const authentication = record(result.private_prime_authentication);
  const context = record(authentication.context);
  const ownerCommitment = string(body.owner_commitment);
  const asset = string(body.asset);
  const operationClass = string(body.operation_class);
  const workOrderCommitment = string(body.work_order_commitment);
  const checkedAtMs = integer(readiness.checked_at_ms);
  const expiresAtMs = nullableInteger(readiness.expires_at_ms);
  const evidenceCommitment = string(readiness.evidence_commitment);
  const macHex = string(authentication.mac_hex);
  const signatureB64 = string(authentication.signature_b64);
  const signerPublicKeyB64 = string(authentication.signer_public_key_b64);
  const validShape = Boolean(
    secret &&
    ownerCommitment &&
    asset &&
    operationClass &&
    workOrderCommitment &&
    checkedAtMs !== null &&
    expiresAtMs !== undefined &&
    /^carry:private-prime:[0-9a-f]{40}$/.test(evidenceCommitment) &&
    authentication.version === 1 &&
    authentication.algorithm === "hmac-sha256" &&
    authentication.request_bound === true &&
    /^[0-9a-f]{64}$/.test(macHex) &&
    authentication.signature_algorithm === "ed25519" &&
    authentication.attestation_bound === true &&
    signatureB64.length > 0 &&
    signerPublicKeyB64.length > 0
  );
  if (!validShape) return invalid("shape");
  if (checkedAtMs === null || expiresAtMs === undefined) return invalid("shape");
  // A valid negative readiness answer may contain expired or unavailable
  // evidence. Authenticate the fresh, one-work-order response itself while
  // leaving the readiness result fail-closed.
  if (checkedAtMs > now_ms + 1_000 || checkedAtMs < now_ms - MAX_AUTHENTICATED_RESPONSE_AGE_MS) {
    return invalid("response_age");
  }
  const requestBound = Boolean(
    readiness.owner_commitment === ownerCommitment &&
    readiness.asset === asset &&
    context.route_path === route_path &&
    context.owner_commitment === ownerCommitment &&
    context.asset === asset &&
    context.operation_class === operationClass &&
    context.work_order_commitment === workOrderCommitment &&
    context.evidence_commitment === evidenceCommitment &&
    context.checked_at_ms === checkedAtMs &&
    context.expires_at_ms === expiresAtMs
  );
  if (!requestBound) return invalid("request_binding");
  if (!signerAllowed(signerPublicKeyB64, env)) return invalid("signer_pin");
  const message = carryPrivatePrimeWorkerAuthenticationMessage(context);
  const expected = createHmac("sha256", secret).update(message).digest("hex");
  if (!safeHexEqual(macHex, expected)) return invalid("mac");
  if (!attestedSignatureValid(signatureB64, signerPublicKeyB64, message)) return invalid("signature");
  return { ok: true };
}

function invalid(reason: Exclude<CarryPrivatePrimeWorkerAuthenticationResult, { ok: true }>["reason"]): CarryPrivatePrimeWorkerAuthenticationResult {
  return { ok: false, error: "carry_private_prime_worker_authentication_invalid", reason };
}

function safeHexEqual(left: string, right: string) {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function signerAllowed(signerPublicKeyB64: string, env: Record<string, string | undefined>) {
  const pins = new Set((env.GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64 || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean));
  if (pins.size > 0) return pins.has(signerPublicKeyB64);
  return env.NODE_ENV === "test" ||
    env.GHOLA_CONNECTOR_MODE === "local_test" ||
    env.GHOLA_SHIELDED_POOL_MODE === "local_test";
}

function attestedSignatureValid(signatureB64: string, signerPublicKeyB64: string, message: string) {
  try {
    const signature = Uint8Array.from(Buffer.from(signatureB64, "base64"));
    const spki = Uint8Array.from(Buffer.from(signerPublicKeyB64, "base64"));
    if (signature.length !== 64 || spki.length < 32) return false;
    return ed25519.verify(
      signature,
      new TextEncoder().encode(message),
      spki.subarray(spki.length - 32),
    );
  } catch {
    return false;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function integer(value: unknown): number | null {
  return Number.isSafeInteger(value) ? Number(value) : null;
}

function nullableInteger(value: unknown): number | null | undefined {
  if (value === null) return null;
  return Number.isSafeInteger(value) ? Number(value) : undefined;
}
