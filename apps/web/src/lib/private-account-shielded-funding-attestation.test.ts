import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import {
  verifyWorkerFundingAttestation,
  defaultEd25519Verify,
  NATIVE_SHIELDED_RAIL,
  type SignedWorkerFundingAttestation,
  type WorkerFundingAttestation,
} from "./private-account-shielded-funding";

const VERSION = "ghola-shielded-funding-attestation-v1";

// Mirror the worker's canonical signed message bytes exactly.
function message(att: WorkerFundingAttestation): Buffer {
  return Buffer.from(
    JSON.stringify({
      version: att.version,
      rail: att.rail,
      destination_commitment: att.destination_commitment,
      amount_bucket: att.amount_bucket,
      confirmations: att.confirmations,
      verified_at: att.verified_at,
    }),
    "utf8",
  );
}

function makeSigned(
  overrides: Partial<WorkerFundingAttestation> = {},
): { signed: SignedWorkerFundingAttestation; pubB64: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const att: WorkerFundingAttestation = {
    version: VERSION,
    rail: NATIVE_SHIELDED_RAIL,
    destination_commitment: "dest-1",
    amount_bucket: "25",
    confirmations: 3,
    verified_at: "2026-05-29T00:00:00.000Z",
    funding_evidence_commitment: "a".repeat(64),
    ...overrides,
  };
  const signature = nodeSign(null, message(att), privateKey);
  return {
    signed: {
      attestation: att,
      signature_b64: signature.toString("base64"),
      signer_public_key_b64: pubB64,
    },
    pubB64,
  };
}

describe("verifyWorkerFundingAttestation", () => {
  const OLD = { ...process.env };
  beforeEach(() => {
    process.env = { ...OLD };
    delete process.env.GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64;
  });
  afterEach(() => {
    process.env = { ...OLD };
  });

  it("accepts a valid worker-signed attestation (unpinned/dev)", () => {
    const { signed } = makeSigned();
    const res = verifyWorkerFundingAttestation(signed, "dest-1", 3, defaultEd25519Verify);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.funding_evidence_commitment).toBe("a".repeat(64));
      expect(res.amount_bucket).toBe("25");
    }
  });

  it("accepts when the signer key is pinned", () => {
    const { signed, pubB64 } = makeSigned();
    process.env.GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64 = pubB64;
    const res = verifyWorkerFundingAttestation(signed, "dest-1", 3, defaultEd25519Verify);
    expect(res.ok).toBe(true);
  });

  it("rejects when the signer key is not in the pinned set", () => {
    const { signed } = makeSigned();
    process.env.GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64 = "someOtherPinnedKeyB64";
    const res = verifyWorkerFundingAttestation(signed, "dest-1", 3, defaultEd25519Verify);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("signer_not_pinned");
  });

  it("rejects a tampered attestation (signature mismatch)", () => {
    const { signed } = makeSigned();
    const tampered: SignedWorkerFundingAttestation = {
      ...signed,
      attestation: { ...signed.attestation, amount_bucket: "100" },
    };
    const res = verifyWorkerFundingAttestation(tampered, "dest-1", 3, defaultEd25519Verify);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("signature_invalid");
  });

  it("rejects a destination mismatch", () => {
    const { signed } = makeSigned({ destination_commitment: "dest-OTHER" });
    const res = verifyWorkerFundingAttestation(signed, "dest-1", 3, defaultEd25519Verify);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("destination_mismatch");
  });

  it("rejects a non-native rail", () => {
    const { signed } = makeSigned({ rail: "railgun_evm" });
    const res = verifyWorkerFundingAttestation(signed, "dest-1", 3, defaultEd25519Verify);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("rail_not_native");
  });

  it("rejects insufficient confirmations", () => {
    const { signed } = makeSigned({ confirmations: 2 });
    const res = verifyWorkerFundingAttestation(signed, "dest-1", 3, defaultEd25519Verify);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("insufficient_confirmations");
  });

  it("rejects an unexpected version", () => {
    const { signed } = makeSigned({ version: "bogus-v2" });
    const res = verifyWorkerFundingAttestation(signed, "dest-1", 3, defaultEd25519Verify);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("version_mismatch");
  });
});
