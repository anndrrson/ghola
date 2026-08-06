import { describe, expect, it, vi } from "vitest";
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
    bounded_beta_enabled: true,
    operator_spend_lock: false,
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
  it("fails visibly when the account signer never resolves", async () => {
    vi.useFakeTimers();
    try {
      const recipientPub = x25519.getPublicKey(x25519.utils.randomPrivateKey());
      const senderPub = ed25519.getPublicKey(ed25519.utils.randomPrivateKey());
      const pending = buildPrivateExecutionInstructionBundle({
        ownerWalletAddress: bs58.encode(senderPub),
        previewCommitment: "preview_signer_timeout",
        runtimeStatus: runtimeWithRecipient("phala:cvm:signer-timeout", recipientPub),
        signBytes: async () => new Promise<Uint8Array>(() => undefined),
        order: {
          venue_id: "hyperliquid",
          operation_class: "limit_order",
          market: "SOL",
          side: "buy",
          base_size: "",
          limit_price: "",
          quote_size: "1",
          max_slippage_bps: "25",
          live_order_mode: "tiny_fill",
          order_type: "market",
          size_mode: "quote",
          tif: "Ioc",
        },
      });

      const rejection = expect(pending).rejects.toThrow("Secure signing timed out");
      await vi.advanceTimersByTimeAsync(20_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

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
      bounded_beta_enabled: true,
      operator_spend_lock: false,
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
      bounded_beta_enabled: true,
      operator_spend_lock: false,
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

  it("preserves an exact reduce-only close inside the sealed tiny-fill ticket", async () => {
    const recipientSecret = x25519.utils.randomPrivateKey();
    const recipientPub = x25519.getPublicKey(recipientSecret);
    const senderSecret = ed25519.utils.randomPrivateKey();
    const ownerWalletAddress = bs58.encode(ed25519.getPublicKey(senderSecret));
    const built = await buildPrivateExecutionInstructionBundle({
      ownerWalletAddress,
      previewCommitment: "preview_exact_hyperliquid_close",
      runtimeStatus: runtimeWithRecipient("phala:cvm:exact-close", recipientPub),
      signBytes: async (bytes) => ed25519.sign(bytes, senderSecret),
      order: {
        venue_id: "hyperliquid",
        operation_class: "limit_order",
        market: "BTC",
        side: "sell",
        base_size: "",
        limit_price: "",
        quote_size: "",
        max_slippage_bps: "50",
        live_order_mode: "tiny_fill",
        order_type: "market",
        size_mode: "quote",
        tif: "Ioc",
        reduce_only: true,
        close_position: true,
      },
    });
    const opened = await open(
      base64ToBytes(built.encrypted_execution_instruction_bundle.ciphertext),
      recipientSecret,
    );
    const plaintext = JSON.parse(new TextDecoder().decode(opened.plaintext));
    expect(plaintext.order).toMatchObject({
      market: "BTC",
      side: "sell",
      reduce_only: true,
      close_position: true,
      live_order_mode: "tiny_fill",
      tif: "Ioc",
    });
    expect(plaintext.order).not.toHaveProperty("quote_size");
  });

  it("seals a full Hyperliquid bracket with leverage and isolated margin", async () => {
    const recipientSecret = x25519.utils.randomPrivateKey();
    const recipientPub = x25519.getPublicKey(recipientSecret);
    const senderSecret = ed25519.utils.randomPrivateKey();
    const ownerWalletAddress = bs58.encode(ed25519.getPublicKey(senderSecret));
    const built = await buildPrivateExecutionInstructionBundle({
      ownerWalletAddress,
      previewCommitment: "preview_full_ticket",
      runtimeStatus: runtimeWithRecipient("phala:cvm:full-ticket", recipientPub),
      signBytes: async (bytes) => ed25519.sign(bytes, senderSecret),
      order: {
        venue_id: "hyperliquid",
        operation_class: "limit_order",
        market: "SOL",
        side: "buy",
        base_size: "",
        quote_size: "25",
        size_mode: "quote",
        limit_price: "150",
        order_type: "limit",
        tif: "Gtc",
        leverage: 5,
        margin_mode: "isolated",
        protective_orders: { stop_loss: "145", take_profit: "165" },
      },
    });
    const opened = await open(base64ToBytes(built.encrypted_execution_instruction_bundle.ciphertext), recipientSecret);
    const plaintext = JSON.parse(new TextDecoder().decode(opened.plaintext));
    expect(plaintext.order).toMatchObject({
      market: "SOL",
      quote_size: "25",
      leverage: 5,
      margin_mode: "isolated",
      protective_orders: { stop_loss: "145", take_profit: "165" },
    });
    expect(JSON.stringify(built.encrypted_execution_instruction_bundle)).not.toContain("165");
  });

  it("rejects invalid leverage and reduce-only brackets before sealing", () => {
    const base = {
      venue_id: "hyperliquid" as const,
      operation_class: "limit_order" as const,
      market: "BTC",
      side: "sell" as const,
      base_size: "",
      quote_size: "25",
      size_mode: "quote" as const,
      limit_price: "70000",
      order_type: "limit" as const,
      tif: "Gtc" as const,
    };
    expect(validatePrivateExecutionOrderDraft({ ...base, leverage: 0 })).toContain("Select a valid whole-number leverage.");
    expect(validatePrivateExecutionOrderDraft({
      ...base,
      leverage: 2,
      reduce_only: true,
      protective_orders: { stop_loss: "71000" },
    })).toContain("Reduce-only orders cannot attach a new TP/SL bracket.");
    expect(validatePrivateExecutionOrderDraft({
      ...base,
      close_position: true,
    })).toContain("Exact position close requires a reduce-only Hyperliquid order.");
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
      bounded_beta_enabled: true,
      operator_spend_lock: false,
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
