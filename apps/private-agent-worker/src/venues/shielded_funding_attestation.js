// Worker-side attested funding result.
//
// Realizes "worker verifies, web trusts attested result": the worker (which
// holds the fresh credential and talks to Ghola's own relayer) runs the funding
// + verification predicate IN-PROCESS, then signs a compact attestation the web
// app verifies by signature alone — so the web never needs its own relayer
// client, and the relayer dependency stays inside the worker's tighter trust
// boundary.
//
// The predicate enforced here mirrors the web verifier verifyFreshWalletFunded
// exactly (native rail only, confirmed, >= min confirmations, destination +
// bucket bound, fresh) so the two cannot drift in what counts as "funded".
//
// Signing key: Ed25519. In production the worker is TEE-attested and its signing
// key is bound to that attestation (the web app pins the public key). In dev the
// key may be supplied via PRIVATE_AGENT_FUNDING_SIGNING_KEY (base64 PKCS8) or
// generated ephemerally (logged once) so local flows work.

import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  createHash,
} from "node:crypto";
import { fundFreshCredential, NATIVE_SHIELDED_RAIL } from "./shielded_funding.js";

const SIGNING_KEY_ENV = "PRIVATE_AGENT_FUNDING_SIGNING_KEY"; // base64 PKCS8 Ed25519
const ATTESTATION_VERSION = "ghola-shielded-funding-attestation-v1";

export class FundingAttestationError extends Error {
  constructor(message, status = 400, code = "funding_attestation_failed") {
    super(message);
    this.name = "FundingAttestationError";
    this.status = status;
    this.code = code;
  }
}

let cachedKey = null;

/**
 * Resolve the worker's Ed25519 signing identity. Prefers the configured PKCS8
 * key (production: attestation-bound); otherwise generates an ephemeral key and
 * logs its public key once so a dev web app can pin it. Cached per process.
 */
export function fundingSigningIdentity() {
  if (cachedKey) return cachedKey;
  const configured = (process.env[SIGNING_KEY_ENV] || "").trim();
  let privateKey;
  if (configured) {
    privateKey = createPrivateKey({
      key: Buffer.from(configured, "base64"),
      format: "der",
      type: "pkcs8",
    });
  } else {
    const pair = generateKeyPairSync("ed25519");
    privateKey = pair.privateKey;
    const pub = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    // Visible once so a dev/web operator can pin the ephemeral key.
    console.warn(
      `[shielded-funding] no ${SIGNING_KEY_ENV}; generated ephemeral signer. public_key_b64=${pub}`,
    );
  }
  const publicKey = createPublicKey(privateKey);
  cachedKey = {
    privateKey,
    publicKey,
    public_key_b64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
  return cachedKey;
}

/** Canonical bytes signed for a funding attestation. Stable key order. */
export function fundingAttestationMessage(claim) {
  return Buffer.from(
    JSON.stringify({
      version: ATTESTATION_VERSION,
      rail: claim.rail,
      destination_commitment: claim.destination_commitment,
      amount_bucket: claim.amount_bucket,
      confirmations: claim.confirmations,
      verified_at: claim.verified_at,
    }),
    "utf8",
  );
}

/**
 * Re-implements the verify predicate in the worker so it cannot diverge from
 * the web verifier. Returns null when the observation does not constitute
 * verified native funding.
 */
function predicate(observation, { destination_commitment, amount_bucket, minConfirmations }) {
  if (!observation) return null;
  if (observation.rail !== NATIVE_SHIELDED_RAIL) return null;
  if (observation.status !== "confirmed") return null;
  if (observation.confirmations < minConfirmations) return null;
  if (observation.destination_commitment !== destination_commitment) return null;
  if (observation.amount_bucket !== amount_bucket) return null;
  return observation;
}

/**
 * Fund a fresh credential and, if it verifies, return a SIGNED funding
 * attestation. Fail-closed: throws FundingAttestationError when funding does not
 * verify — the worker never signs an unverified result.
 *
 * @returns {{attestation: object, signature_b64: string, signer_public_key_b64: string}}
 */
export async function attestFreshCredentialFunded({
  withdraw_bundle,
  destination_commitment,
  amount_bucket,
  minConfirmations,
  now = () => new Date(),
  fundImpl = fundFreshCredential,
}) {
  const observation = await fundImpl({
    withdraw_bundle,
    destination_commitment,
    amount_bucket,
    minConfirmations,
    now,
  });

  const verified = predicate(observation, {
    destination_commitment,
    amount_bucket,
    minConfirmations: minConfirmations ?? observation.confirmations,
  });
  if (!verified) {
    throw new FundingAttestationError(
      `fresh credential not verifiably funded (status=${observation?.status ?? "none"})`,
      409,
      "funding_not_verified",
    );
  }

  const attestation = {
    version: ATTESTATION_VERSION,
    rail: NATIVE_SHIELDED_RAIL,
    destination_commitment,
    amount_bucket,
    confirmations: verified.confirmations,
    verified_at: now().toISOString(),
    // Binding commitment over the verified facts — the web side persists this as
    // the credential's funding_evidence_commitment.
    funding_evidence_commitment: createHash("sha256")
      .update(
        JSON.stringify({
          rail: NATIVE_SHIELDED_RAIL,
          destination_commitment,
          amount_bucket,
          confirmations: verified.confirmations,
        }),
      )
      .digest("hex"),
  };

  const identity = fundingSigningIdentity();
  const signature = edSign(null, fundingAttestationMessage(attestation), identity.privateKey);
  return {
    attestation,
    signature_b64: signature.toString("base64"),
    signer_public_key_b64: identity.public_key_b64,
  };
}
