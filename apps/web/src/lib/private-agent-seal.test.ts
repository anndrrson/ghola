import { describe, expect, it } from "vitest";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import {
  didKeyFromVerifying,
  localEd25519Signer,
  open,
} from "./envelope";
import { buildPrivateAgentSessionRequest } from "./private-agent-seal";
import { compileTradingStrategy, type TradingStrategyRecord } from "./trading-strategy";
import type { ConfidentialComputeProviderStatus } from "./private-agent-runtime";

function base64ToBytes(value: string): Uint8Array {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

describe("private agent sealing", () => {
  it("seals strategy plaintext to the provider recipient only", async () => {
    const userSecret = ed25519.utils.randomPrivateKey();
    const userDid = didKeyFromVerifying(ed25519.getPublicKey(userSecret));
    const compiled = compileTradingStrategy("DCA $25 into ETH every Friday", userDid, {
      mode: "capped_session_key",
    });
    if (!compiled.ok) throw new Error(compiled.reason);

    const recipientSecret = x25519.utils.randomPrivateKey();
    const recipientPub = x25519.getPublicKey(recipientSecret);
    const provider: ConfidentialComputeProviderStatus = {
      id: "phala",
      label: "Phala TEE",
      configured: true,
      available: true,
      attested: true,
      supports_sealed_secrets: true,
      supports_background_agents: true,
      supports_trading_execution: true,
      reason: null,
      sealed_recipient: {
        recipient_id: "phala:cvm:test",
        x25519_pub_hex: Array.from(recipientPub)
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join(""),
        tee_kind: "phala",
        measurement_hex: "00".repeat(32),
      },
    };
    const record: TradingStrategyRecord = {
      id: compiled.policy.strategy_id,
      source: "DCA $25 into ETH every Friday",
      policy: compiled.policy,
      review_summary: compiled.review_summary,
      receipts: [],
      active: true,
      created_at: "2026-05-24T00:00:00.000Z",
      updated_at: "2026-05-24T00:00:00.000Z",
    };

    const built = await buildPrivateAgentSessionRequest({
      record,
      ownerDid: userDid,
      provider,
      signBytes: localEd25519Signer(userSecret),
    });

    expect(JSON.stringify(built.request)).not.toContain(record.source);
    expect(built.request.encrypted_strategy_bundle.recipient).toBe("phala:cvm:test");
    expect(built.request.requested_provider).toBe("phala");

    const opened = await open(
      base64ToBytes(built.request.encrypted_strategy_bundle.ciphertext),
      recipientSecret,
    );
    const plaintext = JSON.parse(new TextDecoder().decode(opened.plaintext)) as {
      source: string;
      policy: { strategy_id: string };
    };

    expect(plaintext.source).toBe(record.source);
    expect(plaintext.policy.strategy_id).toBe(record.id);
    expect(new TextDecoder().decode(opened.associatedData)).toBe(built.associated_data);
  });

  it("refuses to seal without a provider recipient", async () => {
    const userSecret = ed25519.utils.randomPrivateKey();
    const userDid = didKeyFromVerifying(ed25519.getPublicKey(userSecret));
    const compiled = compileTradingStrategy("DCA $25 into ETH every Friday", userDid, {
      mode: "capped_session_key",
    });
    if (!compiled.ok) throw new Error(compiled.reason);

    await expect(
      buildPrivateAgentSessionRequest({
        record: {
          id: compiled.policy.strategy_id,
          source: "DCA $25 into ETH every Friday",
          policy: compiled.policy,
          review_summary: compiled.review_summary,
          receipts: [],
          active: true,
          created_at: "2026-05-24T00:00:00.000Z",
          updated_at: "2026-05-24T00:00:00.000Z",
        },
        ownerDid: userDid,
        provider: {
          id: "phala",
          label: "Phala TEE",
          configured: true,
          available: true,
          attested: true,
          supports_sealed_secrets: true,
          supports_background_agents: true,
          supports_trading_execution: true,
          reason: null,
        },
        signBytes: localEd25519Signer(userSecret),
      }),
    ).rejects.toThrow("sealed recipient");
  });
});
