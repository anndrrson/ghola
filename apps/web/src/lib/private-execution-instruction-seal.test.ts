import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { open } from "./envelope";
import {
  buildPrivateExecutionInstructionBundle,
  privateExecutionInstructionAssociatedData,
  validatePrivateExecutionOrderDraft,
} from "./private-execution-instruction-seal";
import type { PrivateAgentRuntimeStatus } from "./private-agent-runtime";

function base64ToBytes(value: string) {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function runtimeWithRecipient(recipientId: string, recipientPub: Uint8Array): PrivateAgentRuntimeStatus {
  return {
    version: 1,
    checked_at: new Date("2026-05-28T00:00:00Z").toISOString(),
    sealed_execution_required: true,
    entitlement_required: "paid_private_agent_plan",
    preferred_provider: "phala",
    selected_provider: "phala",
    remote_execution_ready: true,
    shielded_rail_ready: true,
    blocking_reasons: [],
    disclosure: "test",
    providers: [{
      id: "phala",
      label: "Phala",
      configured: true,
      available: true,
      attested: true,
      supports_sealed_secrets: true,
      supports_background_agents: true,
      supports_trading_execution: true,
      reason: null,
      sealed_recipient: {
        recipient_id: recipientId,
        x25519_pub_hex: Buffer.from(recipientPub).toString("hex"),
      },
    }],
  };
}

describe("private execution instruction sealing", () => {
  it("seals raw order instructions to the attested TEE recipient only", async () => {
    const recipientSecret = x25519.utils.randomPrivateKey();
    const recipientPub = x25519.getPublicKey(recipientSecret);
    const senderSecret = ed25519.utils.randomPrivateKey();
    const senderPub = ed25519.getPublicKey(senderSecret);
    const ownerWalletAddress = bs58.encode(senderPub);
    const recipientId = "phala:cvm:test";
    const runtime: PrivateAgentRuntimeStatus = {
      version: 1,
      checked_at: new Date("2026-05-28T00:00:00Z").toISOString(),
      sealed_execution_required: true,
      entitlement_required: "paid_private_agent_plan",
      preferred_provider: "phala",
      selected_provider: "phala",
      remote_execution_ready: true,
      shielded_rail_ready: true,
      blocking_reasons: [],
      disclosure: "test",
      providers: [{
        id: "phala",
        label: "Phala",
        configured: true,
        available: true,
        attested: true,
        supports_sealed_secrets: true,
        supports_background_agents: true,
        supports_trading_execution: true,
        reason: null,
        sealed_recipient: {
          recipient_id: recipientId,
          x25519_pub_hex: Buffer.from(recipientPub).toString("hex"),
        },
      }],
    };
    const aad = privateExecutionInstructionAssociatedData({
      previewCommitment: "preview_commitment_test",
      venueId: "coinbase_advanced",
      recipientId,
    });

    const built = await buildPrivateExecutionInstructionBundle({
      ownerWalletAddress,
      previewCommitment: "preview_commitment_test",
      runtimeStatus: runtime,
      signBytes: async (bytes) => ed25519.sign(bytes, senderSecret),
      order: {
        venue_id: "coinbase_advanced",
        operation_class: "spot_limit_order",
        market: "BTC-USD",
        side: "buy",
        base_size: "0.001",
        limit_price: "10000",
        tif: "gtc",
      },
      now: new Date("2026-05-28T00:00:00Z"),
    });

    expect(built.associated_data).toBe(aad);
    expect(built.encrypted_execution_instruction_bundle.aad).toBe(aad);
    expect(JSON.stringify(built.encrypted_execution_instruction_bundle)).not.toContain("BTC-USD");
    expect(JSON.stringify(built.encrypted_execution_instruction_bundle)).not.toContain("10000");

    const opened = await open(
      base64ToBytes(built.encrypted_execution_instruction_bundle.ciphertext),
      recipientSecret,
    );
    const plaintext = JSON.parse(new TextDecoder().decode(opened.plaintext));
    expect(new TextDecoder().decode(opened.associatedData)).toBe(aad);
    expect(plaintext.kind).toBe("ghola_private_execution_instruction");
    expect(plaintext.order.market).toBe("BTC-USD");
    expect(plaintext.order.limit_price).toBe("10000");
  });

  it("seals Hyperliquid live tiny-fill tickets without raw base or limit fields", async () => {
    const recipientSecret = x25519.utils.randomPrivateKey();
    const recipientPub = x25519.getPublicKey(recipientSecret);
    const senderSecret = ed25519.utils.randomPrivateKey();
    const senderPub = ed25519.getPublicKey(senderSecret);
    const ownerWalletAddress = bs58.encode(senderPub);
    const recipientId = "phala:cvm:hyperliquid-live";
    const runtime: PrivateAgentRuntimeStatus = {
      version: 1,
      checked_at: new Date("2026-05-28T00:00:00Z").toISOString(),
      sealed_execution_required: true,
      entitlement_required: "paid_private_agent_plan",
      preferred_provider: "phala",
      selected_provider: "phala",
      remote_execution_ready: true,
      shielded_rail_ready: true,
      blocking_reasons: [],
      disclosure: "test",
      providers: [{
        id: "phala",
        label: "Phala",
        configured: true,
        available: true,
        attested: true,
        supports_sealed_secrets: true,
        supports_background_agents: true,
        supports_trading_execution: true,
        reason: null,
        sealed_recipient: {
          recipient_id: recipientId,
          x25519_pub_hex: Buffer.from(recipientPub).toString("hex"),
        },
      }],
    };

    const built = await buildPrivateExecutionInstructionBundle({
      ownerWalletAddress,
      previewCommitment: "preview_commitment_hyperliquid_live",
      runtimeStatus: runtime,
      signBytes: async (bytes) => ed25519.sign(bytes, senderSecret),
      order: {
        venue_id: "hyperliquid",
        operation_class: "limit_order",
        market: "BTC",
        side: "buy",
        base_size: "",
        limit_price: "",
        quote_size: "5",
        max_slippage_bps: "50",
        live_order_mode: "tiny_fill",
        tif: "Ioc",
      },
      now: new Date("2026-05-28T00:00:00Z"),
    });

    expect(JSON.stringify(built.encrypted_execution_instruction_bundle)).not.toContain("quote_size");

    const opened = await open(
      base64ToBytes(built.encrypted_execution_instruction_bundle.ciphertext),
      recipientSecret,
    );
    const plaintext = JSON.parse(new TextDecoder().decode(opened.plaintext));
    expect(plaintext.order).toEqual({
      market: "BTC",
      side: "buy",
      quote_size: "5",
      max_slippage_bps: "50",
      live_order_mode: "tiny_fill",
      tif: "Ioc",
    });
  });

  it("seals Phoenix tiny-fill tickets with a price limit", async () => {
    const recipientSecret = x25519.utils.randomPrivateKey();
    const recipientPub = x25519.getPublicKey(recipientSecret);
    const senderSecret = ed25519.utils.randomPrivateKey();
    const senderPub = ed25519.getPublicKey(senderSecret);
    const ownerWalletAddress = bs58.encode(senderPub);
    const recipientId = "phala:cvm:phoenix-live";
    const runtime: PrivateAgentRuntimeStatus = {
      version: 1,
      checked_at: new Date("2026-05-28T00:00:00Z").toISOString(),
      sealed_execution_required: true,
      entitlement_required: "paid_private_agent_plan",
      preferred_provider: "phala",
      selected_provider: "phala",
      remote_execution_ready: true,
      shielded_rail_ready: true,
      blocking_reasons: [],
      disclosure: "test",
      providers: [{
        id: "phala",
        label: "Phala",
        configured: true,
        available: true,
        attested: true,
        supports_sealed_secrets: true,
        supports_background_agents: true,
        supports_trading_execution: true,
        reason: null,
        sealed_recipient: {
          recipient_id: recipientId,
          x25519_pub_hex: Buffer.from(recipientPub).toString("hex"),
        },
      }],
    };

    const built = await buildPrivateExecutionInstructionBundle({
      ownerWalletAddress,
      previewCommitment: "preview_commitment_phoenix_live",
      runtimeStatus: runtime,
      signBytes: async (bytes) => ed25519.sign(bytes, senderSecret),
      order: {
        venue_id: "phoenix",
        operation_class: "perp_limit_order",
        market: "SOL",
        side: "buy",
        base_size: "",
        limit_price: "250",
        quote_size: "5",
        live_order_mode: "tiny_fill",
        tif: "Ioc",
      },
      now: new Date("2026-05-28T00:00:00Z"),
    });

    expect(built.encrypted_execution_instruction_bundle.aad).toContain("venue:phoenix");
    expect(JSON.stringify(built.encrypted_execution_instruction_bundle)).not.toContain("250");

    const opened = await open(
      base64ToBytes(built.encrypted_execution_instruction_bundle.ciphertext),
      recipientSecret,
    );
    const plaintext = JSON.parse(new TextDecoder().decode(opened.plaintext));
    expect(plaintext.venue_id).toBe("phoenix");
    expect(plaintext.operation_class).toBe("perp_limit_order");
    expect(plaintext.order).toEqual({
      market: "SOL",
      side: "buy",
      quote_size: "5",
      limit_price: "250",
      live_order_mode: "tiny_fill",
      tif: "Ioc",
    });
  });

  it("seals agent mandate fields without exposing raw strategy details in the bundle", async () => {
    const recipientSecret = x25519.utils.randomPrivateKey();
    const recipientPub = x25519.getPublicKey(recipientSecret);
    const senderSecret = ed25519.utils.randomPrivateKey();
    const senderPub = ed25519.getPublicKey(senderSecret);
    const ownerWalletAddress = bs58.encode(senderPub);
    const recipientId = "phala:cvm:agent-mandate";

    const built = await buildPrivateExecutionInstructionBundle({
      ownerWalletAddress,
      previewCommitment: "preview_commitment_agent_mandate",
      runtimeStatus: runtimeWithRecipient(recipientId, recipientPub),
      signBytes: async (bytes) => ed25519.sign(bytes, senderSecret),
      order: {
        venue_id: "hyperliquid",
        operation_class: "limit_order",
        market: "BTC",
        side: "buy",
        base_size: "",
        limit_price: "",
        quote_size: "5",
        max_slippage_bps: "50",
        live_order_mode: "tiny_fill",
        tif: "Ioc",
        agent_strategy_profile: "breakout",
        agent_entry_trigger: "break_level",
        agent_trigger_level: "67250",
        agent_exit_rule: "exit_on_invalidation",
        agent_invalidation_level: "66900",
        agent_time_horizon: "session_trade",
        agent_route_priority: "most_private",
        agent_strategy_note: "Wait for breakout and reject if BTC loses the prior low.",
      },
      now: new Date("2026-05-28T00:00:00Z"),
    });

    const encryptedJson = JSON.stringify(built.encrypted_execution_instruction_bundle);
    expect(encryptedJson).not.toContain("breakout");
    expect(encryptedJson).not.toContain("67250");
    expect(encryptedJson).not.toContain("prior low");

    const opened = await open(
      base64ToBytes(built.encrypted_execution_instruction_bundle.ciphertext),
      recipientSecret,
    );
    const plaintext = JSON.parse(new TextDecoder().decode(opened.plaintext));
    expect(plaintext.mandate).toEqual({
      version: 1,
      strategy_profile: "breakout",
      entry_trigger: "break_level",
      exit_rule: "exit_on_invalidation",
      time_horizon: "session_trade",
      enforcement: "fail_closed_without_condition_proof",
      trigger_level: "67250",
      invalidation_level: "66900",
      route_priority: "most_private",
      strategy_note: "Wait for breakout and reject if BTC loses the prior low.",
    });
  });

  it("requires structured fields for conditional agent mandates", () => {
    const base = {
      venue_id: "hyperliquid" as const,
      operation_class: "limit_order" as const,
      market: "BTC",
      side: "buy" as const,
      base_size: "",
      limit_price: "",
      quote_size: "5",
      max_slippage_bps: "50",
      live_order_mode: "tiny_fill" as const,
      tif: "Ioc" as const,
    };

    expect(validatePrivateExecutionOrderDraft({
      ...base,
      agent_entry_trigger: "break_level",
    })).toContain("Enter the agent trigger level.");
    expect(validatePrivateExecutionOrderDraft({
      ...base,
      agent_strategy_profile: "funding_basis",
    })).toContain("Set the agent edge threshold between 1 and 500 bps.");
    expect(validatePrivateExecutionOrderDraft({
      ...base,
      agent_strategy_profile: "range_trade",
      agent_range_low: "100",
    })).toContain("Enter the range high.");
    expect(validatePrivateExecutionOrderDraft({
      ...base,
      agent_strategy_profile: "custom",
    })).toContain("Describe the custom agent rule.");
    expect(validatePrivateExecutionOrderDraft({
      ...base,
      agent_route_priority: "slowest" as never,
    })).toContain("Select a supported route priority.");
    expect(validatePrivateExecutionOrderDraft({
      ...base,
      agent_strategy_profile: "venue_route_edge",
    })).toContain("Set the agent edge threshold between 1 and 500 bps.");
    expect(validatePrivateExecutionOrderDraft({
      ...base,
      agent_exit_rule: "time_stop",
    })).toContain("Enter a short agent time window.");
  });
});
