import assert from "node:assert/strict";
import test from "node:test";
import {
  generateKeyPairSync,
  sign as signEd25519,
  verify as verifyEd25519,
} from "node:crypto";
import { carryReleaseMaterialAuthenticationMessage } from "@ghola/execution-core";
import {
  authenticateCarryReleaseMaterial,
  carryReleaseMaterialResponseCommitment,
} from "../src/execution/carry-release-material-authentication.js";

const NOW = 1_800_000_000_000;

test("attests exact release material and its owner-scoped position request", () => {
  const signer = generateKeyPairSync("ed25519");
  const material = {
    version: 1,
    kind: "ghola_cross_venue_carry_mainnet_lifecycle_proof",
    position: { position_id: "carry:position:0001" },
    worker_material_commitment: `carry:release:material:${"a".repeat(64)}`,
  };
  const body = {
    owner_commitment: "owner_commitment_0001",
    position_id: "carry:position:0001",
  };
  const proof = authenticateCarryReleaseMaterial({
    route_path: "/carry/positions/release-evidence",
    body,
    material,
    checked_at_ms: NOW,
    sign_attested_message: (message) => ({
      signature_b64: signEd25519(null, message, signer.privateKey).toString("base64"),
      signer_public_key_b64: signer.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    }),
  });
  const message = carryReleaseMaterialAuthenticationMessage({
    route_path: "/carry/positions/release-evidence",
    ...body,
    material_commitment: carryReleaseMaterialResponseCommitment(material),
    checked_at_ms: NOW,
    expires_at_ms: NOW + 30_000,
  });
  assert.equal(proof.context.material_commitment, carryReleaseMaterialResponseCommitment(material));
  assert.equal(proof.material_replay_bound, true);
  assert.equal(
    verifyEd25519(null, Buffer.from(message), signer.publicKey, Buffer.from(proof.signature_b64, "base64")),
    true,
  );
  assert.notEqual(
    carryReleaseMaterialResponseCommitment({ ...material, network: "testnet" }),
    proof.context.material_commitment,
  );
});
