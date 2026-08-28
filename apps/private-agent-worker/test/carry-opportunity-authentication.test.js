import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signEd25519 } from "node:crypto";
import test from "node:test";
import {
  authenticateCarryCreationOpportunity,
  verifyCarryCreationOpportunityAuthentication,
} from "../src/execution/carry-opportunity-authentication.js";

const NOW = 1_800_000_000_000;
const OWNER = "owner_commitment_0001";

test("authenticates exact deterministic Carry creation economics", () => {
  const signer = generateKeyPairSync("ed25519");
  const publicKey = signer.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const opportunity = { version: 1, asset: "BTC", checked_at_ms: NOW, projected_net_value_micro_usdc: 123 };
  const workerAuthentication = authenticateCarryCreationOpportunity({
    owner_commitment: OWNER,
    opportunity,
    sign_attested_message: (message) => ({
      signature_b64: signEd25519(null, message, signer.privateKey).toString("base64"),
      signer_public_key_b64: publicKey,
    }),
  });
  const verified = verifyCarryCreationOpportunityAuthentication({
    owner_commitment: OWNER,
    opportunity: { ...opportunity, worker_authentication: workerAuthentication },
    now_ms: NOW + 1,
    expected_signer_public_key_b64: publicKey,
  });
  assert.equal(verified.ok, true);
  assert.match(verified.authentication.evidence_commitment, /^carry:creation-opportunity:evidence:[0-9a-f]{64}$/);
});

test("rejects changed economics, wrong owners, signers, and expired evidence", () => {
  const signer = generateKeyPairSync("ed25519");
  const otherSigner = generateKeyPairSync("ed25519");
  const publicKey = signer.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const opportunity = { version: 1, asset: "BTC", checked_at_ms: NOW, projected_net_value_micro_usdc: 123 };
  const workerAuthentication = authenticateCarryCreationOpportunity({
    owner_commitment: OWNER,
    opportunity,
    sign_attested_message: (message) => ({
      signature_b64: signEd25519(null, message, signer.privateKey).toString("base64"),
      signer_public_key_b64: publicKey,
    }),
  });
  const authenticated = { ...opportunity, worker_authentication: workerAuthentication };
  const verify = (changes = {}) => verifyCarryCreationOpportunityAuthentication({
    owner_commitment: OWNER,
    opportunity: authenticated,
    now_ms: NOW + 1,
    expected_signer_public_key_b64: publicKey,
    ...changes,
  });
  assert.equal(verify({ opportunity: { ...authenticated, projected_net_value_micro_usdc: 999 } }).ok, false);
  assert.equal(verify({ owner_commitment: "other_owner_0001" }).ok, false);
  assert.equal(verify({ expected_signer_public_key_b64: otherSigner.publicKey.export({ format: "der", type: "spki" }).toString("base64") }).error, "carry_opportunity_worker_signer_mismatch");
  assert.equal(verify({ now_ms: NOW + 60_000 }).error, "carry_opportunity_worker_authentication_invalid");
});
