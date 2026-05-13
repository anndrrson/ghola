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
  // Reserved for v2 — provider attestation. Null in v1 because the
  // enclave runtime doesn't exist yet; surfacing the field keeps the
  // wire format stable across versions.
  enclave_key_id: string | null;
  attestation_hash: string | null;
  measurement: string | null;
  // Signer DID and base64 signature over the canonical body.
  signer_did: string;
  signature: string;
}

// Everything that gets signed — i.e. the receipt without the trailing
// signer_did / signature pair. Key order is fixed because we serialize
// to JSON with this exact ordering to derive the signing bytes; sort
// alphabetically would also work but explicit is cheaper to reason
// about for hand-verification.
type ReceiptBody = Omit<ReceiptV1, "signer_did" | "signature">;

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
