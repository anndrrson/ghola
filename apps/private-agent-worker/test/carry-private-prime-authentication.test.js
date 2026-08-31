import assert from "node:assert/strict";
import test from "node:test";
import {
  createHmac,
  generateKeyPairSync,
  sign as signEd25519,
  verify as verifyEd25519,
} from "node:crypto";
import { carryPrivatePrimeWorkerAuthenticationMessage } from "@ghola/execution-core";
import {
  CarryPrivatePrimeAuthenticationError,
  authenticateCarryPrivatePrimeReadiness,
} from "../src/execution/carry-private-prime-authentication.js";

const NOW = 1_800_000_000_000;

test("authenticates private-prime evidence against the exact no-submit request", () => {
  const signer = generateKeyPairSync("ed25519");
  const signerPublicKeyB64 = signer.publicKey.export({ format: "der", type: "spki" }).toString("base64");
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
    sign_attested_message: (message) => ({
      signature_b64: signEd25519(null, message, signer.privateKey).toString("base64"),
      signer_public_key_b64: signerPublicKeyB64,
    }),
  });
  const message = carryPrivatePrimeWorkerAuthenticationMessage({
    route_path: "/carry/readiness",
    ...body,
    ...privatePrimeReadiness,
  });
  assert.deepEqual({
    version: proof.version,
    algorithm: proof.algorithm,
    request_bound: proof.request_bound,
    mac_hex: proof.mac_hex,
    signature_algorithm: proof.signature_algorithm,
    attestation_bound: proof.attestation_bound,
    signer_public_key_b64: proof.signer_public_key_b64,
    context: proof.context,
  }, {
    version: 1,
    algorithm: "hmac-sha256",
    request_bound: true,
    mac_hex: createHmac("sha256", "shared-worker-secret").update(message).digest("hex"),
    signature_algorithm: "ed25519",
    attestation_bound: true,
    signer_public_key_b64: signerPublicKeyB64,
    context: {
      route_path: "/carry/readiness",
      owner_commitment: "owner_commitment_0001",
      asset: "BTC",
      operation_class: "readiness_read",
      work_order_commitment: "carry_readiness_0001",
      evidence_commitment: `carry:private-prime:${"a".repeat(40)}`,
      checked_at_ms: NOW,
      expires_at_ms: NOW + 5_000,
    },
  });
  assert.equal(
    verifyEd25519(null, Buffer.from(message, "utf8"), signer.publicKey, Buffer.from(proof.signature_b64, "base64")),
    true,
  );
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
