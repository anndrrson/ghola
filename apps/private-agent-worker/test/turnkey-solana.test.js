import assert from "node:assert/strict";
import test from "node:test";
import { Transaction } from "@solana/web3.js";
import {
  normalizeTurnkeySolanaSigningConfig,
  publicTurnkeySolanaSigningStatus,
  signTurnkeySolanaTransaction,
} from "../src/venues/turnkey-solana.js";

const AUTHORITY = "Fbw73e5YfhivsTeFud97CFBZc5bZ2PbdDVgcgfYRSgwJ";

function config() {
  return normalizeTurnkeySolanaSigningConfig({
    signing_mode: "turnkey_delegated",
    authority: AUTHORITY,
    turnkey_organization_id: "org-user-001",
    turnkey_agent_key_ref: "worker-agent-001",
    owner_mandate_commitment: "mandate:solana:001",
    turnkey_policy_commitment: "policy:solana:001",
  });
}

test("normalizes only committed Turnkey delegated Solana authority", () => {
  const normalized = config();
  assert.equal(normalized.authority, AUTHORITY);
  const status = publicTurnkeySolanaSigningStatus(normalized);
  assert.equal(status.exportable_private_key_present, false);
  assert.throws(
    () => normalizeTurnkeySolanaSigningConfig({ signing_mode: "turnkey_delegated", authority: AUTHORITY }),
    /turnkey_organization_required/,
  );
});

test("passes the exact authority and organization to the Turnkey signer", async () => {
  const transaction = new Transaction();
  const calls = [];
  const signed = await signTurnkeySolanaTransaction({
    transaction,
    config: config(),
    signerFactory: () => ({
      async signTransaction(value, authority, organizationId) {
        calls.push({ value, authority, organizationId });
        return value;
      },
    }),
  });
  assert.equal(signed, transaction);
  assert.equal(calls[0].authority, AUTHORITY);
  assert.equal(calls[0].organizationId, "org-user-001");
});
