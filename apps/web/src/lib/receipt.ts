/**
 * Per-message cryptographic receipt.
 *
 * Every assistant message gets a receipt that says where it ran, which
 * model handled it, and the hashes of the request and response bodies.
 * The receipt is signed so a third party can verify after the fact
 * that the body hasn't been edited and that it was issued by the
 * holder of the signing key.
 *
 * v1 receipts are *user-signed* — the user's Turnkey-held Ed25519
 * identity key signs the receipt body. That's not third-party
 * non-repudiation (the provider didn't sign), it's an integrity
 * record of "this is what I observed from my client." Honest for
 * the current architecture: until the in-enclave runtime ships with
 * its own attestation-bound signing key (v2), the user is the only
 * party we can mint a signature from on-device.
 *
 * v2 adds: provider Ed25519 signature, attestation hash, measurement,
 * and a Solana memo anchor reference (hourly Merkle root signature
 * the user can re-verify against the public chain).
 */

import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { verifyingFromDidKey } from "./envelope";
import type { SovereigntyMode } from "./sovereignty";
import { thumperRelayBase } from "./sovereignty";

export type ReceiptVersion = 1;

export interface ReceiptV1 {
  version: ReceiptVersion;
  job_id: string;
  mode: SovereigntyMode;
  // Provider identifier — bs58 pubkey for cloud, "local-webgpu" or
  // "ghola-home/<host>" for on-device. Free-form string; the verifier
  // does not interpret it beyond matching what the user expects.
  provider_id: string;
  model_id: string | null;
  input_token_hash: string; // sha256 hex of the canonicalized prompt
  output_token_hash: string; // sha256 hex of the response
  issued_at: number; // unix ms
  // v2 provider attestation. Populated when the message ran inside an
  // attested enclave (Private mode + relay-sealed transport); null for
  // v1 user-only receipts and for Local/Open paths.
  enclave_key_id: string | null;
  attestation_hash: string | null;
  measurement: string | null;
  // Signer DID and base64 signature over the canonical body. The user
  // (Turnkey) signs in v1; in v2 receipts that originate in-enclave,
  // `signer_did` is the user's DID and `signature` is the user's
  // post-hoc countersignature when the client builds the receipt
  // locally — for provider-built receipts, `signer_did` is the
  // enclave's did:key and `signature` matches `provider_signature`.
  signer_did: string;
  signature: string;
  // v2: provider Ed25519 signature over the canonical body. Distinct
  // from `signature` so a verifier can check both independently —
  // user signature proves "this is what my client observed," provider
  // signature proves "this is what the enclave produced." Null on v1
  // receipts (user-only path) for wire compatibility.
  provider_signature: string | null;
}

// Everything that gets signed — i.e. the receipt without the trailing
// signer_did / signature pair. Key order is fixed because we serialize
// to JSON with this exact ordering to derive the signing bytes; sort
// alphabetically would also work but explicit is cheaper to reason
// about for hand-verification.
type ReceiptBody = Omit<
  ReceiptV1,
  "signer_did" | "signature" | "provider_signature"
>;

const RECEIPT_BODY_KEYS: ReadonlyArray<keyof ReceiptBody> = [
  "version",
  "job_id",
  "mode",
  "provider_id",
  "model_id",
  "input_token_hash",
  "output_token_hash",
  "issued_at",
  "enclave_key_id",
  "attestation_hash",
  "measurement",
] as const;

function canonicalizeBody(body: ReceiptBody): Uint8Array {
  const ordered: Record<string, unknown> = {};
  for (const k of RECEIPT_BODY_KEYS) ordered[k] = body[k];
  return new TextEncoder().encode(JSON.stringify(ordered));
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

function bytesToBase64(b: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin);
}

function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hashUtf8(s: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(s)));
}

export interface MakeReceiptInput {
  jobId: string;
  mode: SovereigntyMode;
  providerId: string;
  modelId: string | null;
  prompt: string;
  response: string;
  signerDid: string;
  signBytes: (bytes: Uint8Array) => Promise<Uint8Array>;
}

export async function makeReceipt(input: MakeReceiptInput): Promise<ReceiptV1> {
  const body: ReceiptBody = {
    version: 1,
    job_id: input.jobId,
    mode: input.mode,
    provider_id: input.providerId,
    model_id: input.modelId,
    input_token_hash: hashUtf8(input.prompt),
    output_token_hash: hashUtf8(input.response),
    issued_at: Date.now(),
    enclave_key_id: null,
    attestation_hash: null,
    measurement: null,
  };
  const digest = sha256(canonicalizeBody(body));
  const sig = await input.signBytes(digest);
  return {
    ...body,
    signer_did: input.signerDid,
    signature: bytesToBase64(sig),
    provider_signature: null,
  };
}

export interface VerifyReceiptResult {
  ok: boolean;
  reason?: string;
}

// Re-derive the body bytes from the receipt fields, hash them, and
// check the Ed25519 signature against the signer DID's verifying key.
// Does NOT check the input/output hashes against the message bodies —
// the caller does that with the live message text (which can drift
// from a stored receipt across UI re-renders, see ReceiptBadge).
export function verifyReceipt(receipt: ReceiptV1): VerifyReceiptResult {
  try {
    const body: ReceiptBody = {
      version: receipt.version,
      job_id: receipt.job_id,
      mode: receipt.mode,
      provider_id: receipt.provider_id,
      model_id: receipt.model_id,
      input_token_hash: receipt.input_token_hash,
      output_token_hash: receipt.output_token_hash,
      issued_at: receipt.issued_at,
      enclave_key_id: receipt.enclave_key_id,
      attestation_hash: receipt.attestation_hash,
      measurement: receipt.measurement,
    };
    const digest = sha256(canonicalizeBody(body));
    const sig = base64ToBytes(receipt.signature);
    const pub = verifyingFromDidKey(receipt.signer_did);
    const ok = ed25519.verify(sig, digest, pub);
    return ok ? { ok: true } : { ok: false, reason: "signature failed" };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

// Convenience: redo the prompt / response hashing on the current
// message text and check it matches the receipt. Useful for the
// "Verify" button in the badge.
export function verifyReceiptAgainstMessage(
  receipt: ReceiptV1,
  prompt: string,
  response: string,
): VerifyReceiptResult {
  const sig = verifyReceipt(receipt);
  if (!sig.ok) return sig;
  if (hashUtf8(prompt) !== receipt.input_token_hash) {
    return { ok: false, reason: "input hash mismatch" };
  }
  if (hashUtf8(response) !== receipt.output_token_hash) {
    return { ok: false, reason: "output hash mismatch" };
  }
  return { ok: true };
}

// Fire-and-forget POST of a receipt to the receipts anchor service.
// The service queues it for the next Merkle batch + on-chain publish.
// Failure is non-fatal: the receipt still lives in the local chat
// vault, the Verify button still works (user signature), and "Check
// on-chain" will return 404 until/unless the receipt gets submitted
// later. This is called from every onDone path so every assistant
// message gets a chance at on-chain anchoring.
export async function submitReceiptToService(receipt: ReceiptV1): Promise<void> {
  const base =
    (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_RECEIPTS_SERVICE_URL) ||
    "";
  if (!base) return;
  try {
    await fetch(`${base.replace(/\/$/, "")}/v1/receipts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(receipt),
    });
  } catch {
    // Service unreachable or rejecting — silently. Receipt is still
    // in the local vault; the user can retry later if the service
    // comes back up.
  }
}

// ── v2 helpers: provider signature + attestation fetch ──────────────────

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("invalid hex length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Verify the provider's Ed25519 signature on a v2 receipt against the
 * enclave's attestation-bound Ed25519 public key (hex). Returns
 * `{ ok: false }` for v1 receipts where `provider_signature` is null —
 * callers should check that case explicitly before calling.
 */
export function verifyProviderSignature(
  receipt: ReceiptV1,
  enclaveEd25519PubHex: string,
): VerifyReceiptResult {
  try {
    if (!receipt.provider_signature) {
      return { ok: false, reason: "no provider signature on receipt" };
    }
    const body: ReceiptBody = {
      version: receipt.version,
      job_id: receipt.job_id,
      mode: receipt.mode,
      provider_id: receipt.provider_id,
      model_id: receipt.model_id,
      input_token_hash: receipt.input_token_hash,
      output_token_hash: receipt.output_token_hash,
      issued_at: receipt.issued_at,
      enclave_key_id: receipt.enclave_key_id,
      attestation_hash: receipt.attestation_hash,
      measurement: receipt.measurement,
    };
    const digest = sha256(canonicalizeBody(body));
    const sig = base64ToBytes(receipt.provider_signature);
    const pub = hexToBytes(enclaveEd25519PubHex);
    if (pub.length !== 32) {
      return {
        ok: false,
        reason: `enclave Ed25519 pub must be 32 bytes, got ${pub.length}`,
      };
    }
    const ok = ed25519.verify(sig, digest, pub);
    return ok ? { ok: true } : { ok: false, reason: "provider signature failed" };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Cached attestation document the relay returns for a known
 * `attestation_hash`. Includes the raw vendor quote (so a verifier
 * can re-walk the chain offline) and the structured enclave fields
 * needed to verify `provider_signature` after the fact.
 *
 * Shape mirrors `AttestationDoc` in
 * `crates/thumper-relay/src/routes/attestations.rs`.
 */
export interface AttestationDoc {
  attestation_hash: string;
  vendor_quote_b64: string;
  enclave_key_id: string;
  provider_id: string;
  tee_kind: "nitro" | "h100_cc" | "phala" | "tdx" | "none";
  enclave_x25519_pub_hex: string;
  enclave_ed25519_pub_hex: string;
  measurement_hex: string;
  expires_at_unix: number;
}

/**
 * Fetch the attestation doc for a given hash from the relay. Returns
 * null on any failure — the caller surfaces that as "couldn't verify"
 * rather than treating it as a tamper.
 */
export async function fetchAttestation(
  attestationHash: string,
): Promise<AttestationDoc | null> {
  try {
    const url = new URL(
      `/attestations/${encodeURIComponent(attestationHash)}`,
      thumperRelayBase(),
    );
    const res = await fetch(url.toString(), { method: "GET" });
    if (!res.ok) return null;
    return (await res.json()) as AttestationDoc;
  } catch {
    return null;
  }
}

/**
 * Compute the sha256 hex of a receipt's canonical body — used as the
 * key the receipts service indexes Merkle proofs under. Matches the
 * Rust batcher's `receipt_hash` derivation in
 * `crates/said-receipts-service`.
 */
export function receiptHashHex(receipt: ReceiptV1): string {
  const body: ReceiptBody = {
    version: receipt.version,
    job_id: receipt.job_id,
    mode: receipt.mode,
    provider_id: receipt.provider_id,
    model_id: receipt.model_id,
    input_token_hash: receipt.input_token_hash,
    output_token_hash: receipt.output_token_hash,
    issued_at: receipt.issued_at,
    enclave_key_id: receipt.enclave_key_id,
    attestation_hash: receipt.attestation_hash,
    measurement: receipt.measurement,
  };
  return bytesToHex(sha256(canonicalizeBody(body)));
}
