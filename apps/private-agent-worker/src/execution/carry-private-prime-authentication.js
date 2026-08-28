import { createHmac } from "node:crypto";
import { carryPrivatePrimeWorkerAuthenticationMessage } from "@ghola/execution-core";
import { workerCapabilitySecret } from "../auth/capability.js";

export class CarryPrivatePrimeAuthenticationError extends Error {
  constructor(message = "private-prime worker authentication is not configured") {
    super(message);
    this.name = "CarryPrivatePrimeAuthenticationError";
    this.status = 503;
    this.code = "carry_private_prime_worker_authentication_unconfigured";
  }
}

export function carryPrivatePrimeAuthenticationSecret(env = process.env) {
  return workerCapabilitySecret(env) ||
    env.PRIVATE_AGENT_EXECUTION_TOKEN ||
    env.PHALA_CLOUD_API_KEY ||
    "";
}

export function authenticateCarryPrivatePrimeReadiness({
  route_path,
  body,
  private_prime_readiness,
  secret = carryPrivatePrimeAuthenticationSecret(),
}) {
  if (!secret) throw new CarryPrivatePrimeAuthenticationError();
  const message = carryPrivatePrimeWorkerAuthenticationMessage({
    route_path,
    owner_commitment: body?.owner_commitment,
    asset: body?.asset,
    operation_class: body?.operation_class,
    work_order_commitment: body?.work_order_commitment,
    evidence_commitment: private_prime_readiness?.evidence_commitment,
    checked_at_ms: private_prime_readiness?.checked_at_ms,
    expires_at_ms: private_prime_readiness?.expires_at_ms,
  });
  return Object.freeze({
    version: 1,
    algorithm: "hmac-sha256",
    request_bound: true,
    mac_hex: createHmac("sha256", secret).update(message).digest("hex"),
  });
}
