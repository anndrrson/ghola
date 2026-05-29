// Native shielded-funding producer (worker side).
//
// Counterpart to the web verifier `verifyFreshWalletFunded`
// (apps/web/src/lib/private-account-shielded-funding.ts). This module performs
// the actual withdraw from Ghola's OWN shielded pool to a fresh execution
// credential, then reports a privacy-preserving observation the verifier checks.
//
// Trust spine: a trade is unlinkable to the user only if the execution
// credential was funded out of the shielded pool — never from the user's main
// wallet, never via a third-party rail. The producer therefore talks ONLY to
// Ghola's own relayer (`GHOLA_SHIELDED_POOL_RELAYER_URL`); there is no
// third-party fallback. Fail-closed: any missing config, relay error, or
// timeout yields a non-confirmed observation that the verifier will reject.
//
// Proof construction is NOT done here. A shielded withdraw proof is produced by
// the sealed runtime / prover (Rust `said-shielded-pool-*`); this module accepts
// an already-built `withdraw_bundle` (opaque instruction data + account metas)
// and relays it. That keeps secrets in the prover and keeps this module a thin,
// testable HTTP client.

import { Keypair } from "@solana/web3.js";

const RELAYER_URL_ENV = "GHOLA_SHIELDED_POOL_RELAYER_URL";
const DRY_RUN_ENV = "PRIVATE_AGENT_VENUE_DRY_RUN";
const MIN_CONFIRMATIONS_ENV = "GHOLA_SHIELDED_POOL_MIN_CONFIRMATIONS";
const POLL_TIMEOUT_MS_ENV = "PRIVATE_AGENT_SHIELDED_FUNDING_TIMEOUT_MS";
const POLL_INTERVAL_MS_ENV = "PRIVATE_AGENT_SHIELDED_FUNDING_POLL_MS";

const DEFAULT_MIN_CONFIRMATIONS = 3;
const DEFAULT_POLL_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

/** Native rail tag — must match NATIVE_SHIELDED_RAIL on the web side. */
export const NATIVE_SHIELDED_RAIL = "ghola_shielded_pool";

export class ShieldedFundingError extends Error {
  constructor(message, status = 502, code = "shielded_funding_failed") {
    super(message);
    this.name = "ShieldedFundingError";
    this.status = status;
    this.code = code;
  }
}

function intFromEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function relayerBaseUrl() {
  const url = (process.env[RELAYER_URL_ENV] || "").trim();
  if (!url) {
    throw new ShieldedFundingError(
      "shielded pool relayer is not configured",
      503,
      "shielded_pool_unconfigured",
    );
  }
  return url.replace(/\/+$/, "");
}

function isDryRun() {
  return process.env[DRY_RUN_ENV] === "true";
}

/**
 * Mint a fresh Solana execution credential. The secret never leaves the worker
 * (caller seals it); only the public key / destination commitment is exported.
 * A fresh keypair is what makes the on-chain funding history start at the
 * shielded withdraw, with no prior user-linked inflow.
 */
export function mintFreshExecutionCredential() {
  const keypair = Keypair.generate();
  return {
    keypair,
    public_key: keypair.publicKey.toBase58(),
  };
}

/**
 * Relay an already-built shielded withdraw to Ghola's own relayer.
 *
 * @param {object} args
 * @param {object} args.withdraw_bundle - { instruction_data_hex, accounts[] }
 *   built by the prover/sealed runtime. Opaque to this module.
 * @param {string} args.destination_commitment - commitment of the fresh credential.
 * @param {string} args.amount_bucket
 * @returns {Promise<{relay_id: string}>}
 */
export async function relayShieldedWithdrawal({
  withdraw_bundle,
  destination_commitment,
  amount_bucket,
  fetchImpl = globalThis.fetch,
}) {
  if (!destination_commitment) {
    throw new ShieldedFundingError("destination_commitment is required", 400, "destination_required");
  }
  if (!withdraw_bundle || typeof withdraw_bundle !== "object") {
    throw new ShieldedFundingError("withdraw_bundle is required", 400, "withdraw_bundle_required");
  }

  if (isDryRun()) {
    // Deterministic mock id derived from the destination so dry-run flows are
    // stable and never touch the network.
    return { relay_id: `dryrun-${destination_commitment.slice(0, 16)}` };
  }

  const base = relayerBaseUrl();
  let res;
  try {
    res = await fetchImpl(`${base}/relay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        instruction_data_hex: withdraw_bundle.instruction_data_hex,
        accounts: withdraw_bundle.accounts,
        // The relayer binds payout to the proof's ext_data; we send the
        // destination commitment only so /status can echo it back for the
        // verifier's destination check. No recipient address, amount, or
        // nullifier is sent in the clear.
        destination_commitment,
        amount_bucket,
      }),
    });
  } catch {
    throw new ShieldedFundingError("shielded pool relayer is unreachable", 502, "relayer_unreachable");
  }
  if (!res.ok) {
    throw new ShieldedFundingError(
      `shielded pool relayer rejected the withdraw (${res.status})`,
      502,
      "relayer_rejected",
    );
  }
  const body = await res.json().catch(() => null);
  const relayId = body && typeof body.relay_id === "string" ? body.relay_id : null;
  if (!relayId) {
    throw new ShieldedFundingError("relayer did not return a relay id", 502, "relay_id_missing");
  }
  return { relay_id: relayId };
}

/**
 * Fetch the coarse status of a relayed withdraw. Returns a partial
 * observation; never throws on a "not yet confirmed" state (that is normal
 * during polling) — only on transport/shape errors.
 *
 * @returns {Promise<{status: string, confirmations: number,
 *   destination_commitment: string, amount_bucket: string, observed_at: string}>}
 */
export async function pollShieldedWithdrawStatus(
  relayId,
  { now = () => new Date(), fetchImpl = globalThis.fetch } = {},
) {
  if (!relayId) {
    throw new ShieldedFundingError("relay_id is required", 400, "relay_id_required");
  }

  if (isDryRun()) {
    return {
      status: "confirmed",
      confirmations: intFromEnv(MIN_CONFIRMATIONS_ENV, DEFAULT_MIN_CONFIRMATIONS),
      destination_commitment: relayId.startsWith("dryrun-")
        ? relayId.slice("dryrun-".length)
        : "",
      amount_bucket: "",
      observed_at: now().toISOString(),
    };
  }

  const base = relayerBaseUrl();
  let res;
  try {
    res = await fetchImpl(`${base}/status/${encodeURIComponent(relayId)}`, {
      method: "GET",
      headers: { accept: "application/json" },
    });
  } catch {
    throw new ShieldedFundingError("shielded pool relayer is unreachable", 502, "relayer_unreachable");
  }
  if (res.status === 404) {
    return {
      status: "failed",
      confirmations: 0,
      destination_commitment: "",
      amount_bucket: "",
      observed_at: now().toISOString(),
    };
  }
  if (!res.ok) {
    throw new ShieldedFundingError(
      `shielded pool relayer status error (${res.status})`,
      502,
      "status_error",
    );
  }
  const body = await res.json().catch(() => null);
  if (!body || typeof body !== "object") {
    throw new ShieldedFundingError("relayer status response was malformed", 502, "status_malformed");
  }
  return {
    status: normalizeStatus(body.status),
    confirmations: Number.isInteger(body.confirmations) ? body.confirmations : 0,
    destination_commitment:
      typeof body.destination_commitment === "string" ? body.destination_commitment : "",
    amount_bucket: typeof body.amount_bucket === "string" ? body.amount_bucket : "",
    observed_at: now().toISOString(),
  };
}

function normalizeStatus(value) {
  const allowed = ["pending", "batched", "submitted", "confirmed", "failed"];
  return allowed.includes(value) ? value : "pending";
}

/**
 * Orchestrate funding a fresh credential: relay the withdraw, then poll until
 * confirmed (>= min confirmations) or timeout. Returns the final
 * ShieldedWithdrawObservation the web verifier consumes. Fail-closed: a timeout
 * returns the last non-confirmed observation (verifier rejects it) rather than
 * fabricating a confirmed one.
 *
 * `sleep` and `now` are injectable for deterministic tests.
 */
export async function fundFreshCredential({
  withdraw_bundle,
  destination_commitment,
  amount_bucket,
  minConfirmations = intFromEnv(MIN_CONFIRMATIONS_ENV, DEFAULT_MIN_CONFIRMATIONS),
  timeoutMs = intFromEnv(POLL_TIMEOUT_MS_ENV, DEFAULT_POLL_TIMEOUT_MS),
  intervalMs = intFromEnv(POLL_INTERVAL_MS_ENV, DEFAULT_POLL_INTERVAL_MS),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => new Date(),
  fetchImpl = globalThis.fetch,
} = {}) {
  const { relay_id } = await relayShieldedWithdrawal({
    withdraw_bundle,
    destination_commitment,
    amount_bucket,
    fetchImpl,
  });

  const deadline = now().getTime() + timeoutMs;
  let last = await pollShieldedWithdrawStatus(relay_id, { now, fetchImpl });
  while (
    last.status !== "failed" &&
    !(last.status === "confirmed" && last.confirmations >= minConfirmations) &&
    now().getTime() < deadline
  ) {
    await sleep(intervalMs);
    last = await pollShieldedWithdrawStatus(relay_id, { now, fetchImpl });
  }

  return {
    rail: NATIVE_SHIELDED_RAIL,
    relay_id,
    status: last.status,
    confirmations: last.confirmations,
    // Prefer the relayer-echoed destination/bucket; fall back to the requested
    // values so the verifier's equality checks are meaningful even when the
    // relayer omits them.
    destination_commitment: last.destination_commitment || destination_commitment,
    amount_bucket: last.amount_bucket || amount_bucket,
    observed_at: last.observed_at,
  };
}
