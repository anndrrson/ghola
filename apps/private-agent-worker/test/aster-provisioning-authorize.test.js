import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { x25519 } from "@noble/curves/ed25519";
import { privateKeyToAccount } from "viem/accounts";
import { bytesToBase64, didKeyFromVerifying, hexToBytes, sealEnvelope } from "../src/crypto/envelope.js";
import { createWorkerState } from "../src/state/private-state.js";
import {
  asterPreparationId,
  asterRegistrationParameters,
  asterRegistrationTypedData,
  authorizeAsterCredential,
  prepareAsterCredential,
  recoverAsterCredentialRegistration,
} from "../src/venues/aster-provisioning.js";

const OWNER_KEY = `0x${"42".repeat(32)}`;
const SIGNER_KEY = `0x${"31".repeat(32)}`;
const NOW = 1_800_000_000_000;

function recipient() {
  const secret = new Uint8Array(32).fill(13);
  return {
    recipient_id: "phala:cvm:aster-authorize-test",
    x25519_secret_hex: Buffer.from(secret).toString("hex"),
    x25519_pub_hex: Buffer.from(x25519.getPublicKey(secret)).toString("hex"),
  };
}

function sealingIdentity() {
  const pair = generateKeyPairSync("ed25519");
  return { privateKey: pair.privateKey, publicKey: pair.publicKey };
}

async function authorizationFixture(accountCommitment = "private_account_aster_authorize_test") {
  const ownerAccount = privateKeyToAccount(OWNER_KEY);
  const workerRecipient = recipient();
  const workerSealingIdentity = sealingIdentity();
  const prepared = await prepareAsterCredential({
    ownerAddress: ownerAccount.address,
    accountCommitment,
    recipient: workerRecipient,
    now: () => new Date(NOW),
    generateSignerPrivateKey: async () => SIGNER_KEY,
    sealingIdentity: () => workerSealingIdentity,
  });
  const nonce = NOW * 1_000;
  const expired = NOW + 3_600_000;
  const parameters = asterRegistrationParameters({
    owner: ownerAccount.address,
    nonce,
    agentName: "ghola-perps",
    signer: prepared.signer_address,
    expired,
    ipWhitelist: [],
  });
  const typedData = asterRegistrationTypedData(parameters);
  const signature = await ownerAccount.signTypedData({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message,
  });
  return {
    recipient: workerRecipient,
    sealingIdentity: () => workerSealingIdentity,
    body: {
      version: 1,
      venue_id: "aster",
      platform_class: "hyperliquid_style_market",
      execution_mode: "worker_generated_agent",
      operation_class: "credential_authorize",
      owner_commitment: "owner_commitment_aster_authorize_test",
      account_commitment: accountCommitment,
      owner_address: ownerAccount.address,
      signer_address: prepared.signer_address,
      preparation_id: asterPreparationId({
        accountCommitment,
        ownerAddress: ownerAccount.address,
        signerAddress: prepared.signer_address,
        nonce,
      }),
      agent_name: "ghola-perps",
      nonce,
      expired,
      ip_whitelist: [],
      signature,
      encrypted_execution_vault: prepared.encrypted_execution_vault,
    },
  };
}

test("registers once, caches success, and never submits a trade", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-aster-authorize-"));
  try {
    const fixture = await authorizationFixture();
    const state = createWorkerState(dir);
    let calls = 0;
    const fetchImpl = async (url, init) => {
      calls += 1;
      assert.equal(String(url), "https://fapi.asterdex.com/fapi/v3/approveAgent");
      assert.equal(init.method, "POST");
      const form = new URLSearchParams(init.body);
      assert.equal(form.get("canPerpTrade"), "true");
      assert.equal(form.get("canSpotTrade"), "false");
      assert.equal(form.get("canWithdraw"), "false");
      assert.equal(form.get("agentAddress"), fixture.body.signer_address);
      assert.equal(form.has("signatureChainId"), false);
      assert.equal(form.has("symbol"), false);
      return Response.json({ code: 200, msg: "success" });
    };
    const first = await authorizeAsterCredential({
      ...fixture,
      state,
      fetchImpl,
      nowMs: NOW,
    });
    const second = await authorizeAsterCredential({
      ...fixture,
      state,
      fetchImpl,
      nowMs: NOW,
    });
    assert.equal(calls, 1);
    assert.equal(first.status, "registered");
    assert.deepEqual(second, first);
    assert.equal(first.permissions.can_withdraw, false);
    assert.deepEqual(first.setup, {
      may_place_trade: false,
      transaction_broadcast: false,
      credential_registered: true,
    });
    assert.equal(JSON.stringify(first).includes(OWNER_KEY), false);
    assert.equal(JSON.stringify(first).includes(SIGNER_KEY), false);
    await assert.rejects(authorizeAsterCredential({
      ...fixture,
      body: { ...fixture.body, agent_name: "mutated-agent" },
      state,
      fetchImpl,
      nowMs: NOW,
    }), (error) => error.code === "aster_owner_signature_mismatch");
    assert.equal(calls, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recovers only the exact cached receipt without contacting Aster again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-aster-recover-"));
  try {
    const fixture = await authorizationFixture("private_account_aster_recover_test");
    const state = createWorkerState(dir);
    let calls = 0;
    const registered = await authorizeAsterCredential({
      ...fixture,
      state,
      fetchImpl: async () => {
        calls += 1;
        return Response.json({ code: 200, msg: "success" });
      },
      nowMs: NOW,
    });
    const recovered = await recoverAsterCredentialRegistration({
      state,
      body: {
        account_commitment: fixture.body.account_commitment,
        owner_address: fixture.body.owner_address,
        signer_address: fixture.body.signer_address,
        preparation_id: fixture.body.preparation_id,
        nonce: fixture.body.nonce,
        signature_commitment: registered.owner_authorization.signature_commitment,
      },
    });
    assert.deepEqual(recovered, registered);
    assert.equal(calls, 1);
    await assert.rejects(recoverAsterCredentialRegistration({
      state,
      body: {
        account_commitment: fixture.body.account_commitment,
        owner_address: fixture.body.owner_address,
        signer_address: fixture.body.signer_address,
        preparation_id: fixture.body.preparation_id,
        nonce: fixture.body.nonce,
        signature_commitment: `sha256:${"ff".repeat(32)}`,
      },
    }), (error) => error.code === "aster_recovery_binding_invalid");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("atomically claims one concurrent registration attempt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-aster-concurrent-"));
  let releaseProvider;
  try {
    const fixture = await authorizationFixture("private_account_aster_concurrent_test");
    const state = createWorkerState(dir);
    let calls = 0;
    let markProviderStarted;
    const providerStarted = new Promise((resolve) => { markProviderStarted = resolve; });
    const providerReleased = new Promise((resolve) => { releaseProvider = resolve; });
    const fetchImpl = async () => {
      calls += 1;
      markProviderStarted();
      await providerReleased;
      return Response.json({ code: 200, msg: "success" });
    };
    const first = authorizeAsterCredential({
      ...fixture,
      state,
      fetchImpl,
      nowMs: NOW,
    });
    await providerStarted;
    await assert.rejects(authorizeAsterCredential({
      ...fixture,
      state,
      fetchImpl,
      nowMs: NOW,
    }), (error) => error.code === "aster_registration_not_retryable");
    releaseProvider();
    const receipt = await first;
    assert.equal(receipt.status, "registered");
    assert.equal(calls, 1);
  } finally {
    releaseProvider?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("freezes an ambiguous registration and never retries it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-aster-ambiguous-"));
  try {
    const fixture = await authorizationFixture("private_account_aster_ambiguous_test");
    const state = createWorkerState(dir);
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      throw new Error("connection lost after write");
    };
    await assert.rejects(authorizeAsterCredential({
      ...fixture,
      state,
      fetchImpl,
      nowMs: NOW,
    }), (error) => error.code === "aster_registration_ambiguous");
    await assert.rejects(authorizeAsterCredential({
      ...fixture,
      state,
      fetchImpl,
      nowMs: NOW,
    }), (error) => error.code === "aster_registration_ambiguous");
    assert.equal(calls, 1);
    assert.equal((await state.getExecutionAttempt(fixture.body.preparation_id)).status, "ambiguous");
    await assert.rejects(recoverAsterCredentialRegistration({
      state,
      body: {
        account_commitment: fixture.body.account_commitment,
        owner_address: fixture.body.owner_address,
        signer_address: fixture.body.signer_address,
        preparation_id: fixture.body.preparation_id,
        nonce: fixture.body.nonce,
        signature_commitment: `sha256:${"00".repeat(32)}`,
      },
    }), (error) => error.code === "aster_registration_ambiguous");
    assert.equal(calls, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects an owner-signature mismatch before any provider call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-aster-signature-"));
  try {
    const fixture = await authorizationFixture("private_account_aster_bad_signature");
    const state = createWorkerState(dir);
    fixture.body.signature = await privateKeyToAccount(`0x${"43".repeat(32)}`).signTypedData(
      asterRegistrationTypedData(asterRegistrationParameters({
        owner: fixture.body.owner_address,
        nonce: fixture.body.nonce,
        agentName: fixture.body.agent_name,
        signer: fixture.body.signer_address,
        expired: fixture.body.expired,
        ipWhitelist: fixture.body.ip_whitelist,
      })),
    );
    let calls = 0;
    await assert.rejects(authorizeAsterCredential({
      ...fixture,
      state,
      fetchImpl: async () => {
        calls += 1;
        return Response.json({ code: 200, msg: "success" });
      },
      nowMs: NOW,
    }), (error) => error.code === "aster_owner_signature_mismatch");
    assert.equal(calls, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("keeps owner-approved metadata bound to the worker-prepared vault", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-aster-prepared-binding-"));
  try {
    const fixture = await authorizationFixture("private_account_aster_prepared_binding");
    fixture.body.agent_name = "different-agent";
    fixture.body.signature = await privateKeyToAccount(OWNER_KEY).signTypedData(
      asterRegistrationTypedData(asterRegistrationParameters({
        owner: fixture.body.owner_address,
        nonce: fixture.body.nonce,
        agentName: fixture.body.agent_name,
        signer: fixture.body.signer_address,
        expired: fixture.body.expired,
        ipWhitelist: fixture.body.ip_whitelist,
      })),
    );
    let calls = 0;
    await assert.rejects(authorizeAsterCredential({
      ...fixture,
      state: createWorkerState(dir),
      fetchImpl: async () => {
        calls += 1;
        return Response.json({ code: 200, msg: "success" });
      },
      nowMs: NOW,
    }), (error) => error.code === "aster_sealed_binding_invalid");
    assert.equal(calls, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("accepts only a worker-authenticated seal whose private key matches the approved signer", async () => {
  for (const scenario of ["untrusted_seal", "mismatched_key"]) {
    const dir = mkdtempSync(join(tmpdir(), `ghola-aster-${scenario}-`));
    try {
      const fixture = await authorizationFixture(`private_account_aster_${scenario}`);
      const identity = scenario === "untrusted_seal" ? sealingIdentity() : fixture.sealingIdentity();
      const privateKey = scenario === "mismatched_key" ? `0x${"32".repeat(32)}` : SIGNER_KEY;
      fixture.body.encrypted_execution_vault = await sealedVault(fixture, identity, privateKey);
      let calls = 0;
      await assert.rejects(authorizeAsterCredential({
        ...fixture,
        state: createWorkerState(dir),
        fetchImpl: async () => {
          calls += 1;
          return Response.json({ code: 200, msg: "success" });
        },
        nowMs: NOW,
      }), (error) => error.code === "aster_sealed_binding_invalid");
      assert.equal(calls, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

async function sealedVault(fixture, identity, privateKey) {
  const publicDer = identity.publicKey.export({ format: "der", type: "spki" });
  const publicBytes = new Uint8Array(Buffer.from(publicDer).subarray(-32));
  const ciphertext = await sealEnvelope({
    recipientId: fixture.recipient.recipient_id,
    recipientX25519: hexToBytes(fixture.recipient.x25519_pub_hex),
    senderDid: didKeyFromVerifying(publicBytes),
    associatedData: fixture.body.encrypted_execution_vault.aad,
    plaintext: {
      version: 1,
      kind: "ghola_aster_execution_vault",
      network: "mainnet",
      user_address: fixture.body.owner_address,
      signer_address: fixture.body.signer_address,
      api_wallet_private_key: privateKey,
      label: fixture.body.agent_name,
      allowed_operations: ["read", "limit_order", "cancel", "reconcile"],
      blocked_operations: ["withdraw", "vault_transfer", "leverage_escalation"],
      created_at: new Date(NOW).toISOString(),
    },
    signBody: async (digest) => new Uint8Array(edSign(null, Buffer.from(digest), identity.privateKey)),
  });
  return {
    ...fixture.body.encrypted_execution_vault,
    ciphertext: bytesToBase64(ciphertext),
  };
}
