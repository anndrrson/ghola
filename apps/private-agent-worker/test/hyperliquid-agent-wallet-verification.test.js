import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import {
  bytesToBase64,
  bytesToHex,
  didKeyFromVerifying,
  sealForTest,
} from "../src/crypto/envelope.js";
import {
  hyperliquidAgentLegacyRemovalBundleCommitment,
  hyperliquidAgentOnboardingBundleCommitment,
  validateHyperliquidAgentLegacyRemovalRequest,
  validateHyperliquidAgentWalletVerificationRequest,
  verifyHyperliquidLegacyAgentRevoked,
  verifyHyperliquidAgentWalletOnboarding,
} from "../src/execution/hyperliquid-agent-wallet-verification.js";

const MASTER = `0x${"11".repeat(20)}`;
const AGENT_KEY = `0x${"22".repeat(32)}`;
const AGENT = deriveAddress(AGENT_KEY);
const ACCOUNT = "private_account_test";
const VALID_UNTIL = 1_780_086_400_000;

async function fixture({ legacy = false } = {}) {
  const recipientSecret = x25519.utils.randomPrivateKey();
  const recipient = {
    recipient_id: "attested:onboarding-test",
    x25519_pub_hex: bytesToHex(x25519.getPublicKey(recipientSecret)),
    x25519_secret_hex: bytesToHex(recipientSecret),
  };
  const senderSecret = ed25519.utils.randomPrivateKey();
  const venueCommitment = commitment("hyperliquid_venue_account", MASTER);
  const agentCommitment = commitment("hyperliquid_agent_wallet", AGENT);
  const aad = [
    legacy
      ? "ghola/hyperliquid-execution-vault-v1"
      : "ghola/hyperliquid-execution-vault-v2",
    `account:${ACCOUNT}`,
    `recipient:${recipient.recipient_id}`,
    "network:mainnet",
    ...(legacy ? [] : [
      `venue-account:${venueCommitment}`,
      `agent-wallet:${agentCommitment}`,
    ]),
  ].join("|");
  const wire = await sealForTest({
    recipientId: recipient.recipient_id,
    recipientX25519: x25519.getPublicKey(recipientSecret),
    senderDid: didKeyFromVerifying(ed25519.getPublicKey(senderSecret)),
    associatedData: aad,
    plaintext: {
      version: 1,
      kind: "ghola_hyperliquid_execution_vault",
      network: "mainnet",
      hyperliquid_account_address: MASTER,
      api_wallet_private_key: AGENT_KEY,
      agent_name: legacy ? "legacy-ghola-agent" : "ghola-mainnet",
      allowed_operations: ["read", "limit_order", "cancel", "reconcile"],
      blocked_operations: ["withdraw", "vault_transfer", "leverage_escalation"],
      created_at: "2026-05-27T12:00:00.000Z",
    },
    signBody: async (digest) => ed25519.sign(digest, senderSecret),
  });
  const bundle = {
    alg: "sealed-provider-v1",
    ciphertext: bytesToBase64(wire),
    recipient: recipient.recipient_id,
    aad,
  };
  const body = legacy ? {
    version: 1,
    venue_id: "hyperliquid",
    platform_class: "hyperliquid_style_market",
    execution_mode: "byo_api_key",
    operation_class: "agent_wallet_legacy_revocation_verify",
    account_commitment: ACCOUNT,
    vault_bundle_commitment: hyperliquidAgentLegacyRemovalBundleCommitment(bundle),
    encrypted_execution_vault: bundle,
  } : {
    version: 1,
    venue_id: "hyperliquid",
    platform_class: "hyperliquid_style_market",
    execution_mode: "byo_api_key",
    operation_class: "agent_wallet_onboarding_verify",
    account_commitment: ACCOUNT,
    vault_bundle_commitment: hyperliquidAgentOnboardingBundleCommitment(bundle),
    encrypted_execution_vault: bundle,
    expected_authorization: {
      venue_account_commitment: venueCommitment,
      agent_wallet_commitment: agentCommitment,
      agent_base_name: "ghola-mainnet",
      agent_name: `ghola-mainnet valid_until ${VALID_UNTIL}`,
      valid_until_ms: VALID_UNTIL,
    },
  };
  return { recipient, body };
}

function venueFetch({ unavailable = false, rows = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    if (unavailable) throw new TypeError("offline");
    return new Response(JSON.stringify(rows ?? [{
      name: "ghola-mainnet",
      address: AGENT,
      validUntil: VALID_UNTIL,
    }]), { status: 200 });
  };
  return { fetchImpl, calls };
}

describe("Hyperliquid onboarding worker verification", () => {
  it("decrypts, derives, and matches the exact authorized agent without a submit", async () => {
    const { recipient, body } = await fixture();
    const venue = venueFetch();
    const proof = await verifyHyperliquidAgentWalletOnboarding({
      body,
      recipient,
      fetchImpl: venue.fetchImpl,
      sleep: async () => undefined,
    });
    assert.equal(proof.status, "verified");
    assert.equal(proof.decrypted, true);
    assert.equal(proof.derived_agent_address_verified, true);
    assert.equal(proof.venue_authorization_verified, true);
    assert.equal(proof.no_submit, true);
    assert.equal(proof.vault_bundle_commitment, body.vault_bundle_commitment);
    assert.deepEqual(venue.calls.map((call) => call.body), [{ type: "extraAgents", user: MASTER }]);
    assert.equal(JSON.stringify(proof).includes(MASTER), false);
    assert.equal(JSON.stringify(proof).includes(AGENT), false);
    assert.equal(JSON.stringify(proof).includes(AGENT_KEY), false);
  });

  it("rejects a committed identity mismatch before calling Hyperliquid", async () => {
    const { recipient, body } = await fixture();
    body.expected_authorization.agent_wallet_commitment = `hyperliquid_agent_wallet_${"0".repeat(48)}`;
    const venue = venueFetch();
    await assert.rejects(
      verifyHyperliquidAgentWalletOnboarding({ body, recipient, fetchImpl: venue.fetchImpl }),
      (error) => error.code === "hyperliquid_agent_vault_identity_mismatch" && error.status === 409,
    );
    assert.equal(venue.calls.length, 0);
  });

  it("fails closed when the exact ciphertext cannot be decrypted", async () => {
    const { recipient, body } = await fixture();
    body.encrypted_execution_vault.ciphertext = `${body.encrypted_execution_vault.ciphertext.slice(0, -4)}AAAA`;
    body.vault_bundle_commitment = hyperliquidAgentOnboardingBundleCommitment(body.encrypted_execution_vault);
    await assert.rejects(
      verifyHyperliquidAgentWalletOnboarding({ body, recipient }),
      (error) => error.code === "hyperliquid_agent_vault_unreadable" && error.status === 409,
    );
  });

  it("rejects a recipient mismatch at request validation", async () => {
    const { recipient, body } = await fixture();
    body.encrypted_execution_vault.recipient = "attested:other";
    body.vault_bundle_commitment = hyperliquidAgentOnboardingBundleCommitment(body.encrypted_execution_vault);
    assert.ok(validateHyperliquidAgentWalletVerificationRequest(body, recipient).includes(
      "encrypted_execution_vault recipient mismatch",
    ));
  });

  it("returns unknown when extraAgents cannot be read authoritatively", async () => {
    const { recipient, body } = await fixture();
    const venue = venueFetch({ unavailable: true });
    await assert.rejects(
      verifyHyperliquidAgentWalletOnboarding({
        body,
        recipient,
        fetchImpl: venue.fetchImpl,
        sleep: async () => undefined,
      }),
      (error) => error.code === "hyperliquid_agent_authorization_state_unknown" && error.status === 503,
    );
    assert.equal(venue.calls.length, 5);
  });

  it("returns unknown for ambiguous reserved-name agent rows", async () => {
    const { recipient, body } = await fixture();
    const venue = venueFetch({
      rows: [{ name: "ghola-mainnet", address: AGENT, validUntil: VALID_UNTIL }, {
        name: `ghola-mainnet valid_until ${VALID_UNTIL - 1}`,
        address: `0x${"55".repeat(20)}`,
        validUntil: VALID_UNTIL - 1,
      }],
    });
    await assert.rejects(
      verifyHyperliquidAgentWalletOnboarding({
        body,
        recipient,
        fetchImpl: venue.fetchImpl,
        sleep: async () => undefined,
      }),
      (error) => error.code === "hyperliquid_agent_authorization_state_unknown" && error.status === 503,
    );
  });
});

describe("Hyperliquid legacy-agent removal verification", () => {
  it("proves the decrypted legacy agent is absent without submitting or exposing identity", async () => {
    const { recipient, body } = await fixture({ legacy: true });
    const venue = venueFetch({ rows: [] });
    const proof = await verifyHyperliquidLegacyAgentRevoked({
      body,
      recipient,
      fetchImpl: venue.fetchImpl,
      sleep: async () => undefined,
    });
    assert.equal(proof.proof_kind, "hyperliquid_legacy_agent_revocation_verification_v1");
    assert.equal(proof.status, "revoked");
    assert.equal(proof.decrypted, true);
    assert.equal(proof.derived_agent_address_verified, true);
    assert.equal(proof.venue_authorization_absent, true);
    assert.equal(proof.no_submit, true);
    assert.equal(venue.calls.length, 5);
    assert.ok(venue.calls.every((call) => call.body.type === "extraAgents"));
    const serialized = JSON.stringify(proof);
    assert.equal(serialized.includes(MASTER), false);
    assert.equal(serialized.includes(AGENT), false);
    assert.equal(serialized.includes(AGENT_KEY), false);
  });

  it("refuses local removal while the decrypted legacy agent remains authorized", async () => {
    const { recipient, body } = await fixture({ legacy: true });
    const venue = venueFetch();
    await assert.rejects(
      verifyHyperliquidLegacyAgentRevoked({
        body,
        recipient,
        fetchImpl: venue.fetchImpl,
        sleep: async () => undefined,
      }),
      (error) => error.code === "legacy_hyperliquid_agent_still_authorized" && error.status === 409,
    );
    assert.equal(venue.calls.length, 1);
  });

  it("fails closed when legacy authority cannot be read authoritatively", async () => {
    const { recipient, body } = await fixture({ legacy: true });
    const venue = venueFetch({ unavailable: true });
    await assert.rejects(
      verifyHyperliquidLegacyAgentRevoked({
        body,
        recipient,
        fetchImpl: venue.fetchImpl,
        sleep: async () => undefined,
      }),
      (error) => error.code === "hyperliquid_agent_authorization_state_unknown" && error.status === 503,
    );
    assert.equal(venue.calls.length, 5);
  });

  it("accepts only an exact legacy-mainnet bundle request", async () => {
    const { recipient, body } = await fixture({ legacy: true });
    assert.deepEqual(validateHyperliquidAgentLegacyRemovalRequest(body, recipient), []);
    body.encrypted_execution_vault.recipient = "attested:other";
    body.vault_bundle_commitment = hyperliquidAgentLegacyRemovalBundleCommitment(
      body.encrypted_execution_vault,
    );
    assert.ok(validateHyperliquidAgentLegacyRemovalRequest(body, recipient).includes(
      "encrypted_execution_vault recipient mismatch",
    ));
  });
});

function deriveAddress(privateKey) {
  const publicKey = secp256k1.getPublicKey(Buffer.from(privateKey.slice(2), "hex"), false);
  return `0x${Buffer.from(keccak_256(publicKey.slice(1))).subarray(12).toString("hex")}`;
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

function commitment(prefix, value) {
  return `${prefix}_${createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 48)}`;
}
