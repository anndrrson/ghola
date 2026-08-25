import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { x25519 } from "@noble/curves/ed25519";
import { openSealedBundle } from "../src/crypto/envelope.js";
import { prepareAsterCredential } from "../src/venues/aster-provisioning.js";

const PRIVATE_KEY = `0x${"31".repeat(32)}`;
const OWNER = `0x${"22".repeat(20)}`;

function recipient() {
  const secret = new Uint8Array(32).fill(9);
  return {
    recipient_id: "phala:cvm:aster-provisioning-test",
    x25519_secret_hex: Buffer.from(secret).toString("hex"),
    x25519_pub_hex: Buffer.from(x25519.getPublicKey(secret)).toString("hex"),
  };
}

function sealingIdentity() {
  const pair = generateKeyPairSync("ed25519");
  return { privateKey: pair.privateKey, publicKey: pair.publicKey };
}

test("generates and self-seals an Aster signer without returning its private key", async () => {
  let generated = 0;
  const workerRecipient = recipient();
  const prepared = await prepareAsterCredential({
    ownerAddress: OWNER,
    accountCommitment: "private_account_aster_programmatic_test",
    recipient: workerRecipient,
    attestationEvidence: { quote_hash: "quote-test" },
    now: () => new Date("2026-08-24T22:00:00.000Z"),
    generateSignerPrivateKey: async () => {
      generated += 1;
      return PRIVATE_KEY;
    },
    sealingIdentity,
  });

  assert.equal(generated, 1);
  assert.equal(JSON.stringify(prepared).includes(PRIVATE_KEY), false);
  assert.deepEqual(prepared.setup, { may_place_trade: false, transaction_broadcast: false });
  assert.equal(prepared.permissions.can_perp_trade, true);
  assert.equal(prepared.permissions.can_spot_trade, false);
  assert.equal(prepared.permissions.can_withdraw, false);
  assert.equal(prepared.attested_signer.private_key_exposed, false);

  const opened = await openSealedBundle(prepared.encrypted_execution_vault, workerRecipient, {
    expectedKind: "ghola_aster_execution_vault",
    expectedAad: prepared.encrypted_execution_vault.aad,
  });
  assert.equal(opened.json.api_wallet_private_key, PRIVATE_KEY);
  assert.equal(opened.json.user_address, OWNER);
  assert.equal(opened.json.signer_address, prepared.signer_address);
  assert.deepEqual(opened.json.allowed_operations, ["read", "limit_order", "cancel", "reconcile"]);
  assert.equal(opened.json.blocked_operations.includes("withdraw"), true);
});

test("fails before key generation for invalid owner, account, or recipient", async () => {
  const invalid = [
    { ownerAddress: "bad", accountCommitment: "private_account_valid", recipient: recipient(), code: "owner_address_invalid" },
    { ownerAddress: OWNER, accountCommitment: "bad", recipient: recipient(), code: "account_commitment_invalid" },
    { ownerAddress: OWNER, accountCommitment: "private_account_valid", recipient: {}, code: "recipient_unavailable" },
  ];
  for (const input of invalid) {
    let generated = false;
    await assert.rejects(prepareAsterCredential({
      ...input,
      generateSignerPrivateKey: async () => {
        generated = true;
        return PRIVATE_KEY;
      },
      sealingIdentity,
    }), (error) => error.code === input.code);
    assert.equal(generated, false);
  }
});

test("never allows the generated signer to equal the collateral owner", async () => {
  const owner = (await import("viem/accounts")).privateKeyToAccount(PRIVATE_KEY).address;
  await assert.rejects(prepareAsterCredential({
    ownerAddress: owner,
    accountCommitment: "private_account_aster_collision",
    recipient: recipient(),
    generateSignerPrivateKey: async () => PRIVATE_KEY,
    sealingIdentity,
  }), (error) => error.code === "owner_signer_collision");
});
