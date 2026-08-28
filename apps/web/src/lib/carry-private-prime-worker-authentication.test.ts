import { createHmac, generateKeyPairSync, sign as signEd25519 } from "node:crypto";
import { carryPrivatePrimeWorkerAuthenticationMessage } from "@ghola/execution-core";
import { describe, expect, it } from "vitest";
import { verifyCarryPrivatePrimeWorkerAuthentication } from "./carry-private-prime-worker-authentication";

const NOW = 1_800_000_000_000;
const SECRET = "shared-worker-secret";
const SIGNER = generateKeyPairSync("ed25519");
const SIGNER_PUBLIC_KEY_B64 = SIGNER.publicKey.export({ format: "der", type: "spki" }).toString("base64");

describe("private-prime worker authentication", () => {
  it("accepts only fresh evidence bound to the exact owner request", () => {
    expect(verifyCarryPrivatePrimeWorkerAuthentication({
      route_path: "/carry/readiness",
      body: body(),
      response: response(),
      secret: SECRET,
      now_ms: NOW,
      env: { NODE_ENV: "production", GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64: SIGNER_PUBLIC_KEY_B64 },
    })).toEqual({ ok: true });
  });

  it("rejects tampering, replay under another work order, expiry, and missing authentication", () => {
    const tampered = response();
    tampered.private_prime_readiness.asset = "ETH";
    expect(verify(tampered).ok).toBe(false);
    expect(verify(response(), { work_order_commitment: "carry_readiness_other" }).ok).toBe(false);
    expect(verify(response(), {}, NOW + 5_001).ok).toBe(false);
    expect(verify({ private_prime_readiness: response().private_prime_readiness }).ok).toBe(false);
    expect(verifyCarryPrivatePrimeWorkerAuthentication({
      route_path: "/carry/readiness",
      body: body(),
      response: response(),
      secret: SECRET,
      now_ms: NOW,
      env: { NODE_ENV: "production", GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64: "wrong-pin" },
    }).ok).toBe(false);
  });
});

function verify(
  value: ReturnType<typeof response> | { private_prime_readiness: Record<string, unknown> },
  bodyOverrides: Record<string, unknown> = {},
  nowMs = NOW,
) {
  return verifyCarryPrivatePrimeWorkerAuthentication({
    route_path: "/carry/readiness",
    body: body(bodyOverrides),
    response: value,
    secret: SECRET,
    now_ms: nowMs,
    env: { NODE_ENV: "test" },
  });
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    owner_commitment: "owner_commitment_0001",
    asset: "BTC",
    operation_class: "readiness_read",
    work_order_commitment: "carry_readiness_0001",
    ...overrides,
  };
}

function response() {
  const privatePrimeReadiness = {
    owner_commitment: "owner_commitment_0001",
    asset: "BTC",
    evidence_commitment: `carry:private-prime:${"a".repeat(40)}`,
    checked_at_ms: NOW,
    expires_at_ms: NOW + 5_000,
  };
  const message = carryPrivatePrimeWorkerAuthenticationMessage({
    route_path: "/carry/readiness",
    ...body(),
    ...privatePrimeReadiness,
  });
  return {
    private_prime_readiness: privatePrimeReadiness,
    private_prime_authentication: {
      version: 1,
      algorithm: "hmac-sha256",
      request_bound: true,
      mac_hex: createHmac("sha256", SECRET).update(message).digest("hex"),
      signature_algorithm: "ed25519",
      attestation_bound: true,
      signature_b64: signEd25519(null, Buffer.from(message, "utf8"), SIGNER.privateKey).toString("base64"),
      signer_public_key_b64: SIGNER_PUBLIC_KEY_B64,
    },
  };
}
