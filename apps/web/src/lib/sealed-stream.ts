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
import {
  decapsulateResponse,
  decodeBhttpResponse,
  encapsulateRequest,
  encodeBhttpRequest,
  parseKeyConfig,
  type OhttpKeyConfig,
} from "./ohttp";

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

// ── Transport helpers (legacy direct + OHTTP) ───────────────────────────

interface SendArgs {
  token: string | null;
  innerBody: string;
}

interface SendViaOhttpArgs extends SendArgs {
  ohttpRelay: string;
}

/** Cache the gateway keyconfig so we don't refetch it on every chat turn. */
let cachedGatewayKey: { ts: number; cfg: OhttpKeyConfig } | null = null;
const KEYCONFIG_TTL_MS = 60 * 60 * 1000; // 1 hour; matches RFC 9458 ops guidance

async function fetchGatewayKeyConfig(): Promise<OhttpKeyConfig> {
  const now = Date.now();
  if (cachedGatewayKey && now - cachedGatewayKey.ts < KEYCONFIG_TTL_MS) {
    return cachedGatewayKey.cfg;
  }
  const url = new URL("/ohttp-keys", thumperRelayBase());
  const res = await fetch(url.toString(), { method: "GET" });
  if (!res.ok) {
    throw new Error(`fetch keyconfig: ${res.status}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  const cfg = parseKeyConfig(buf);
  cachedGatewayKey = { ts: now, cfg };
  return cfg;
}

async function sendDirect(args: SendArgs): Promise<SealedInferenceResponseWire> {
  const url = new URL("/inference/sealed", thumperRelayBase());
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (args.token) headers["Authorization"] = `Bearer ${args.token}`;
  const res = await fetch(url.toString(), {
    method: "POST",
    headers,
    body: args.innerBody,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => `HTTP ${res.status}`);
    throw new Error(`Sealed inference failed: ${res.status} ${body}`);
  }
  return (await res.json()) as SealedInferenceResponseWire;
}

async function sendViaOhttp(
  args: SendViaOhttpArgs,
): Promise<SealedInferenceResponseWire> {
  const keyConfig = await fetchGatewayKeyConfig();

  // Inner BHTTP request — what the gateway sees after decapsulating.
  const headers: Array<[string, string]> = [
    ["content-type", "application/json"],
  ];
  if (args.token) headers.push(["authorization", `Bearer ${args.token}`]);

  const gatewayHost = (() => {
    try {
      return new URL(thumperRelayBase()).host;
    } catch {
      return "ghola-relay.onrender.com";
    }
  })();

  const bhttp = encodeBhttpRequest({
    method: "POST",
    scheme: "https",
    authority: gatewayHost,
    path: "/inference/sealed",
    headers,
    body: new TextEncoder().encode(args.innerBody),
  });

  const { capsule, context } = await encapsulateRequest(keyConfig, bhttp);

  // Wrap in a Blob — Next.js' strict TS types reject raw Uint8Array as BodyInit
  // even though the runtime accepts it.
  const res = await fetch(args.ohttpRelay, {
    method: "POST",
    headers: { "Content-Type": "message/ohttp-req" },
    body: new Blob([new Uint8Array(capsule)], {
      type: "message/ohttp-req",
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => `HTTP ${res.status}`);
    throw new Error(`OHTTP relay failed: ${res.status} ${body}`);
  }
  const respCapsule = new Uint8Array(await res.arrayBuffer());
  const innerBytes = await decapsulateResponse(context, respCapsule);
  const inner = decodeBhttpResponse(innerBytes);
  if (inner.status >= 400) {
    const body = new TextDecoder().decode(inner.body);
    throw new Error(`OHTTP inner ${inner.status}: ${body}`);
  }
  const parsed = JSON.parse(new TextDecoder().decode(inner.body));
  return parsed as SealedInferenceResponseWire;
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
 *
 * Set `NEXT_PUBLIC_OHTTP_RELAY_URL` to a Cloudflare OHTTP relay endpoint
 * to wrap the whole request in an RFC 9458 capsule. Unset = legacy
 * direct POST to the Ghola Gateway.
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
    // When NEXT_PUBLIC_OHTTP_RELAY_URL is configured, we wrap the entire
    // request in an OHTTP (RFC 9458) capsule and post to the Cloudflare
    // OHTTP relay instead of hitting the Ghola Gateway directly. Double
    // encryption: outer HPKE to the Gateway's published key, inner
    // said-envelope to the enclave. Apple PCC-style: Cloudflare sees the
    // client IP but not the body; the Gateway sees the body but not the
    // client IP.
    const token =
      typeof window !== "undefined"
        ? localStorage.getItem("thumper_token")
        : null;
    const innerBody = JSON.stringify({
      enclave_key_id: enclave.enclave_key_id,
      job_id: jobId,
      sealed_request_b64: bytesToBase64(sealedBytes),
      mode_hint: "private",
    });

    const ohttpRelay =
      typeof process !== "undefined"
        ? process.env.NEXT_PUBLIC_OHTTP_RELAY_URL
        : undefined;

    let wire: SealedInferenceResponseWire;
    try {
      if (ohttpRelay) {
        wire = await sendViaOhttp({
          ohttpRelay,
          token,
          innerBody,
        });
      } else {
        wire = await sendDirect({ token, innerBody });
      }
    } catch (err) {
      options.onError(
        err instanceof Error ? err.message : `Sealed inference failed: ${err}`,
      );
      return;
    }

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
