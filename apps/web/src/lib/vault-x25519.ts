/**
 * Deterministic X25519 keypair derived from a Turnkey-signed challenge.
 *
 * The vault's encrypt-at-rest path (chat-vault, chat-history-store)
 * needs an X25519 keypair both sides can recover from "tap your wallet"
 * — i.e. without any plaintext secret leaving Turnkey. Ed25519
 * signatures (RFC 8032 §5.1.6) are deterministic for a given
 * `(secret, message)`, so signing a fixed challenge yields the same 64
 * bytes every time. We hash that signature with SHA-512 and take the
 * first 32 bytes as the X25519 secret. The matching public is then
 * `x25519.getPublicKey(secret)` — both halves of a usable keypair the
 * sender and the recipient (same user, same browser) can each derive
 * independently, and that an attacker without Turnkey access cannot.
 *
 * The keypair is **independent of the Turnkey wallet's Ed25519
 * verifying key** — it is NOT the Edwards→Montgomery image of the
 * wallet pubkey. That's by design: we already use the wallet pubkey
 * for identity (the `did:key:z…`); using a separate keypair for
 * envelope ECDH avoids surprising key-reuse semantics.
 *
 * The challenge bytes are fixed and not secret. Their only role is to
 * ensure the signature is unique to (vault encrypt-at-rest x user
 * Turnkey wallet).
 */

import { x25519 } from "@noble/curves/ed25519";

const VAULT_X25519_CHALLENGE = new TextEncoder().encode(
  "ghola/vault-x25519-derive-v1\0",
);

export interface VaultX25519Keypair {
  secret: Uint8Array;
  publicKey: Uint8Array;
}

/**
 * Derive a deterministic X25519 keypair using `signBytes` to obtain a
 * deterministic Ed25519 signature over the fixed challenge.
 *
 * Repeated calls with the same `signBytes` (same Turnkey wallet)
 * produce identical keypairs.
 */
export async function deriveVaultX25519Keypair(
  signBytes: (msg: Uint8Array) => Promise<Uint8Array>,
): Promise<VaultX25519Keypair> {
  const sig = await signBytes(VAULT_X25519_CHALLENGE);
  if (sig.length !== 64) {
    throw new Error(`expected 64-byte Ed25519 signature, got ${sig.length}`);
  }
  // Copy into a fresh ArrayBuffer-backed view so SubtleCrypto strict
  // BufferSource typing accepts it.
  const sigBuf = new ArrayBuffer(sig.length);
  new Uint8Array(sigBuf).set(sig);
  const hashBuf = await crypto.subtle.digest("SHA-512", sigBuf);
  const secret = new Uint8Array(hashBuf).slice(0, 32);
  const publicKey = x25519.getPublicKey(secret);
  return { secret, publicKey };
}
