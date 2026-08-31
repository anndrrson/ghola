import { createHash, generateKeyPairSync, sign as signEd25519 } from "node:crypto";
import {
  canonicalCarryCommitmentJson,
  carryReleaseMaterialAuthenticationMessage,
} from "@ghola/execution-core";
import { describe, expect, it } from "vitest";
import { verifyCarryReleaseMaterialWorkerAuthentication } from "./carry-release-material-worker-authentication";

const NOW = 1_800_000_000_000;
const SIGNER = generateKeyPairSync("ed25519");
const SIGNER_PUBLIC_KEY_B64 = SIGNER.publicKey.export({ format: "der", type: "spki" }).toString("base64");
const ROUTE = "/carry/positions/release-evidence";
const BODY = {
  owner_commitment: "owner_commitment_0001",
  position_id: "carry:position:0001",
};

describe("Carry release-material worker authentication", () => {
  it("accepts only exact fresh release material for the requested owner and position", () => {
    expect(verify(response())).toEqual({ ok: true });
    const changedMaterial = response();
    changedMaterial.material = { ...changedMaterial.material, network: "testnet" };
    expect(verify(changedMaterial).ok).toBe(false);
    expect(verify(response(), { body: { ...BODY, owner_commitment: "owner_commitment_other" } }).ok).toBe(false);
    expect(verify(response(), { body: { ...BODY, position_id: "carry:position:other" } }).ok).toBe(false);
    expect(verify(response(), { now_ms: NOW + 30_000 }).ok).toBe(false);
    expect(verify(response(), {
      env: { NODE_ENV: "production", GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64: "wrong-pin" },
    }).ok).toBe(false);
  });
});

function verify(value: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return verifyCarryReleaseMaterialWorkerAuthentication({
    route_path: ROUTE,
    body: BODY,
    response: value,
    now_ms: NOW + 1,
    env: { NODE_ENV: "production", GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64: SIGNER_PUBLIC_KEY_B64 },
    ...overrides,
  });
}

function response() {
  const material = {
    version: 1,
    kind: "ghola_cross_venue_carry_mainnet_lifecycle_proof",
    network: "mainnet",
    position: { position_id: BODY.position_id },
    worker_material_commitment: `carry:release:material:${"a".repeat(64)}`,
  };
  const materialCommitment = `carry:release-response:${createHash("sha256")
    .update(canonicalCarryCommitmentJson(material))
    .digest("hex")}`;
  const context = {
    route_path: ROUTE,
    ...BODY,
    material_commitment: materialCommitment,
    checked_at_ms: NOW,
    expires_at_ms: NOW + 30_000,
  };
  const message = carryReleaseMaterialAuthenticationMessage(context);
  return {
    ok: true,
    material,
    worker_authentication: {
      version: 1,
      algorithm: "ed25519",
      attestation_bound: true,
      request_bound: true,
      material_replay_bound: true,
      signature_b64: signEd25519(null, Buffer.from(message), SIGNER.privateKey).toString("base64"),
      signer_public_key_b64: SIGNER_PUBLIC_KEY_B64,
      context,
    },
  };
}
