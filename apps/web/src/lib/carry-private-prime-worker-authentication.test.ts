import { createHmac } from "node:crypto";
import { carryPrivatePrimeWorkerAuthenticationMessage } from "@ghola/execution-core";
import { describe, expect, it } from "vitest";
import { verifyCarryPrivatePrimeWorkerAuthentication } from "./carry-private-prime-worker-authentication";

const NOW = 1_800_000_000_000;
const SECRET = "shared-worker-secret";

describe("private-prime worker authentication", () => {
  it("accepts only fresh evidence bound to the exact owner request", () => {
    expect(verifyCarryPrivatePrimeWorkerAuthentication({
      route_path: "/carry/readiness",
      body: body(),
      response: response(),
      secret: SECRET,
      now_ms: NOW,
    })).toEqual({ ok: true });
  });

  it("rejects tampering, replay under another work order, expiry, and missing authentication", () => {
    const tampered = response();
    tampered.private_prime_readiness.asset = "ETH";
    expect(verify(tampered).ok).toBe(false);
    expect(verify(response(), { work_order_commitment: "carry_readiness_other" }).ok).toBe(false);
    expect(verify(response(), {}, NOW + 5_001).ok).toBe(false);
    expect(verify({ private_prime_readiness: response().private_prime_readiness }).ok).toBe(false);
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
    },
  };
}
