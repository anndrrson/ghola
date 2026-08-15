import { x25519 } from "@noble/curves/ed25519";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "./envelope";
import { dispatchLiveTradingOrder } from "./live-trading-worker-dispatch.server";
import { createHyperliquidExecutionVault } from "./private-account";
import {
  putHyperliquidExecutionVault,
  resetPrivateAccountStoreForTests,
} from "./private-account-store";
import { expectedRecipientReportDataHex } from "./private-agent-phala";
import { brandPrivateAgentMockTransport } from "./private-agent-spend-policy";
import { buildTradeOrderPlan, type TradeOrderPlan } from "./trade-order-plan";

const OWNER = "owner_live_dispatch_test";
const ACCOUNT = "account_live_dispatch_test";
const SHA = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;

describe("sealed live-trading worker dispatch", () => {
  beforeEach(async () => resetPrivateAccountStoreForTests());
  afterEach(async () => {
    vi.restoreAllMocks();
    await resetPrivateAccountStoreForTests();
  });

  it("seals an exact isolated 1x IOC instruction and validates the worker proof", async () => {
    const fixture = await setupFixture();
    let submittedBody: Record<string, unknown> | null = null;
    const fetchMock = brandPrivateAgentMockTransport(vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/.well-known/private-agent-recipient")) {
        return Response.json(fixture.recipientMetadata);
      }
      submittedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const bundle = submittedBody.encrypted_execution_instruction_bundle as { ciphertext: string };
      const opened = await open(
        Uint8Array.from(Buffer.from(bundle.ciphertext, "base64")),
        fixture.recipientSecret,
      );
      const instruction = JSON.parse(new TextDecoder().decode(opened.plaintext));
      expect(instruction).toMatchObject({
        venue_id: "hyperliquid",
        operation_class: "limit_order",
        order: {
          market: "BTC",
          side: "buy",
          order_type: "limit",
          size_mode: "base",
          tif: "Ioc",
          margin_mode: "isolated",
          leverage: 1,
          reduce_only: false,
        },
      });
      expect(Date.parse(instruction.expires_at) - Date.now()).toBeGreaterThan(0);
      expect(Date.parse(instruction.expires_at) - Date.now()).toBeLessThanOrEqual(15_000);
      const body = submittedBody;
      return Response.json({
        version: 1,
        platform_class: "hyperliquid_style_market",
        execution_mode: "byo_api_key",
        status: "submitted",
        work_order_commitment: body.work_order_commitment,
        vault_commitment: fixture.vaultCommitment,
        result_commitment: "hyperliquid_result_commitment_test",
        final_proof: {
          venue_id: "hyperliquid",
          network: "mainnet",
          broadcast_performed: true,
          final_venue_execution_proven: true,
          execution_configuration_proven: true,
          margin_mode: "isolated",
          leverage: 1,
          market_data_freshness_proven: true,
          market_slippage_bound_proven: true,
          market_source_age_ms: 350,
          market_max_age_ms: 2_000,
          action_expiry_proven: true,
          expires_after_ms: Date.now() + 10_000,
        },
      }, { status: 202 });
    }));

    const response = await dispatchLiveTradingOrder({
      owner_commitment: OWNER,
      account_commitment: ACCOUNT,
      vault_commitment: fixture.vaultCommitment,
      idempotency_key: "idempotency_live_dispatch_test",
      plan_digest: `sha256:${"c".repeat(64)}`,
      order_plan: plan(),
      env: liveEnv(),
      fetchImpl: fetchMock,
    });
    const result = await response.json();

    expect(response.status).toBe(202);
    expect(result.appLiveTradingExecutionRun).toMatchObject({
      status: "submitted",
      gholaAppLiveTradingExecutionRunCommitment: "hyperliquid_result_commitment_test",
      liveTradingOrder: null,
    });
    expect(submittedBody).toMatchObject({
      owner_commitment: OWNER,
      account_commitment: ACCOUNT,
      vault_commitment: fixture.vaultCommitment,
      execution_mode: "byo_api_key",
      operation_class: "limit_order",
      session_policy: {
        max_notional_bucket: "100",
        max_daily_notional_bucket: "500",
        max_order_count: 1,
        execution_network: "mainnet",
      },
    });
    expect(JSON.stringify(submittedBody)).not.toContain("62500");
    expect(JSON.stringify(submittedBody)).not.toContain("0.0004");
  });

  it("seals venue-native OCO protection only when its canary capabilities are explicit", async () => {
    const fixture = await setupFixture();
    const protectedPlan = plan(63_500);
    const fetchMock = brandPrivateAgentMockTransport(vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/.well-known/private-agent-recipient")) {
        return Response.json(fixture.recipientMetadata);
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const bundle = body.encrypted_execution_instruction_bundle as { ciphertext: string };
      const opened = await open(Uint8Array.from(Buffer.from(bundle.ciphertext, "base64")), fixture.recipientSecret);
      const instruction = JSON.parse(new TextDecoder().decode(opened.plaintext));
      expect(instruction.position_protection).toEqual({
        mode: "normal_tpsl",
        trigger_source: "mark",
        take_profit_trigger_price: "63500",
        stop_loss_trigger_price: "62000",
        max_slippage_bps: "50",
      });
      return Response.json({
        version: 1,
        platform_class: "hyperliquid_style_market",
        execution_mode: "byo_api_key",
        status: "filled",
        work_order_commitment: body.work_order_commitment,
        vault_commitment: fixture.vaultCommitment,
        result_commitment: "hyperliquid_protected_result_test",
        final_proof: {
          venue_id: "hyperliquid",
          network: "mainnet",
          broadcast_performed: true,
          final_venue_execution_proven: true,
          execution_configuration_proven: true,
          margin_mode: "isolated",
          leverage: 1,
          market_data_freshness_proven: true,
          market_slippage_bound_proven: true,
          market_source_age_ms: 250,
          market_max_age_ms: 2_000,
          action_expiry_proven: true,
          expires_after_ms: Date.now() + 10_000,
          position_protection_proven: true,
          protection_grouping: "normalTpsl",
          protection_trigger_source: "mark",
          protection_trigger_order_type: "bounded_limit",
          protection_max_slippage_bps: 50,
        },
      });
    }));
    const env = {
      ...liveEnv(),
      GHOLA_LIVE_TRADING_POSITION_PROTECTION_ENABLED: "true",
      GHOLA_LIVE_TRADING_PUBLIC_CAPABILITIES: "limit_order,stop_loss,take_profit",
    };

    const response = await dispatchLiveTradingOrder({
      owner_commitment: OWNER,
      account_commitment: ACCOUNT,
      vault_commitment: fixture.vaultCommitment,
      idempotency_key: "idempotency_live_dispatch_protected",
      plan_digest: `sha256:${"d".repeat(64)}`,
      order_plan: protectedPlan,
      env,
      fetchImpl: fetchMock,
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      appLiveTradingExecutionRun: {
        status: "submitted",
        gholaAppLiveTradingExecutionRunCommitment: "hyperliquid_protected_result_test",
      },
    });
  });

  it("keeps venue-native protection closed without its canary flag", async () => {
    const fixture = await setupFixture();
    const fetchMock = brandPrivateAgentMockTransport(vi.fn<typeof fetch>());
    const response = await dispatchLiveTradingOrder({
      owner_commitment: OWNER,
      account_commitment: ACCOUNT,
      vault_commitment: fixture.vaultCommitment,
      idempotency_key: "idempotency_live_dispatch_protected_closed",
      plan_digest: `sha256:${"d".repeat(64)}`,
      order_plan: plan(63_500),
      env: liveEnv(),
      fetchImpl: fetchMock,
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "live_position_protection_canary_required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects recipient image drift before sending an order", async () => {
    const fixture = await setupFixture();
    const fetchMock = brandPrivateAgentMockTransport(vi.fn<typeof fetch>(async () => Response.json({
      ...fixture.recipientMetadata,
      image_digest: `sha256:${"d".repeat(64)}`,
    })));

    const response = await dispatchLiveTradingOrder({
      owner_commitment: OWNER,
      account_commitment: ACCOUNT,
      vault_commitment: fixture.vaultCommitment,
      idempotency_key: "idempotency_live_dispatch_drift",
      plan_digest: `sha256:${"c".repeat(64)}`,
      order_plan: plan(),
      env: liveEnv(),
      fetchImpl: fetchMock,
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "live_worker_recipient_attestation_invalid" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("reconciles an ambiguous submit by exact work order without rebroadcast", async () => {
    const fixture = await setupFixture();
    let orderCalls = 0;
    let reconcileCalls = 0;
    let workOrderCommitment = "";
    const fetchMock = brandPrivateAgentMockTransport(vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/.well-known/private-agent-recipient")) {
        return Response.json(fixture.recipientMetadata);
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (url.endsWith("/hyperliquid/orders")) {
        orderCalls += 1;
        workOrderCommitment = String(body.work_order_commitment);
        throw new Error("transport closed after venue broadcast");
      }
      reconcileCalls += 1;
      expect(url).toMatch(/\/hyperliquid\/reconcile$/u);
      expect(body).toMatchObject({
        operation_class: "reconcile",
        market: "BTC",
        work_order_commitment: workOrderCommitment,
      });
      return Response.json({
        version: 1,
        platform_class: "hyperliquid_style_market",
        execution_mode: "byo_api_key",
        status: "filled",
        work_order_commitment: workOrderCommitment,
        vault_commitment: fixture.vaultCommitment,
        result_commitment: "hyperliquid_reconciled_result_test",
        fill_summary: { fill_count: 1 },
        final_proof: {
          proof_kind: "hyperliquid_execution_proof_v1",
          venue_id: "hyperliquid",
          network: "mainnet",
          broadcast_performed: true,
          final_venue_execution_proven: true,
          final_fill_proven: true,
          final_no_fill_proven: false,
          terminal_status: "filled",
        },
      });
    }));

    const response = await dispatchLiveTradingOrder({
      owner_commitment: OWNER,
      account_commitment: ACCOUNT,
      vault_commitment: fixture.vaultCommitment,
      idempotency_key: "idempotency_live_dispatch_reconcile",
      plan_digest: `sha256:${"e".repeat(64)}`,
      order_plan: plan(),
      env: liveEnv(),
      fetchImpl: fetchMock,
      waitImpl: async () => undefined,
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      appLiveTradingExecutionRun: {
        status: "reconciled",
        gholaAppLiveTradingExecutionRunCommitment: "hyperliquid_reconciled_result_test",
        workerWorkOrderCommitment: workOrderCommitment,
      },
    });
    expect(orderCalls).toBe(1);
    expect(reconcileCalls).toBe(1);
  });

  it("returns a terminal no-fill reconciliation without retrying the order", async () => {
    const fixture = await setupFixture();
    let orderCalls = 0;
    let workOrderCommitment = "";
    const fetchMock = brandPrivateAgentMockTransport(vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/.well-known/private-agent-recipient")) {
        return Response.json(fixture.recipientMetadata);
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (url.endsWith("/hyperliquid/orders")) {
        orderCalls += 1;
        workOrderCommitment = String(body.work_order_commitment);
        return Response.json({
          error: "execution claim is unresolved; reconciliation required",
          error_code: "EXECUTION_CLAIM_RECONCILE_REQUIRED",
        }, { status: 409 });
      }
      return Response.json({
        version: 1,
        platform_class: "hyperliquid_style_market",
        execution_mode: "byo_api_key",
        status: "rejected",
        work_order_commitment: workOrderCommitment,
        vault_commitment: fixture.vaultCommitment,
        result_commitment: "hyperliquid_reconciled_no_fill_test",
        fill_summary: { fill_count: 0 },
        final_proof: {
          proof_kind: "hyperliquid_execution_proof_v1",
          venue_id: "hyperliquid",
          network: "mainnet",
          broadcast_performed: true,
          final_venue_execution_proven: true,
          final_fill_proven: false,
          final_no_fill_proven: true,
          terminal_status: "iocCancelRejected",
        },
      });
    }));

    const response = await dispatchLiveTradingOrder({
      owner_commitment: OWNER,
      account_commitment: ACCOUNT,
      vault_commitment: fixture.vaultCommitment,
      idempotency_key: "idempotency_live_dispatch_no_fill",
      plan_digest: `sha256:${"f".repeat(64)}`,
      order_plan: plan(),
      env: liveEnv(),
      fetchImpl: fetchMock,
      waitImpl: async () => undefined,
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "live_order_reconciled_no_fill",
      workerWorkOrderCommitment: workOrderCommitment,
    });
    expect(orderCalls).toBe(1);
  });
});

async function setupFixture() {
  const recipientSecret = x25519.utils.randomPrivateKey();
  const x25519PubHex = Buffer.from(x25519.getPublicKey(recipientSecret)).toString("hex");
  const recipientId = "phala:cvm:live-dispatch-test";
  const fundingSigner = Buffer.alloc(44, 7).toString("base64");
  const created = createHyperliquidExecutionVault({
    account_commitment: ACCOUNT,
    encrypted_execution_vault: {
      ciphertext: "sealed-vault-ciphertext-test",
      recipient: recipientId,
      aad: `ghola/hyperliquid-execution-vault-v1|account:${ACCOUNT}|recipient:${recipientId}|network:mainnet`,
    },
  });
  if (!created.ok) throw new Error(created.error);
  await putHyperliquidExecutionVault({
    version: 1,
    owner_commitment: OWNER,
    account_commitment: ACCOUNT,
    vault_commitment: created.vault.vault_commitment,
    encrypted_vault_commitment: created.vault.encrypted_vault_commitment,
    recipient_commitment: created.vault.recipient_commitment,
    policy_commitment: created.vault.policy_commitment,
    status: "sealed",
    vault: created.vault,
    created_at: created.vault.created_at,
    updated_at: created.vault.updated_at,
  });
  return {
    recipientSecret,
    vaultCommitment: created.vault.vault_commitment,
    recipientMetadata: {
      recipient_id: recipientId,
      x25519_pub_hex: x25519PubHex,
      funding_signer_public_key_b64: fundingSigner,
      image_digest: DIGEST,
      report_data_hex: expectedRecipientReportDataHex({
        recipientId,
        x25519PubHex,
        fundingSignerPublicKeyB64: fundingSigner,
      }),
      attested_ready: true,
    },
  };
}

function liveEnv(): Record<string, string | undefined> {
  return {
    NODE_ENV: "production",
    VERCEL_ENV: "production",
    GHOLA_PRIVATE_AGENT_SPEND_ARMED: "true",
    GHOLA_PRIVATE_AGENT_REMOTE_EXECUTION_DISABLED: "false",
    GHOLA_PRIVATE_AGENT_SPEND_LOCKDOWN: "false",
    GHOLA_LIVE_TRADING_PUBLIC_ENABLED: "true",
    GHOLA_LIVE_TRADING_PUBLIC_CAPABILITIES: "limit_order",
    GHOLA_LIVE_TRADING_MAX_ORDER_NOTIONAL_USD: "100",
    GHOLA_LIVE_TRADING_DAILY_CAP_USD: "500",
    GHOLA_LIVE_TRADING_MAX_SLIPPAGE_BPS: "100",
    GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET: "secure_private_account_request_proof_secret_value",
    GHOLA_V6_HYPERLIQUID_PILOT_ENABLED: "true",
    PRIVATE_AGENT_VENUE_DRY_RUN: "false",
    PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET: "true",
    PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE: "full_ticket",
    PRIVATE_AGENT_HYPERLIQUID_MAINNET_PROOF_ENABLED: "true",
    PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD: "100",
    PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD: "500",
    PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS: "100",
    PRIVATE_AGENT_LIVE_MAX_ORDER_NOTIONAL_USD: "100",
    PRIVATE_AGENT_LIVE_DAILY_NOTIONAL_CAP_USD: "500",
    PRIVATE_AGENT_STATE_STORE: "postgres",
    PRIVATE_AGENT_REQUIRE_DSTACK_QUOTE: "true",
    PRIVATE_AGENT_REQUIRE_WORKER_CAPABILITY: "true",
    PRIVATE_AGENT_GLOBAL_KILL_SWITCH: "false",
    GHOLA_WEB_GIT_SHA: SHA,
    GHOLA_PRIVATE_AGENT_WORKER_GIT_SHA: SHA,
    GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST: DIGEST,
    GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64: Buffer.alloc(44, 7).toString("base64"),
    GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.ghola.test",
    PRIVATE_AGENT_WORKER_CAPABILITY_SECRET: "worker-capability-secret-value-123456789",
  };
}

function plan(takeProfitLevel?: number): TradeOrderPlan {
  const nowMs = Date.now();
  const built = buildTradeOrderPlan({
    venueId: "hyperliquid",
    network: "mainnet",
    coin: "BTC",
    product: "BTC-PERP",
    side: "buy",
    timeInForce: "ioc",
    quoteNotionalUsd: 25,
    baseSize: 0.0004,
    limitPrice: 62_500,
    maxSlippageBps: 50,
    stopLevel: 62_000,
    takeProfitLevel,
    strategyProfile: "breakout",
    entryTrigger: "break_level",
    exitRule: "exit_on_invalidation",
    timeHorizon: "intraday",
    triggerLevel: 62_550,
    interval: "5m",
    marketFetchedAt: new Date(nowMs).toISOString(),
    executionReferencePrice: 62_490,
    frameVersion: 1,
    riskEnvelope: {
      riskBudgetUsd: 1,
      stopAndSlippageLossUsd: 0.325,
      roundTripCostLossUsd: 0.05,
      allInLossUsd: 0.375,
      feeBps: 5,
      bufferBps: 5,
      feeEvidenceAtMs: nowMs,
      bufferEvidenceAtMs: nowMs,
    },
    nowMs,
  });
  if (!built) throw new Error("test_plan_invalid");
  return built;
}
