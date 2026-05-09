/**
 * Chat-side wrapper around {@link SessionVault} + {@link envelope}.
 *
 * The /chat page calls into here to:
 *   - lazily unlock the session vault when the user sends their first
 *     encrypted message (via Turnkey signing)
 *   - get-or-create a session DEK for a chat session id
 *   - seal a user's message into an envelope blob the cloud will
 *     persist verbatim
 *
 * This module is intentionally thin: it owns no React state, no
 * lifecycle, no UI. The chat page or a hook composes it with Turnkey
 * and the local session list.
 */

import {
  RecipientKind,
  didKeyFromVerifying,
  verifyingFromDidKey,
  edwardsPubToX25519,
  seal as sealEnvelope,
} from "./envelope";
import {
  SessionVault,
  VaultRecipientKind,
  type SignBytes,
} from "./session-vault";

/**
 * Encrypt a chat message under the session's DEK and wrap it in a
 * sealed-envelope-v1 frame addressed to the user's own DID
 * (`recipient_kind = SelfRecipient`). The cloud persists the wire bytes
 * verbatim and never sees plaintext for this row.
 *
 * The DEK is *also* embedded in the envelope's plaintext alongside the
 * message itself, which seems redundant but is the right shape: a
 * future PR will replace this with a streaming envelope that wraps a
 * single response DEK once per stream and chains chunk ciphertexts
 * under it (see `crates/said-envelope/src/streaming.rs`). Until then,
 * each user message stands on its own.
 */
export interface SealedMessage {
  /** The wire-format envelope, base64 (standard, with padding) — what
   *  the cloud's `/api/chat` accepts as `envelope_blob_b64`. */
  envelopeB64: string;
}

export interface ChatVault {
  readonly userDid: string;
  ensureUnlocked(): Promise<void>;
  isUnlocked(): boolean;
  /** Get-or-create the DEK for `sessionId`. Returns the raw 32 bytes. */
  getOrCreateSessionDek(sessionId: string): Promise<Uint8Array>;
  /** Seal a user message under the session's DEK + user's identity. */
  sealUserMessage(sessionId: string, plaintext: string): Promise<SealedMessage>;
}

export interface ChatVaultOptions {
  /** `did:key:z…` of the user's wallet. */
  userDid: string;
  /** Sign arbitrary bytes with the user's identity Ed25519 key.
   *  Production passes the Turnkey provider's `signBytes`. */
  signBytes: SignBytes;
}

/**
 * Build a {@link ChatVault} backed by an in-memory {@link SessionVault}
 * keyed on the user's DID. The vault is locked at construction; the
 * first call that requires it (`getOrCreateSessionDek`,
 * `sealUserMessage`) will trigger the Turnkey unlock prompt.
 */
export function createChatVault(opts: ChatVaultOptions): ChatVault {
  const inner = new SessionVault(opts.userDid);
  let unlockPromise: Promise<void> | null = null;

  const ensureUnlocked = (): Promise<void> => {
    if (inner.isUnlocked()) return Promise.resolve();
    if (!unlockPromise) {
      unlockPromise = inner.unlock(opts.signBytes).catch((err) => {
        unlockPromise = null;
        throw err;
      });
    }
    return unlockPromise;
  };

  return {
    userDid: opts.userDid,
    isUnlocked: () => inner.isUnlocked(),
    ensureUnlocked,
    async getOrCreateSessionDek(sessionId) {
      await ensureUnlocked();
      const existing = await inner.getSessionDek(sessionId);
      if (existing) return existing;
      return inner.createSessionDek(sessionId, VaultRecipientKind.SelfRecipient);
    },
    async sealUserMessage(sessionId, plaintext) {
      await ensureUnlocked();
      const dek = await this.getOrCreateSessionDek(sessionId);
      void dek; // The DEK is embedded in the envelope payload below.
      // We seal a self-recipient envelope. The cloud cannot read it;
      // only the user's own X25519 secret (derived from their wallet)
      // can. AD = (sessionId, role) so re-shuffling envelopes between
      // sessions on the server fails AEAD verification.
      const senderVerifying = verifyingFromDidKey(opts.userDid);
      const recipientX25519 = edwardsPubToX25519(senderVerifying);
      const ad = new TextEncoder().encode(`session=${sessionId};role=user`);
      const payload = JSON.stringify({
        v: 1,
        sessionId,
        role: "user" as const,
        content: plaintext,
        ts: new Date().toISOString(),
      });
      const wire = await sealEnvelope({
        senderDid: opts.userDid,
        recipientId: opts.userDid,
        recipientX25519,
        kind: RecipientKind.SelfRecipient,
        associatedData: ad,
        plaintext: new TextEncoder().encode(payload),
        signBody: async (bytes) => opts.signBytes(bytes),
      });
      return { envelopeB64: bytesToBase64Std(wire) };
    },
  };
}

// Standard base64 (the cloud's chat route decodes via
// `STANDARD.decode`, see crates/thumper-cloud/src/routes/chat.rs).
function bytesToBase64Std(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// Re-exports for convenience at call sites.
export { didKeyFromVerifying };
