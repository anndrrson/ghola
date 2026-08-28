import { createHash, generateKeyPairSync, sign as signEd25519 } from "node:crypto";
import { carryCreationOpportunityAuthenticationMessage } from "@ghola/execution-core";
import { describe, expect, it } from "vitest";
import { verifyCarryCreationOpportunityWorkerAuthentication } from "./carry-creation-opportunity-authentication";

const NOW = 1_800_000_000_000;
const OWNER = "owner_commitment_0001";
const SIGNER = generateKeyPairSync("ed25519");
const SIGNER_PUBLIC_KEY_B64 = SIGNER.publicKey.export({ format: "der", type: "spki" }).toString("base64");

describe("Carry creation-opportunity worker authentication", () => {
  it("accepts fresh deterministic economics signed by the pinned worker", () => {
    expect(verify(opportunity())).toEqual({ ok: true });
  });

  it("rejects changed economics, another owner, expiry, missing proof, and a wrong signer pin", () => {
    expect(verify({ ...opportunity(), projected_net_value_micro_usdc: 999 }).ok).toBe(false);
    expect(verify(opportunity(), { owner_commitment: "owner_commitment_other" }).ok).toBe(false);
    expect(verify(opportunity(), { now_ms: NOW + 60_000 }).ok).toBe(false);
    expect(verify({ checked_at_ms: NOW, projected_net_value_micro_usdc: 123 }).ok).toBe(false);
    expect(verify(opportunity(), {
      env: { NODE_ENV: "production", GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64: "wrong-pin" },
    }).ok).toBe(false);
  });
});

function verify(value: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return verifyCarryCreationOpportunityWorkerAuthentication({
    owner_commitment: OWNER,
    opportunity: value,
    now_ms: NOW + 1,
    env: { NODE_ENV: "production", GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64: SIGNER_PUBLIC_KEY_B64 },
    ...overrides,
  });
}

function opportunity() {
  const unsigned = {
    version: 1,
    asset: "BTC",
    checked_at_ms: NOW,
    projected_net_value_micro_usdc: 123,
  };
  const expiresAtMs = NOW + 60_000;
  const message = carryCreationOpportunityAuthenticationMessage({
    owner_commitment: OWNER,
    opportunity: unsigned,
    checked_at_ms: NOW,
    expires_at_ms: expiresAtMs,
  });
  return {
    ...unsigned,
    worker_authentication: {
      version: 1,
      algorithm: "ed25519",
      attestation_bound: true,
      deterministic_only: true,
      checked_at_ms: NOW,
      expires_at_ms: expiresAtMs,
      evidence_commitment: `carry:creation-opportunity:evidence:${createHash("sha256").update(message).digest("hex")}`,
      signature_b64: signEd25519(null, Buffer.from(message, "utf8"), SIGNER.privateKey).toString("base64"),
      signer_public_key_b64: SIGNER_PUBLIC_KEY_B64,
    },
  };
}
