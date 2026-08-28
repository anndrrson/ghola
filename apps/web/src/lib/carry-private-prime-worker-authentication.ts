import { createHmac, timingSafeEqual } from "node:crypto";
import { carryPrivatePrimeWorkerAuthenticationMessage } from "@ghola/execution-core";

type VerificationInput = {
  route_path: string;
  body: Record<string, unknown>;
  response: unknown;
  secret: string;
  now_ms?: number;
};

export type CarryPrivatePrimeWorkerAuthenticationResult =
  | { ok: true }
  | { ok: false; error: "carry_private_prime_worker_authentication_invalid" };

export function verifyCarryPrivatePrimeWorkerAuthentication({
  route_path,
  body,
  response,
  secret,
  now_ms = Date.now(),
}: VerificationInput): CarryPrivatePrimeWorkerAuthenticationResult {
  const result = record(response);
  const readiness = record(result.private_prime_readiness);
  const authentication = record(result.private_prime_authentication);
  const ownerCommitment = string(body.owner_commitment);
  const asset = string(body.asset);
  const operationClass = string(body.operation_class);
  const workOrderCommitment = string(body.work_order_commitment);
  const checkedAtMs = integer(readiness.checked_at_ms);
  const expiresAtMs = integer(readiness.expires_at_ms);
  const evidenceCommitment = string(readiness.evidence_commitment);
  const macHex = string(authentication.mac_hex);
  const validShape = Boolean(
    secret &&
    ownerCommitment &&
    asset &&
    operationClass &&
    workOrderCommitment &&
    checkedAtMs !== null &&
    expiresAtMs !== null &&
    checkedAtMs <= now_ms + 1_000 &&
    expiresAtMs > now_ms &&
    readiness.owner_commitment === ownerCommitment &&
    readiness.asset === asset &&
    /^carry:private-prime:[0-9a-f]{40}$/.test(evidenceCommitment) &&
    authentication.version === 1 &&
    authentication.algorithm === "hmac-sha256" &&
    authentication.request_bound === true &&
    /^[0-9a-f]{64}$/.test(macHex)
  );
  if (!validShape) return invalid();
  const expected = createHmac("sha256", secret).update(
    carryPrivatePrimeWorkerAuthenticationMessage({
      route_path,
      owner_commitment: ownerCommitment,
      asset,
      operation_class: operationClass,
      work_order_commitment: workOrderCommitment,
      evidence_commitment: evidenceCommitment,
      checked_at_ms: checkedAtMs,
      expires_at_ms: expiresAtMs,
    }),
  ).digest("hex");
  return safeHexEqual(macHex, expected) ? { ok: true } : invalid();
}

function invalid(): CarryPrivatePrimeWorkerAuthenticationResult {
  return { ok: false, error: "carry_private_prime_worker_authentication_invalid" };
}

function safeHexEqual(left: string, right: string) {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
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
