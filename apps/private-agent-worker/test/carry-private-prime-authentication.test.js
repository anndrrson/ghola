import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { carryPrivatePrimeWorkerAuthenticationMessage } from "@ghola/execution-core";
import {
  CarryPrivatePrimeAuthenticationError,
  authenticateCarryPrivatePrimeReadiness,
} from "../src/execution/carry-private-prime-authentication.js";

const NOW = 1_800_000_000_000;

test("authenticates private-prime evidence against the exact no-submit request", () => {
  const body = {
    owner_commitment: "owner_commitment_0001",
    asset: "BTC",
    operation_class: "readiness_read",
    work_order_commitment: "carry_readiness_0001",
  };
  const privatePrimeReadiness = {
    evidence_commitment: `carry:private-prime:${"a".repeat(40)}`,
    checked_at_ms: NOW,
    expires_at_ms: NOW + 5_000,
  };
  const proof = authenticateCarryPrivatePrimeReadiness({
    route_path: "/carry/readiness",
    body,
    private_prime_readiness: privatePrimeReadiness,
    secret: "shared-worker-secret",
  });
  const message = carryPrivatePrimeWorkerAuthenticationMessage({
    route_path: "/carry/readiness",
    ...body,
    ...privatePrimeReadiness,
  });
  assert.deepEqual(proof, {
    version: 1,
    algorithm: "hmac-sha256",
    request_bound: true,
    mac_hex: createHmac("sha256", "shared-worker-secret").update(message).digest("hex"),
  });
});

test("fails closed without a shared authentication secret", () => {
  assert.throws(
    () => authenticateCarryPrivatePrimeReadiness({
      route_path: "/carry/readiness",
      body: {},
      private_prime_readiness: {},
      secret: "",
    }),
    CarryPrivatePrimeAuthenticationError,
  );
});
