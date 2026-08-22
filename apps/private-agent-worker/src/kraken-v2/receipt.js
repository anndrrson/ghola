import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { stableJson } from "./commitment.js";

export function createReceiptSigner(options = {}) {
  let privateKey;
  if (options.privateKey) {
    privateKey = options.privateKey.type === "private"
      ? options.privateKey
      : createPrivateKey(options.privateKey);
  } else if (options.privateKeyBase64) {
    privateKey = createPrivateKey({
      key: Buffer.from(options.privateKeyBase64, "base64"),
      format: "der",
      type: "pkcs8",
    });
  } else if (options.allowEphemeral) {
    privateKey = generateKeyPairSync("ed25519").privateKey;
  } else {
    throw new Error("Kraken receipt Ed25519 signing key is required");
  }
  const publicKey = createPublicKey(privateKey);
  const publicKeyBase64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");

  return {
    publicKeyBase64,
    issue(payload, now = new Date()) {
      const unsigned = {
        version: 1,
        receipt_id: payload.receipt_id || randomUUID(),
        ...payload,
        created_at: payload.created_at || now.toISOString(),
        signing_public_key: publicKeyBase64,
      };
      const signature = sign(null, Buffer.from(stableJson(unsigned)), privateKey).toString("base64");
      return { ...unsigned, signature_algorithm: "Ed25519", signature };
    },
  };
}

export function verifyReceipt(receipt) {
  const { signature, signature_algorithm: algorithm, ...unsigned } = receipt;
  if (algorithm !== "Ed25519" || !signature) return false;
  const key = createPublicKey({
    key: Buffer.from(unsigned.signing_public_key, "base64"),
    format: "der",
    type: "spki",
  });
  return verify(
    null,
    Buffer.from(stableJson(unsigned)),
    key,
    Buffer.from(signature, "base64"),
  );
}
