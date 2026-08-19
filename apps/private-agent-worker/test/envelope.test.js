import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import {
  HYPERLIQUID_EXECUTION_VAULT_AAD_PREFIXES,
  bytesToBase64,
  bytesToHex,
  didKeyFromVerifying,
  openSealedBundle,
  sealForTest,
} from "../src/crypto/envelope.js";

async function fixture(aad) {
  const recipientSecret = x25519.utils.randomPrivateKey();
  const senderSecret = ed25519.utils.randomPrivateKey();
  const recipient = {
    recipient_id: "attested:test",
    x25519_pub_hex: bytesToHex(x25519.getPublicKey(recipientSecret)),
    x25519_secret_hex: bytesToHex(recipientSecret),
  };
  const wire = await sealForTest({
    recipientId: recipient.recipient_id,
    recipientX25519: x25519.getPublicKey(recipientSecret),
    senderDid: didKeyFromVerifying(ed25519.getPublicKey(senderSecret)),
    associatedData: aad,
    plaintext: { version: 1, kind: "ghola_hyperliquid_execution_vault" },
    signBody: async (digest) => ed25519.sign(digest, senderSecret),
  });
  return {
    recipient,
    bundle: {
      alg: "sealed-provider-v1",
      ciphertext: bytesToBase64(wire),
      recipient: recipient.recipient_id,
      aad,
    },
  };
}

describe("Hyperliquid sealed-vault AAD versions", () => {
  for (const version of ["v1", "v2"]) {
    it(`accepts the explicit ${version} prefix`, async () => {
      const aad = `ghola/hyperliquid-execution-vault-${version}|account:commitment|recipient:attested:test|network:mainnet`;
      const { recipient, bundle } = await fixture(aad);
      const opened = await openSealedBundle(bundle, recipient, {
        aadPrefixes: HYPERLIQUID_EXECUTION_VAULT_AAD_PREFIXES,
        expectedKind: "ghola_hyperliquid_execution_vault",
      });
      assert.equal(opened.associatedDataText, aad);
    });
  }

  it("rejects unknown Hyperliquid AAD versions", async () => {
    const aad = "ghola/hyperliquid-execution-vault-v3|account:commitment|recipient:attested:test|network:mainnet";
    const { recipient, bundle } = await fixture(aad);
    await assert.rejects(
      openSealedBundle(bundle, recipient, {
        aadPrefixes: HYPERLIQUID_EXECUTION_VAULT_AAD_PREFIXES,
        expectedKind: "ghola_hyperliquid_execution_vault",
      }),
      /associated data prefix mismatch/,
    );
  });
});
