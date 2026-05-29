import test from "node:test";
import assert from "node:assert/strict";
import { verify as edVerify, createPublicKey } from "node:crypto";
import {
  attestFreshCredentialFunded,
  fundingAttestationMessage,
  fundingSigningIdentity,
  FundingAttestationError,
} from "../src/venues/shielded_funding_attestation.js";

const NATIVE = "ghola_shielded_pool";

function confirmedObservation(overrides = {}) {
  return {
    rail: NATIVE,
    relay_id: "relay-1",
    status: "confirmed",
    confirmations: 3,
    destination_commitment: "dest-1",
    amount_bucket: "25",
    observed_at: "2026-05-29T00:00:00.000Z",
    ...overrides,
  };
}

const base = {
  withdraw_bundle: { instruction_data_hex: "ab", accounts: [] },
  destination_commitment: "dest-1",
  amount_bucket: "25",
  minConfirmations: 3,
  now: () => new Date("2026-05-29T00:00:00.000Z"),
};

test("signs a verified funding attestation that verifies against the signer key", async () => {
  const out = await attestFreshCredentialFunded({
    ...base,
    fundImpl: async () => confirmedObservation(),
  });
  assert.equal(out.attestation.rail, NATIVE);
  assert.equal(out.attestation.confirmations, 3);
  assert.match(out.attestation.funding_evidence_commitment, /^[0-9a-f]{64}$/);

  const pub = createPublicKey({
    key: Buffer.from(out.signer_public_key_b64, "base64"),
    format: "der",
    type: "spki",
  });
  const ok = edVerify(
    null,
    fundingAttestationMessage(out.attestation),
    pub,
    Buffer.from(out.signature_b64, "base64"),
  );
  assert.equal(ok, true, "signature verifies against the returned signer key");
});

test("a tampered attestation fails signature verification", async () => {
  const out = await attestFreshCredentialFunded({
    ...base,
    fundImpl: async () => confirmedObservation(),
  });
  const pub = createPublicKey({
    key: Buffer.from(out.signer_public_key_b64, "base64"),
    format: "der",
    type: "spki",
  });
  const tampered = { ...out.attestation, amount_bucket: "100" };
  const ok = edVerify(
    null,
    fundingAttestationMessage(tampered),
    pub,
    Buffer.from(out.signature_b64, "base64"),
  );
  assert.equal(ok, false, "tampered amount_bucket invalidates the signature");
});

test("refuses to sign when the withdraw is not confirmed (fail-closed)", async () => {
  await assert.rejects(
    () =>
      attestFreshCredentialFunded({
        ...base,
        fundImpl: async () => confirmedObservation({ status: "pending", confirmations: 0 }),
      }),
    (err) => err instanceof FundingAttestationError && err.code === "funding_not_verified",
  );
});

test("refuses to sign on a destination mismatch", async () => {
  await assert.rejects(
    () =>
      attestFreshCredentialFunded({
        ...base,
        fundImpl: async () => confirmedObservation({ destination_commitment: "dest-OTHER" }),
      }),
    (err) => err.code === "funding_not_verified",
  );
});

test("refuses to sign on insufficient confirmations", async () => {
  await assert.rejects(
    () =>
      attestFreshCredentialFunded({
        ...base,
        minConfirmations: 5,
        fundImpl: async () => confirmedObservation({ confirmations: 3 }),
      }),
    (err) => err.code === "funding_not_verified",
  );
});

test("refuses to sign a non-native rail", async () => {
  await assert.rejects(
    () =>
      attestFreshCredentialFunded({
        ...base,
        fundImpl: async () => confirmedObservation({ rail: "railgun_evm" }),
      }),
    (err) => err.code === "funding_not_verified",
  );
});

test("signing identity is stable within a process", () => {
  const a = fundingSigningIdentity();
  const b = fundingSigningIdentity();
  assert.equal(a.public_key_b64, b.public_key_b64);
});
