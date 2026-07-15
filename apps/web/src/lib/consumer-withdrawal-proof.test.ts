// @vitest-environment node
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { buildConsumerWithdrawalChallenge, verifyConsumerWithdrawalProof } from "./consumer-withdrawal-proof";

describe("consumer withdrawal proof", () => {
  it("binds a wallet signature to the withdrawal action and id", () => {
    const secret = ed25519.utils.randomPrivateKey();
    const wallet = bs58.encode(ed25519.getPublicKey(secret));
    const now = new Date("2026-07-15T12:00:00.000Z");
    const challenge = buildConsumerWithdrawalChallenge({
      owner_commitment: "owner_test",
      wallet_pubkey: wallet,
      action: "cancel",
      withdrawal_id: "withdrawal_test_123",
      now,
    });
    const signature = Buffer.from(ed25519.sign(new TextEncoder().encode(challenge.message), secret)).toString("base64");
    expect(verifyConsumerWithdrawalProof({ message: challenge.message, signature_b64: signature }, {
      owner_commitment: "owner_test",
      wallet_pubkey: wallet,
      action: "cancel",
      withdrawal_id: "withdrawal_test_123",
      now_ms: now.getTime(),
    }).ok).toBe(true);
    expect(verifyConsumerWithdrawalProof({ message: challenge.message, signature_b64: signature }, {
      owner_commitment: "owner_test",
      wallet_pubkey: wallet,
      action: "create",
      now_ms: now.getTime(),
    }).ok).toBe(false);
  });
});
