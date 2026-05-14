/**
 * Sealed inference client — the v2 Private-mode transport.
 *
 * Wraps the relay's `/inference/sealed` endpoint with two envelope
 * operations:
 *   1. Build an `InferenceRequestPayload` (model, messages, sampling),
 *      seal it via `said-envelope::seal()` to the enclave's X25519
 *      public key (ModelBridge recipient kind), and POST the resulting
 *      ciphertext to the relay.
 *   2. The provider responds with an envelope sealed back to the
 *      user's long-lived vault X25519 keypair (see
 *      `vault-x25519::deriveVaultX25519Keypair`). We open it locally
 *      and surface `{ text, receipt }` to the caller.
 *
 * The provider's receipt is a v2 `ReceiptV1` with `provider_signature`
 * populated by the enclave's attestation-bound Ed25519 key, plus
 * `enclave_key_id`, `attestation_hash`, and `measurement`. The user
 * does NOT re-sign on top — the v2 trust model treats the provider
 * signature as authoritative for "what the cloud ran," with the
 * attestation chain anchoring the rest.
 *
 * Wire format: the relay's response is JSON with a base64 ciphertext
 * blob, matching the shape of `SealedInferenceResponse` in
 * crates/thumper-types/src/inference.rs.
 */

import { seal, open as openEnvelope, RecipientKind } from "./envelope";
import type { AttestedEnclaveInfo } from "./sovereignty";
import { thumperRelayBase } from "./sovereignty";
import { deriveVaultX25519Keypair } from "./vault-x25519";
import type { ReceiptV1 } from "./receipt";

export interface InferenceMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface SealedStreamOptions {
  /** Optional model id — if omitted, the provider picks per its config. */
  modelId?: string;
  /** Token cap. Defaults to 2048. */
  maxTokens?: number;
  /** Streaming hint forwarded to the provider. v2 relay does not yet
   *  stream sealed responses chunk-by-chunk, so this is informational. */
  stream?: boolean;
  /** Fired with the decoded assistant text once the envelope opens. */
  onChunk: (text: string) => void;
  /** Fired with the provider-signed receipt after the text is delivered. */
  onDone: (receipt: ReceiptV1) => void;
  /** Fired with a human-readable string on any failure (network, AEAD,
   *  signature, JSON shape, etc.). The caller renders this in the
   *  assistant bubble. */
  onError: (msg: string) => void;
}

interface SealedInferenceResponseWire {
  ciphertext_b64: string;
  is_final?: boolean;
}

interface InEnvelopeAssistantPayload {
  text: string;
  receipt: ReceiptV1;
}

// ── byte helpers ────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error(`invalid hex (odd length): ${clean.length}`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
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

/**
 * Send a single sealed inference round-trip.
 *
 * `signBytes` is the Turnkey-backed Ed25519 signer the rest of the app
 * already uses (`useTurnkeyWallet().signBytes`); it's used twice here:
 *   - directly by `seal()` to sign the outbound envelope body
 *   - by `deriveVaultX25519Keypair()` to recover the X25519 secret the
 *     provider sealed its response back to
 *
 * `senderDid` is the user's `did:key:z…` (Ed25519 multicodec). It goes
 * into the envelope header so the provider can verify the request
 * signature and address the response back to the same identity.
 */
export async function streamSealedChat(
  sessionId: string,
  message: string,
  enclave: AttestedEnclaveInfo,
  signBytes: (bytes: Uint8Array) => Promise<Uint8Array>,
  senderDid: string,
  options: SealedStreamOptions,
): Promise<void> {
  try {
    const jobId = crypto.randomUUID();
    const requestPayload = {
      job_id: jobId,
      model_id: options.modelId ?? "llama3.2:3b",
      messages: [{ role: "user", content: message } satisfies InferenceMessage],
      max_tokens: options.maxTokens ?? 2048,
      stream: options.stream ?? false,
    };
    const requestBody = JSON.stringify(requestPayload);

    // Seal the request to the enclave's X25519 pubkey via the
    // ModelBridge recipient kind. The associated data binds the
    // envelope to this session id so a replay against a different
    // chat session is rejected by the AEAD.
    const recipientX25519 = hexToBytes(enclave.enclave_x25519_pub_hex);
    if (recipientX25519.length !== 32) {
      options.onError(
        `attested enclave returned invalid X25519 pubkey (${recipientX25519.length} bytes)`,
      );
      return;
    }
    const ad = new TextEncoder().encode(
      `ghola-inference-v1|${sessionId}|${jobId}`,
    );
    const sealedBytes = await seal({
      senderDid,
      recipientId: enclave.enclave_key_id,
      recipientX25519,
      kind: RecipientKind.ModelBridge,
      associatedData: ad,
      plaintext: new TextEncoder().encode(requestBody),
      signBody: signBytes,
    });

    // POST to /inference/sealed. The relay forwards the opaque blob to
    // the enclave verbatim — it never sees plaintext.
    //
    // === v3.5 Phase 3: auth comes from the envelope, not a Bearer header ===
    // The relay validates this request by:
    //   1. parsing the said-envelope nested in `sealed_request_b64`,
    //   2. verifying the envelope's Ed25519 signature against `sender_did`,
    //   3. checking `sender_did ∈ did_set` (a periodically-refreshed
    //      snapshot pulled from thumper-cloud),
    //   4. enforcing replay defense via the envelope's nonce.
    // Including `Authorization: Bearer <thumper_token>` here would leak
    // the user account identity to the relay — exactly the linkage Phase
    // 3 is removing. The `thumper_token` machinery in localStorage stays
    // in place for non-sealed endpoints (e.g. wallet, chat history).
    const url = new URL("/inference/sealed", thumperRelayBase());
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    const res = await fetch(url.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify({
        enclave_key_id: enclave.enclave_key_id,
        job_id: jobId,
        sealed_request_b64: bytesToBase64(sealedBytes),
        mode_hint: "private",
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => `HTTP ${res.status}`);
      options.onError(`Sealed inference failed: ${res.status} ${body}`);
      return;
    }

    const wire = (await res.json()) as SealedInferenceResponseWire;
    if (typeof wire.ciphertext_b64 !== "string") {
      options.onError("Sealed inference: malformed response (no ciphertext)");
      return;
    }

    // Derive the same vault X25519 secret the provider sealed back to.
    // This is the deterministic Turnkey-gated keypair (see
    // vault-x25519.ts) — both sides of the round-trip can recover it
    // independently without leaking the secret.
    const vaultKp = await deriveVaultX25519Keypair(signBytes);
    const responseBytes = base64ToBytes(wire.ciphertext_b64);
    const opened = await openEnvelope(responseBytes, vaultKp.secret);
    const text = new TextDecoder().decode(opened.plaintext);

    let decoded: InEnvelopeAssistantPayload;
    try {
      decoded = JSON.parse(text) as InEnvelopeAssistantPayload;
    } catch (err) {
      options.onError(
        `Sealed inference: response not valid JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }

    if (typeof decoded.text !== "string" || !decoded.receipt) {
      options.onError("Sealed inference: response missing text or receipt");
      return;
    }

    options.onChunk(decoded.text);
    options.onDone(decoded.receipt);
  } catch (err) {
    options.onError(err instanceof Error ? err.message : String(err));
  }
}
