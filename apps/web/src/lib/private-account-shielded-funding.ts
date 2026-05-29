// Native shielded-funding verification.
//
// This is the trust spine for the privacy claim "a trade does not link back to
// the user." A stealth venue credential may only be treated as privately funded
// when we can prove it was funded by a withdraw from *Ghola's own* shielded pool
// to that exact fresh credential — never by a user's main wallet, and never via
// a third-party privacy rail (Railgun/Aleo/etc), which would add an external
// sub-processor to the data path and widen the SOC 2 Type II boundary.
//
// Without this check, `funding_evidence_commitment` is just an opaque string and
// `createStealthVenueAccount` would flip a credential to "ready" on its mere
// presence — an asserted claim, not a verified one. This module turns the
// commitment into something whose preimage is checked: native rail + confirmed
// withdraw + destination binding + amount bucketing + freshness.
//
// Design: pure and fail-closed. The caller supplies the observed withdraw status
// (fetched from the shielded-pool relayer / indexer); this module decides. That
// keeps it unit-testable without network and makes the verdict deterministic.

import { ed25519 } from "@noble/curves/ed25519";
import {
  gholaCommitment,
  isFundingAmountBucket,
  type GholaFundingAmountBucket,
} from "./private-account";
import { shieldedPoolConfig, type ShieldedPoolConfig } from "./private-account-shielded-pool";

/**
 * The only rail that satisfies the vertical-integration mandate: Ghola's own
 * Solana shielded pool. Third-party rails are intentionally absent — they are
 * not allowed in the private-trading funding path.
 */
export const NATIVE_SHIELDED_RAIL = "ghola_shielded_pool" as const;

export type NativeShieldedRail = typeof NATIVE_SHIELDED_RAIL;

/**
 * Coarse, privacy-preserving status of a queued/landed shielded withdraw, as
 * reported by the shielded-pool relayer `/status/:id` and corroborated by the
 * indexer. Mirrors the relayer's `QueuedWithdrawal` status ladder. Crucially it
 * carries NO on-chain signature, recipient, amount, or nullifier — only what we
 * need to gate readiness.
 */
export interface ShieldedWithdrawObservation {
  /** Opaque relayer queue id for this withdraw (not an on-chain signature). */
  relay_id: string;
  /** Coarse lifecycle status from the relayer. */
  status: "pending" | "batched" | "submitted" | "confirmed" | "failed";
  /** On-chain confirmations observed by the indexer (0 until landed). */
  confirmations: number;
  /**
   * Commitment of the destination the withdraw actually paid out to, as
   * observed on-chain. MUST equal the fresh credential's destination
   * commitment, or the funding is not bound to this credential.
   */
  destination_commitment: string;
  /** Amount bucket the withdraw settled into (relayer enforces bucketing). */
  amount_bucket: string;
  /** ISO timestamp the observation was made; used for staleness. */
  observed_at: string;
}

/**
 * The funding evidence a caller claims for a fresh credential, before
 * verification. `rail` is validated to be the native pool; anything else is
 * rejected outright.
 */
export interface ShieldedFundingClaim {
  rail: string;
  /** Opaque relayer queue id the client says funded the credential. */
  relay_id: string;
  /** Destination commitment of the fresh credential being funded. */
  destination_commitment: string;
  /** Expected amount bucket (must match the observed withdraw). */
  amount_bucket: string;
}

export type ShieldedFundingFailureReason =
  | "rail_not_native"
  | "relay_id_missing"
  | "destination_commitment_missing"
  | "amount_bucket_invalid"
  | "withdraw_not_found"
  | "withdraw_failed"
  | "withdraw_not_confirmed"
  | "insufficient_confirmations"
  | "destination_mismatch"
  | "amount_bucket_mismatch"
  | "observation_stale"
  | "shielded_pool_unconfigured";

export type ShieldedFundingVerification =
  | {
      ok: true;
      rail: NativeShieldedRail;
      /**
       * Binding commitment over the verified funding. This — not the raw
       * relay id — is what should be persisted as the stealth account's
       * `funding_evidence_commitment`, so the stored commitment's preimage is a
       * genuinely verified withdraw.
       */
      funding_evidence_commitment: string;
      amount_bucket: GholaFundingAmountBucket;
      confirmations: number;
      verified_at: string;
    }
  | {
      ok: false;
      reason: ShieldedFundingFailureReason;
      explanation: string;
    };

function fail(
  reason: ShieldedFundingFailureReason,
  explanation: string,
): ShieldedFundingVerification {
  return { ok: false, reason, explanation };
}

/**
 * Verify that a fresh credential was funded by Ghola's own shielded pool.
 *
 * Fail-closed: any missing field, non-native rail, unconfirmed/failed withdraw,
 * destination mismatch, wrong/un-bucketed amount, or stale observation rejects.
 * Only a fully verified native withdraw yields `ok: true` plus a binding
 * `funding_evidence_commitment` to persist.
 *
 * @param claim       what the caller asserts funded the credential
 * @param observation the withdraw status as observed via relayer + indexer
 *                    (null when the relayer has no record of `relay_id`)
 * @param config      shielded-pool config (defaults to env-derived config)
 * @param now         clock injection for deterministic staleness tests
 */
export function verifyFreshWalletFunded(
  claim: ShieldedFundingClaim,
  observation: ShieldedWithdrawObservation | null,
  config: ShieldedPoolConfig = shieldedPoolConfig(),
  now: Date = new Date(),
): ShieldedFundingVerification {
  // 1. Vertical-integration gate: only the native rail is permitted. A
  //    third-party privacy rail here would be a SOC 2 boundary violation.
  if (claim.rail !== NATIVE_SHIELDED_RAIL) {
    return fail(
      "rail_not_native",
      `Only the native ${NATIVE_SHIELDED_RAIL} rail may fund private trading; got "${claim.rail}".`,
    );
  }

  // 2. Well-formed claim.
  if (!claim.relay_id.trim()) {
    return fail("relay_id_missing", "A shielded-pool relay id is required.");
  }
  if (!claim.destination_commitment.trim()) {
    return fail(
      "destination_commitment_missing",
      "A fresh-credential destination commitment is required.",
    );
  }
  if (!isFundingAmountBucket(claim.amount_bucket)) {
    return fail(
      "amount_bucket_invalid",
      `Amount bucket "${claim.amount_bucket}" is not an approved privacy bucket.`,
    );
  }

  // 3. The shielded pool must be configured for a real (non-degraded) verdict.
  //    In local_test mode the config is intentionally permissive; outside it,
  //    require the relayer URL so we are actually checking a real service.
  if (config.mode === "http" && !config.relayer_url) {
    return fail(
      "shielded_pool_unconfigured",
      "Shielded-pool relayer is not configured; cannot verify native funding.",
    );
  }

  // 4. The withdraw must exist, have landed, and be bound to THIS credential.
  if (!observation) {
    return fail(
      "withdraw_not_found",
      "The shielded-pool relayer has no record of this withdraw.",
    );
  }
  if (observation.status === "failed") {
    return fail("withdraw_failed", "The shielded-pool withdraw failed on-chain.");
  }
  if (observation.status !== "confirmed") {
    return fail(
      "withdraw_not_confirmed",
      `The shielded-pool withdraw is "${observation.status}", not yet confirmed.`,
    );
  }
  if (observation.confirmations < config.min_confirmations) {
    return fail(
      "insufficient_confirmations",
      `Withdraw has ${observation.confirmations} confirmations; ${config.min_confirmations} required.`,
    );
  }
  if (observation.destination_commitment !== claim.destination_commitment) {
    return fail(
      "destination_mismatch",
      "The withdraw paid out to a different destination than this fresh credential.",
    );
  }
  if (observation.amount_bucket !== claim.amount_bucket) {
    return fail(
      "amount_bucket_mismatch",
      "The withdraw settled into a different amount bucket than claimed.",
    );
  }

  // 5. Freshness: a stale observation could predate a later drain/move.
  const observedMs = new Date(observation.observed_at).getTime();
  if (!Number.isFinite(observedMs)) {
    return fail("observation_stale", "The funding observation has no valid timestamp.");
  }
  if (now.getTime() - observedMs > config.max_stale_ms) {
    return fail(
      "observation_stale",
      "The funding observation is too old to trust; re-verify before trading.",
    );
  }

  // Verified. Bind every checked fact into the persisted commitment so the
  // stored evidence's preimage is this exact verified withdraw — not an opaque
  // string. The relay id is hashed in (not stored raw) to avoid leaking it.
  const funding_evidence_commitment = gholaCommitment("verified_shielded_funding", {
    rail: NATIVE_SHIELDED_RAIL,
    relay_id: claim.relay_id,
    destination_commitment: claim.destination_commitment,
    amount_bucket: claim.amount_bucket,
    confirmations: observation.confirmations,
    network: config.network,
    program_id: config.program_id,
  });

  return {
    ok: true,
    rail: NATIVE_SHIELDED_RAIL,
    funding_evidence_commitment,
    amount_bucket: claim.amount_bucket,
    confirmations: observation.confirmations,
    verified_at: now.toISOString(),
  };
}

/**
 * Narrow a verification result to the commitment a caller should persist, or
 * null when funding is not verified. Convenience for the readiness/preflight
 * path which only ever wants the verified commitment.
 */
export function verifiedFundingCommitment(
  verification: ShieldedFundingVerification,
): string | null {
  return verification.ok ? verification.funding_evidence_commitment : null;
}

// ---------------------------------------------------------------------------
// Worker-attested funding (the "worker verifies, web trusts attested result"
// path). The TEE worker holds the fresh credential, performs the withdraw +
// verification in-process, and returns an Ed25519-signed attestation. The web
// app verifies the signature against the pinned worker key and only then
// persists the verified funding_evidence_commitment — it never trusts a
// client-supplied commitment string.
// ---------------------------------------------------------------------------

const FUNDING_ATTESTATION_VERSION = "ghola-shielded-funding-attestation-v1";

/** Pinned worker signer public key(s), base64 SPKI, comma-separated. */
const WORKER_SIGNER_KEYS_ENV = "GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64";

export interface WorkerFundingAttestation {
  version: string;
  rail: string;
  destination_commitment: string;
  amount_bucket: string;
  confirmations: number;
  verified_at: string;
  funding_evidence_commitment: string;
}

export interface SignedWorkerFundingAttestation {
  attestation: WorkerFundingAttestation;
  signature_b64: string;
  signer_public_key_b64: string;
}

export type WorkerAttestationFailureReason =
  | "version_mismatch"
  | "rail_not_native"
  | "amount_bucket_invalid"
  | "destination_mismatch"
  | "signer_not_pinned"
  | "signature_invalid"
  | "insufficient_confirmations";

export type WorkerAttestationVerification =
  | { ok: true; funding_evidence_commitment: string; amount_bucket: GholaFundingAmountBucket }
  | { ok: false; reason: WorkerAttestationFailureReason; explanation: string };

/**
 * Canonical message bytes the worker signs. MUST byte-match the worker's
 * `fundingAttestationMessage` (shielded_funding_attestation.js).
 */
function workerAttestationMessage(att: WorkerFundingAttestation): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      version: att.version,
      rail: att.rail,
      destination_commitment: att.destination_commitment,
      amount_bucket: att.amount_bucket,
      confirmations: att.confirmations,
      verified_at: att.verified_at,
    }),
  );
}

function pinnedSignerKeys(): Set<string> {
  return new Set(
    (process.env[WORKER_SIGNER_KEYS_ENV] || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Verify a worker-signed funding attestation and bind it to the expected fresh
 * credential. Fail-closed; on success returns the verified
 * funding_evidence_commitment to persist.
 *
 * @param signed                the worker's signed attestation
 * @param expectedDestination   the fresh credential's destination commitment
 * @param minConfirmations      minimum confirmations required
 * @param verifyEd25519         injected Ed25519 verifier
 *                              (sig, msg, spkiDerPubKey) => boolean
 */
export function verifyWorkerFundingAttestation(
  signed: SignedWorkerFundingAttestation,
  expectedDestination: string,
  minConfirmations: number,
  verifyEd25519: (sig: Uint8Array, msg: Uint8Array, spkiDer: Uint8Array) => boolean,
): WorkerAttestationVerification {
  const att = signed.attestation;
  if (att.version !== FUNDING_ATTESTATION_VERSION) {
    return { ok: false, reason: "version_mismatch", explanation: "Unexpected attestation version." };
  }
  if (att.rail !== NATIVE_SHIELDED_RAIL) {
    return { ok: false, reason: "rail_not_native", explanation: "Attestation rail is not the native pool." };
  }
  if (!isFundingAmountBucket(att.amount_bucket)) {
    return { ok: false, reason: "amount_bucket_invalid", explanation: "Attested amount bucket is invalid." };
  }
  if (att.destination_commitment !== expectedDestination) {
    return {
      ok: false,
      reason: "destination_mismatch",
      explanation: "Attestation is for a different credential.",
    };
  }
  if (att.confirmations < minConfirmations) {
    return {
      ok: false,
      reason: "insufficient_confirmations",
      explanation: "Attested confirmations are below the minimum.",
    };
  }
  const pinned = pinnedSignerKeys();
  // When no keys are pinned (dev), accept the self-described key; in production
  // the env MUST pin keys so a rogue signer is rejected.
  if (pinned.size > 0 && !pinned.has(signed.signer_public_key_b64)) {
    return { ok: false, reason: "signer_not_pinned", explanation: "Worker signer key is not pinned." };
  }
  let sigOk = false;
  try {
    sigOk = verifyEd25519(
      Uint8Array.from(Buffer.from(signed.signature_b64, "base64")),
      workerAttestationMessage(att),
      Uint8Array.from(Buffer.from(signed.signer_public_key_b64, "base64")),
    );
  } catch {
    sigOk = false;
  }
  if (!sigOk) {
    return { ok: false, reason: "signature_invalid", explanation: "Attestation signature did not verify." };
  }
  return {
    ok: true,
    funding_evidence_commitment: att.funding_evidence_commitment,
    amount_bucket: att.amount_bucket,
  };
}

/**
 * Default Ed25519 verifier for worker attestations. The worker exports its
 * public key as SPKI DER (44 bytes for Ed25519); @noble/curves expects the raw
 * 32-byte key, which is the trailing 32 bytes of the SPKI structure. The worker
 * signs the raw message (PureEdDSA hashes internally), so verify the raw bytes.
 */
export function defaultEd25519Verify(
  sig: Uint8Array,
  msg: Uint8Array,
  spkiDer: Uint8Array,
): boolean {
  const raw = spkiDer.length === 32 ? spkiDer : spkiDer.subarray(spkiDer.length - 32);
  return ed25519.verify(sig, msg, raw);
}
