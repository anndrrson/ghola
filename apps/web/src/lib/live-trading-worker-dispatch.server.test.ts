import { x25519 } from "@noble/curves/ed25519";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "./envelope";
import {
  dispatchLiveTradingOrder as dispatchLiveTradingOrderImpl,
  LIVE_TRADING_DISPATCH_DISPOSITION_HEADER,
  reconcileLiveTradingWorkOrder,
} from "./live-trading-worker-dispatch.server";
import {
  getLiveTradingLaunchControl,
  LIVE_TRADING_DISPATCH_ABSENCE_GRACE_MS,
  putLiveTradingLaunchControl,
  putLiveTradingWorkOrderReconciliation,
  resetLiveTradingStoreForTests,
  transitionLiveTradingLaunchControl,
} from "./live-trading-store";
import { canonicalLiveTradingCaps } from "./live-trading-contract";
import { currentLiveTradingReleaseIdentity } from "./live-trading-release.server";
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
const CLOID = `0x${"1".repeat(32)}`;
let launchRevision = 0;

describe("sealed live-trading worker dispatch", () => {
  beforeEach(async () => {
    resetLiveTradingStoreForTests();
    await resetPrivateAccountStoreForTests();
    const release = currentLiveTradingReleaseIdentity(liveEnv());
    const now = new Date().toISOString();
    const launch = await putLiveTradingLaunchControl({
      version: 2,
      state: "public",
      contract_version: 2,
      web_git_sha: release.web_git_sha,
      worker_git_sha: release.worker_git_sha,
      worker_image_digest: release.worker_image_digest,
      config_fingerprint: release.config_fingerprint,
      public_capabilities: ["limit_order", "cancel", "reduce_only", "stop_loss", "take_profit"],
      caps: canonicalLiveTradingCaps(),
      evidence_commitment: "dispatch_test_launch_evidence",
      updated_by: "test",
      created_at: now,
      updated_at: now,
    });
    launchRevision = launch.revision;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    resetLiveTradingStoreForTests();
    await resetPrivateAccountStoreForTests();
  });

  it("seals an exact isolated 1x IOC instruction and validates the worker proof", async () => {
    const fixture = await setupFixture();
    const planDigest = `sha256:${"c".repeat(64)}`;
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
        status: "filled",
        work_order_commitment: body.work_order_commitment,
        vault_commitment: fixture.vaultCommitment,
        result_commitment: "hyperliquid_result_commitment_test",
        fill_summary: {
          fill_count: 1,
          filled_base_size: "0.0004",
          average_fill_price: 62500,
          fee_usd: 0.005,
          fee_status: "reported",
        },
        final_proof: {
          ...protectionProof(),
          proof_kind: "hyperliquid_execution_proof_v1",
          status: "filled",
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
          final_fill_proven: true,
          venue_order_readback_proven: true,
          venue_order_status: "filled",
          venue_order_oid: "518475952911",
          venue_order_cloid: CLOID,
        },
      }, { status: 202 });
    }));

    const response = await dispatchLiveTradingOrder({
      owner_commitment: OWNER,
      account_commitment: ACCOUNT,
      vault_commitment: fixture.vaultCommitment,
      idempotency_key: "idempotency_live_dispatch_test",
      plan_digest: planDigest,
      order_plan: plan(),
      env: liveEnv(),
      fetchImpl: fetchMock,
    });
    const result = await response.json();
    expect(response.status).toBe(202);
    expect(result.appLiveTradingExecutionRun).toMatchObject({
      status: "reconciled",
      gholaAppLiveTradingExecutionRunCommitment: "hyperliquid_result_commitment_test",
      liveTradingOrder: {
        orderId: "hyperliquid:518475952911",
        venueProvenFill: {
          filledBaseSize: "0.0004",
          averageFillPrice: "62500",
          feeUsd: "0.005",
          protection: { status: "proven", maxSlippageBps: 50 },
        },
      },
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

    const replay = await reconcileLiveTradingWorkOrder({
      owner_commitment: OWNER,
      plan_digest: planDigest,
      env: liveEnv(),
      fetchImpl: fetchMock,
    });
    expect(await replay.json()).toMatchObject({
      appLiveTradingExecutionRun: {
        liveTradingOrder: {
          venueProvenFill: { filledBaseSize: "0.0004", feeUsd: "0.005" },
        },
      },
    });
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
        fill_summary: {
          fill_count: 1,
          filled_base_size: "0.0004",
          average_fill_price: 62500,
          fee_usd: 0.005,
          fee_status: "reported",
        },
        final_proof: {
          proof_kind: "hyperliquid_execution_proof_v1",
          status: "filled",
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
          final_fill_proven: true,
          venue_order_readback_proven: true,
          venue_order_status: "filled",
          venue_order_oid: "518475952912",
          venue_order_cloid: CLOID,
        },
      });
    }));
    const env = {
      ...liveEnv(),
      GHOLA_LIVE_TRADING_POSITION_PROTECTION_ENABLED: "true",
      GHOLA_LIVE_TRADING_PUBLIC_CAPABILITIES: "limit_order,cancel,reduce_only,stop_loss,take_profit",
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
        status: "reconciled",
        gholaAppLiveTradingExecutionRunCommitment: "hyperliquid_protected_result_test",
        liveTradingOrder: {
          orderId: "hyperliquid:518475952912",
          venueProvenFill: {
            protection: { status: "proven", maxSlippageBps: 50 },
          },
        },
      },
    });
  });

  it.each([
    ["cross-account AAD", "account_other", "mainnet"],
    ["testnet AAD", ACCOUNT, "testnet"],
  ] as const)("rejects %s before contacting the worker", async (_label, aadAccount, network) => {
    const fixture = await setupFixture({ aadAccount, network });
    const fetchMock = brandPrivateAgentMockTransport(vi.fn<typeof fetch>());
    const response = await dispatchLiveTradingOrder({
      owner_commitment: OWNER,
      account_commitment: ACCOUNT,
      vault_commitment: fixture.vaultCommitment,
      idempotency_key: "idempotency_live_dispatch_scope_rejection",
      plan_digest: `sha256:${"a".repeat(64)}`,
      order_plan: plan(),
      env: liveEnv(),
      fetchImpl: fetchMock,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "hyperliquid_mainnet_vault_required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a claimed fill without an exact venue order reference", async () => {
    const fixture = await setupFixture();
    const fetchMock = brandPrivateAgentMockTransport(vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith("/.well-known/private-agent-recipient")) {
        return Response.json(fixture.recipientMetadata);
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        version: 1,
        platform_class: "hyperliquid_style_market",
        execution_mode: "byo_api_key",
        status: "filled",
        work_order_commitment: body.work_order_commitment,
        vault_commitment: fixture.vaultCommitment,
        result_commitment: "hyperliquid_missing_order_result_test",
        fill_summary: { fill_count: 1 },
        final_proof: {
          proof_kind: "hyperliquid_execution_proof_v1",
          status: "filled",
          venue_id: "hyperliquid",
          network: "mainnet",
          broadcast_performed: true,
          final_venue_execution_proven: true,
          final_fill_proven: true,
          execution_configuration_proven: true,
          margin_mode: "isolated",
          leverage: 1,
          market_data_freshness_proven: true,
          market_slippage_bound_proven: true,
          market_source_age_ms: 250,
          market_max_age_ms: 2_000,
          action_expiry_proven: true,
          expires_after_ms: Date.now() + 10_000,
          venue_order_readback_proven: true,
          venue_order_status: "filled",
          venue_order_cloid: CLOID,
        },
      });
    }));

    const response = await dispatchLiveTradingOrder({
      owner_commitment: OWNER,
      account_commitment: ACCOUNT,
      vault_commitment: fixture.vaultCommitment,
      idempotency_key: "idempotency_missing_venue_order",
      plan_digest: `sha256:${"2".repeat(64)}`,
      order_plan: plan(),
      env: liveEnv(),
      fetchImpl: fetchMock,
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "live_worker_receipt_invalid" });
  });

  it("reconciles an accepted nonterminal IOC without rebroadcasting it", async () => {
    const fixture = await setupFixture();
    let orderCalls = 0;
    let reconcileCalls = 0;
    const reconcileAuthorizations: string[] = [];
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
          version: 1,
          platform_class: "hyperliquid_style_market",
          execution_mode: "byo_api_key",
          status: "submitted",
          work_order_commitment: workOrderCommitment,
          vault_commitment: fixture.vaultCommitment,
          result_commitment: "hyperliquid_submitted_result_test",
          fill_summary: { fill_count: 0 },
          final_proof: {
            ...protectionProof(),
            proof_kind: "hyperliquid_execution_proof_v1",
            venue_id: "hyperliquid",
            network: "mainnet",
            broadcast_performed: true,
            final_venue_execution_proven: true,
            final_fill_proven: false,
            execution_configuration_proven: true,
            margin_mode: "isolated",
            leverage: 1,
            market_data_freshness_proven: true,
            market_slippage_bound_proven: true,
            market_source_age_ms: 300,
            market_max_age_ms: 2_000,
            action_expiry_proven: true,
            expires_after_ms: Date.now() + 10_000,
            venue_order_readback_proven: true,
            venue_order_status: "open",
            venue_order_oid: "518475952913",
          },
        }, { status: 202 });
      }
      reconcileCalls += 1;
      reconcileAuthorizations.push(new Headers(init?.headers).get("authorization") ?? "");
      expect(body.operation_class).toBe("reconcile");
      if (reconcileCalls === 1) {
        return Response.json({ status: "submitted" });
      }
      return Response.json({
        version: 1,
        platform_class: "hyperliquid_style_market",
        execution_mode: "byo_api_key",
        status: "filled",
        work_order_commitment: workOrderCommitment,
        vault_commitment: fixture.vaultCommitment,
        result_commitment: "hyperliquid_reconciled_submitted_test",
        fill_summary: { fill_count: 1 },
        final_proof: {
          ...protectionProof(),
          proof_kind: "hyperliquid_execution_proof_v1",
          status: "filled",
          venue_id: "hyperliquid",
          network: "mainnet",
          broadcast_performed: true,
          final_venue_execution_proven: true,
          final_fill_proven: true,
          final_no_fill_proven: false,
          terminal_status: "filled",
          venue_order_oid: "518475952913",
          venue_order_cloid: CLOID,
          venue_order_original_size: "0.1",
          venue_order_remaining_size: "0",
          venue_order_filled_size: "0.1",
          venue_order_readback_proven: true,
          venue_order_status: "filled",
        },
      });
    }));

    const response = await dispatchLiveTradingOrder({
      owner_commitment: OWNER,
      account_commitment: ACCOUNT,
      vault_commitment: fixture.vaultCommitment,
      idempotency_key: "idempotency_live_dispatch_submitted_reconcile",
      plan_digest: `sha256:${"1".repeat(64)}`,
      order_plan: plan(),
      env: liveEnv(),
      fetchImpl: fetchMock,
      waitImpl: async () => undefined,
    });

    expect(response.status).toBe(202);
    const result = await response.json();
    expect(result).toMatchObject({
      appLiveTradingExecutionRun: {
        status: "reconciled",
        liveTradingOrder: { orderId: "hyperliquid:518475952913" },
        workerWorkOrderCommitment: workOrderCommitment,
      },
    });
    expect(result.appLiveTradingExecutionRun.liveTradingOrder).not.toHaveProperty("venueProvenFill");
    expect(orderCalls).toBe(1);
    expect(reconcileCalls).toBe(2);
    expect(reconcileAuthorizations).toHaveLength(2);
    expect(reconcileAuthorizations[0]).not.toBe(reconcileAuthorizations[1]);
  });

  it("fails the release closed without its required protection flag", async () => {
    const fixture = await setupFixture();
    const fetchMock = brandPrivateAgentMockTransport(vi.fn<typeof fetch>());
    const response = await dispatchLiveTradingOrder({
      owner_commitment: OWNER,
      account_commitment: ACCOUNT,
      vault_commitment: fixture.vaultCommitment,
      idempotency_key: "idempotency_live_dispatch_protected_closed",
      plan_digest: `sha256:${"d".repeat(64)}`,
      order_plan: plan(63_500),
      env: { ...liveEnv(), GHOLA_LIVE_TRADING_POSITION_PROTECTION_ENABLED: "false" },
      fetchImpl: fetchMock,
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "live_release_identity_invalid" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks a stale opening authorization after kill before any worker HTTP", async () => {
    const fixture = await setupFixture();
    const authorizedRevision = launchRevision;
    await transitionLiveTradingLaunchControl({
      kind: "kill",
      updated_by: "emergency-test",
      updated_at: new Date().toISOString(),
      evidence_commitment: "dispatch_test_kill_evidence",
    });
    expect((await getLiveTradingLaunchControl()).state).toBe("killed");
    const fetchMock = brandPrivateAgentMockTransport(vi.fn<typeof fetch>());

    const response = await dispatchLiveTradingOrder({
      owner_commitment: OWNER,
      account_commitment: ACCOUNT,
      vault_commitment: fixture.vaultCommitment,
      idempotency_key: "idempotency_stale_launch_authorization",
      plan_digest: `sha256:${"9".repeat(64)}`,
      order_plan: plan(),
      expected_launch_revision: authorizedRevision,
      env: liveEnv(),
      fetchImpl: fetchMock,
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "live_trading_killed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rechecks kill after durable recovery persistence and never posts the order", async () => {
    const fixture = await setupFixture();
    const fetchMock = brandPrivateAgentMockTransport(vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith("/.well-known/private-agent-recipient")) {
        return Response.json(fixture.recipientMetadata);
      }
      throw new Error("order_post_must_not_run");
    }));
    let persisted = false;

    const response = await dispatchLiveTradingOrder({
      owner_commitment: OWNER,
      account_commitment: ACCOUNT,
      vault_commitment: fixture.vaultCommitment,
      idempotency_key: "idempotency_kill_after_recovery_persist",
      plan_digest: `sha256:${"8".repeat(64)}`,
      order_plan: plan(),
      expected_launch_revision: launchRevision,
      env: liveEnv(),
      fetchImpl: fetchMock,
      persistWorkOrderReconciliationImpl: async (record) => {
        const result = await putLiveTradingWorkOrderReconciliation(record);
        persisted = result;
        await transitionLiveTradingLaunchControl({
          kind: "kill",
          updated_by: "late-emergency-test",
          updated_at: new Date().toISOString(),
          evidence_commitment: "dispatch_late_kill_evidence",
        });
        return result;
      },
    });

    expect(persisted).toBe(true);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "live_trading_killed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/hyperliquid/orders"))).toBe(false);
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
          ...protectionProof(),
          proof_kind: "hyperliquid_execution_proof_v1",
          status: "filled",
          venue_id: "hyperliquid",
          network: "mainnet",
          broadcast_performed: true,
          final_venue_execution_proven: true,
          final_fill_proven: true,
          final_no_fill_proven: false,
          terminal_status: "filled",
          venue_order_readback_proven: true,
          venue_order_status: "filled",
          venue_order_oid: "518475952914",
          venue_order_cloid: CLOID,
          venue_order_original_size: "0.1",
          venue_order_remaining_size: "0",
          venue_order_filled_size: "0.1",
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

  it("treats a worker 422 venue rejection as post-broadcast ambiguous until reconciliation", async () => {
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
        return Response.json({
          error: "hyperliquid parent order readback is unconfirmed",
          error_code: "venue_rejected",
        }, { status: 422 });
      }
      reconcileCalls += 1;
      expect(url).toMatch(/\/hyperliquid\/reconcile$/u);
      return Response.json({
        version: 1,
        platform_class: "hyperliquid_style_market",
        execution_mode: "byo_api_key",
        status: "filled",
        work_order_commitment: workOrderCommitment,
        vault_commitment: fixture.vaultCommitment,
        result_commitment: "hyperliquid_422_reconciled_result_test",
        fill_summary: { fill_count: 1 },
        final_proof: {
          ...protectionProof(),
          proof_kind: "hyperliquid_execution_proof_v1",
          status: "filled",
          venue_id: "hyperliquid",
          network: "mainnet",
          broadcast_performed: true,
          final_venue_execution_proven: true,
          final_fill_proven: true,
          final_no_fill_proven: false,
          terminal_status: "filled",
          venue_order_readback_proven: true,
          venue_order_status: "filled",
          venue_order_oid: "518475952919",
          venue_order_cloid: CLOID,
          venue_order_original_size: "0.1",
          venue_order_remaining_size: "0",
          venue_order_filled_size: "0.1",
        },
      });
    }));

    const response = await dispatchLiveTradingOrder({
      owner_commitment: OWNER,
      account_commitment: ACCOUNT,
      vault_commitment: fixture.vaultCommitment,
      idempotency_key: "idempotency_live_dispatch_422",
      plan_digest: `sha256:${"9".repeat(64)}`,
      order_plan: plan(),
      env: liveEnv(),
      fetchImpl: fetchMock,
      waitImpl: async () => undefined,
    });

    expect(response.status).toBe(202);
    expect(response.headers.get(LIVE_TRADING_DISPATCH_DISPOSITION_HEADER)).toBe("filled");
    expect(await response.json()).toMatchObject({
      appLiveTradingExecutionRun: {
        status: "reconciled",
        liveTradingOrder: { orderId: "hyperliquid:518475952919" },
      },
    });
    expect(orderCalls).toBe(1);
    expect(reconcileCalls).toBe(1);
  });

  it("returns a terminal no-fill reconciliation without retrying the order", async () => {
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
        return Response.json({
          error: "execution claim is unresolved; reconciliation required",
          error_code: "EXECUTION_CLAIM_RECONCILE_REQUIRED",
        }, { status: 409 });
      }
      reconcileCalls += 1;
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
          status: "iocCancelRejected",
          venue_id: "hyperliquid",
          network: "mainnet",
          broadcast_performed: true,
          final_venue_execution_proven: true,
          final_fill_proven: false,
          final_no_fill_proven: true,
          terminal_status: "iocCancelRejected",
          venue_order_readback_proven: true,
          venue_order_status: "iocCancelRejected",
          venue_order_oid: "518475952915",
          venue_order_cloid: CLOID,
          venue_order_original_size: "0.1",
          venue_order_remaining_size: reconcileCalls === 1 ? "0" : "0.1",
          venue_order_filled_size: "0",
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

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      appLiveTradingExecutionRun: {
        status: "no_fill",
        liveTradingOrder: { orderId: "hyperliquid:518475952915" },
        workerWorkOrderCommitment: workOrderCommitment,
      },
    });
    expect(orderCalls).toBe(1);
    expect(reconcileCalls).toBe(2);
  });

  it("returns a terminal no-broadcast receipt for a worker pre-submit rejection", async () => {
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
        return Response.json({ error: "execution instruction is expired" }, { status: 409 });
      }
      return Response.json({
        version: 1,
        platform_class: "hyperliquid_style_market",
        execution_mode: "byo_api_key",
        status: "rejected",
        work_order_commitment: workOrderCommitment,
        vault_commitment: fixture.vaultCommitment,
        result_commitment: "hyperliquid_pre_submit_rejected_result",
        fill_summary: { fill_count: 0 },
        final_proof: {
          proof_kind: "hyperliquid_execution_proof_v1",
          venue_id: "hyperliquid",
          network: "mainnet",
          status: "rejected",
          terminal_status: "rejected",
          broadcast_performed: false,
          final_venue_execution_proven: true,
          final_fill_proven: false,
          final_no_fill_proven: false,
          final_no_broadcast_proven: true,
          venue_order_readback_proven: false,
          venue_order_oid: null,
          venue_order_cloid: null,
        },
      });
    }));

    const response = await dispatchLiveTradingOrder({
      owner_commitment: OWNER,
      account_commitment: ACCOUNT,
      vault_commitment: fixture.vaultCommitment,
      idempotency_key: "idempotency_live_dispatch_pre_submit_rejected",
      plan_digest: `sha256:${"8".repeat(64)}`,
      order_plan: plan(),
      env: liveEnv(),
      fetchImpl: fetchMock,
      waitImpl: async () => undefined,
    });

    expect(response.headers.get(LIVE_TRADING_DISPATCH_DISPOSITION_HEADER)).toBe("not_dispatched");
    expect(await response.json()).toMatchObject({
      appLiveTradingExecutionRun: {
        status: "not_dispatched",
        gholaAppLiveTradingExecutionRunCommitment: "hyperliquid_pre_submit_rejected_result",
        liveTradingOrder: null,
        workerWorkOrderCommitment: workOrderCommitment,
      },
    });
    expect(orderCalls).toBe(1);
  });

  it("proves no worker claim after instruction expiry without rebroadcast", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-08-19T12:00:00.000Z");
    vi.setSystemTime(startedAt);
    const fixture = await setupFixture();
    const planDigest = `sha256:${"4".repeat(64)}`;
    let orderCalls = 0;
    const fetchMock = brandPrivateAgentMockTransport(vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/.well-known/private-agent-recipient")) {
        return Response.json(fixture.recipientMetadata);
      }
      if (url.endsWith("/hyperliquid/orders")) {
        orderCalls += 1;
        throw new Error("worker transport timeout before arrival");
      }
      return Response.json({
        error: "hyperliquid execution claim was not found",
        error_code: "HYPERLIQUID_EXECUTION_CLAIM_NOT_FOUND",
      }, { status: 404 });
    }));
    try {
      const initial = await dispatchLiveTradingOrder({
        owner_commitment: OWNER,
        account_commitment: ACCOUNT,
        vault_commitment: fixture.vaultCommitment,
        idempotency_key: "idempotency_live_dispatch_worker_absence",
        plan_digest: planDigest,
        order_plan: plan(),
        env: liveEnv(),
        fetchImpl: fetchMock,
        waitImpl: async () => undefined,
      });
      expect(initial.headers.get(LIVE_TRADING_DISPATCH_DISPOSITION_HEADER)).toBe("submitted");

      vi.setSystemTime(new Date(startedAt.getTime() + 16_000));
      const firstExpired = await reconcileLiveTradingWorkOrder({
        owner_commitment: OWNER,
        plan_digest: planDigest,
        env: liveEnv(),
        fetchImpl: fetchMock,
      });
      expect(firstExpired.status).toBe(202);

      vi.setSystemTime(new Date(startedAt.getTime() + 46_000));
      const terminal = await reconcileLiveTradingWorkOrder({
        owner_commitment: OWNER,
        plan_digest: planDigest,
        env: liveEnv(),
        fetchImpl: fetchMock,
      });
      expect(terminal.headers.get(LIVE_TRADING_DISPATCH_DISPOSITION_HEADER)).toBe("not_dispatched");
      expect(await terminal.json()).toMatchObject({
        planDigest,
        appLiveTradingExecutionRun: {
          status: "not_dispatched",
          liveTradingOrder: null,
        },
      });
      expect(orderCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers a fill after reload and more than one second without rebroadcast", async () => {
    const fixture = await setupFixture();
    const planDigest = `sha256:${"6".repeat(64)}`;
    let orderCalls = 0;
    let reconcileCalls = 0;
    let late = false;
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
          version: 1,
          platform_class: "hyperliquid_style_market",
          execution_mode: "byo_api_key",
          status: "submitted",
          work_order_commitment: workOrderCommitment,
          vault_commitment: fixture.vaultCommitment,
          result_commitment: "hyperliquid_late_submitted_result",
          fill_summary: { fill_count: 0 },
          final_proof: {
            ...protectionProof(),
            proof_kind: "hyperliquid_execution_proof_v1",
            venue_id: "hyperliquid",
            network: "mainnet",
            broadcast_performed: true,
            final_venue_execution_proven: true,
            final_fill_proven: false,
            execution_configuration_proven: true,
            margin_mode: "isolated",
            leverage: 1,
            market_data_freshness_proven: true,
            market_slippage_bound_proven: true,
            market_source_age_ms: 300,
            market_max_age_ms: 2_000,
            action_expiry_proven: true,
            expires_after_ms: Date.now() + 10_000,
            venue_order_readback_proven: true,
            venue_order_status: "open",
            venue_order_oid: "518475952916",
          },
        }, { status: 202 });
      }
      reconcileCalls += 1;
      expect(body).toMatchObject({
        reconciliation_binding_version: 1,
        owner_commitment: OWNER,
        account_commitment: ACCOUNT,
        vault_commitment: fixture.vaultCommitment,
        plan_digest: planDigest,
        original_operation_class: "limit_order",
        work_order_commitment: workOrderCommitment,
        market: "BTC",
      });
      expect(body.order_policy_commitment).toMatch(/^live_trade_order_policy_[a-f0-9]{48}$/u);
      expect(body.request_commitment).toMatch(/^live_trade_request_[a-f0-9]{48}$/u);
      expect(body.original_request_digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
      if (!late) return Response.json({ status: "submitted" }, { status: 202 });
      return Response.json({
        version: 1,
        platform_class: "hyperliquid_style_market",
        execution_mode: "byo_api_key",
        status: "filled",
        work_order_commitment: workOrderCommitment,
        vault_commitment: fixture.vaultCommitment,
        result_commitment: "hyperliquid_late_terminal_result",
        fill_summary: { fill_count: 1 },
        final_proof: {
          ...protectionProof(),
          proof_kind: "hyperliquid_execution_proof_v1",
          status: "filled",
          venue_id: "hyperliquid",
          network: "mainnet",
          broadcast_performed: true,
          final_venue_execution_proven: true,
          final_fill_proven: true,
          final_no_fill_proven: false,
          terminal_status: "filled",
          venue_order_readback_proven: true,
          venue_order_status: "filled",
          venue_order_oid: "518475952916",
          venue_order_cloid: CLOID,
          venue_order_original_size: "0.1",
          venue_order_remaining_size: "0",
          venue_order_filled_size: "0.1",
        },
      }, { status: 200 });
    }));

    const initial = await dispatchLiveTradingOrder({
      owner_commitment: OWNER,
      account_commitment: ACCOUNT,
      vault_commitment: fixture.vaultCommitment,
      idempotency_key: "idempotency_live_dispatch_late_reconcile",
      plan_digest: planDigest,
      order_plan: plan(),
      env: liveEnv(),
      fetchImpl: fetchMock,
      waitImpl: async () => undefined,
    });
    expect(initial.status).toBe(202);
    expect(initial.headers.get(LIVE_TRADING_DISPATCH_DISPOSITION_HEADER)).toBe("submitted");
    expect(await initial.json()).toMatchObject({
      appLiveTradingExecutionRun: {
        status: "submitted",
        workerWorkOrderCommitment: workOrderCommitment,
      },
    });

    const duplicate = await dispatchLiveTradingOrder({
      owner_commitment: OWNER,
      account_commitment: ACCOUNT,
      vault_commitment: fixture.vaultCommitment,
      idempotency_key: "idempotency_live_dispatch_late_reconcile_retry",
      plan_digest: planDigest,
      order_plan: plan(),
      env: liveEnv(),
      fetchImpl: fetchMock,
    });
    expect(duplicate.status).toBe(202);
    expect(duplicate.headers.get(LIVE_TRADING_DISPATCH_DISPOSITION_HEADER)).toBe("submitted");
    expect(await duplicate.json()).toMatchObject({
      status: "pending",
      planDigest,
      workerWorkOrderCommitment: workOrderCommitment,
    });
    expect(orderCalls).toBe(1);

    late = true;
    const recovered = await reconcileLiveTradingWorkOrder({
      owner_commitment: OWNER,
      plan_digest: planDigest,
      env: liveEnv(),
      fetchImpl: fetchMock,
    });
    expect(recovered.status).toBe(202);
    expect(recovered.headers.get(LIVE_TRADING_DISPATCH_DISPOSITION_HEADER)).toBe("filled");
    expect(await recovered.json()).toMatchObject({
      planDigest,
      appLiveTradingExecutionRun: {
        status: "reconciled",
        gholaAppLiveTradingExecutionRunCommitment: "hyperliquid_late_terminal_result",
        workerWorkOrderCommitment: workOrderCommitment,
        liveTradingOrder: { orderId: "hyperliquid:518475952916" },
      },
    });
    expect(orderCalls).toBe(1);
    expect(reconcileCalls).toBe(5);
  });

  it("returns terminal not-dispatched only after the durable absence grace", async () => {
    const planDigest = `sha256:${"7".repeat(64)}`;
    const first = await reconcileLiveTradingWorkOrder({
      owner_commitment: OWNER,
      plan_digest: planDigest,
      now: new Date("2026-08-19T12:00:00.000Z"),
      fetchImpl: brandPrivateAgentMockTransport(vi.fn<typeof fetch>()),
      env: liveEnv(),
    });
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ status: "pending", dispatchAbsencePending: true, planDigest });

    const terminal = await reconcileLiveTradingWorkOrder({
      owner_commitment: OWNER,
      plan_digest: planDigest,
      now: new Date(Date.parse("2026-08-19T12:00:00.000Z") + LIVE_TRADING_DISPATCH_ABSENCE_GRACE_MS),
      fetchImpl: brandPrivateAgentMockTransport(vi.fn<typeof fetch>()),
      env: liveEnv(),
    });
    expect(terminal.status).toBe(200);
    expect(terminal.headers.get(LIVE_TRADING_DISPATCH_DISPOSITION_HEADER)).toBe("not_dispatched");
    expect(await terminal.json()).toMatchObject({
      status: "not_dispatched",
      planDigest,
      dispatchAbsenceProofCommitment: expect.stringMatching(/^live_trade_absence_proof_[a-f0-9]{48}$/u),
      dispatchAbsenceEvidence: {
        workOrderRecord: false,
        reservation: false,
        workerClaim: false,
        workerIdempotency: false,
        workerCallRequiresDurableRecord: true,
        graceMs: 30_000,
      },
      firstCheckedAt: "2026-08-19T12:00:00.000Z",
      checkedAt: "2026-08-19T12:00:30.000Z",
    });
  });
});

async function setupFixture(options: {
  aadAccount?: string;
  network?: "mainnet" | "testnet";
} = {}) {
  const recipientSecret = x25519.utils.randomPrivateKey();
  const x25519PubHex = Buffer.from(x25519.getPublicKey(recipientSecret)).toString("hex");
  const recipientId = "phala:cvm:live-dispatch-test";
  const fundingSigner = Buffer.alloc(44, 7).toString("base64");
  const created = createHyperliquidExecutionVault({
    account_commitment: ACCOUNT,
    encrypted_execution_vault: {
      ciphertext: "sealed-vault-ciphertext-test",
      recipient: recipientId,
      aad: `ghola/hyperliquid-execution-vault-v1|account:${options.aadAccount ?? ACCOUNT}|recipient:${recipientId}|network:${options.network ?? "mainnet"}`,
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
    GHOLA_LIVE_TRADING_PUBLIC_CAPABILITIES: "limit_order,cancel,reduce_only,stop_loss,take_profit",
    GHOLA_LIVE_TRADING_MAX_ORDER_NOTIONAL_USD: "100",
    GHOLA_LIVE_TRADING_DAILY_CAP_USD: "500",
    GHOLA_LIVE_TRADING_MAX_SLIPPAGE_BPS: "100",
    GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET: "secure_private_account_request_proof_secret_value",
    GHOLA_LIVE_TRADING_CONTROL_TOKEN: "K7vP3xN9mR2qW8tL5cD1hF6jB4zY0uSa",
    GHOLA_LIVE_TRADING_RESET_TOKEN: "R4nW8qL2xC7mV1pK9tD5hF3jB6zY0uSa",
    GHOLA_INVESTOR_CANARY_SECRET: "Q9mV4xR7kT2pN8cL5wD1hF6jB3zY0uSa",
    GHOLA_PRIVATE_ACCOUNT_STORE: "postgres",
    GHOLA_PRIVATE_ACCOUNT_DATABASE_URL: "postgres://configured.example/ghola",
    GHOLA_PRIVATE_AGENT_PROVISIONING_MUTATIONS_ENABLED: "false",
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
    PRIVATE_AGENT_HYPERLIQUID_RISK_REDUCTION_ENABLED: "true",
    GHOLA_LIVE_TRADING_POSITION_PROTECTION_ENABLED: "true",
    PRIVATE_AGENT_GLOBAL_KILL_SWITCH: "false",
    GHOLA_WEB_GIT_SHA: SHA,
    GHOLA_BAKED_WEB_GIT_SHA: SHA,
    VERCEL_GIT_COMMIT_SHA: SHA,
    GHOLA_PRIVATE_AGENT_WORKER_GIT_SHA: SHA,
    GHOLA_PRIVATE_AGENT_WORKER_IMAGE: `ghcr.io/anndrrson/ghola:private-agent-worker-${SHA}`,
    GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST: DIGEST,
    PRIVATE_AGENT_IMAGE_DIGEST: DIGEST,
    PHALA_CVM_IMAGE_DIGEST: DIGEST,
    GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64: Buffer.alloc(44, 7).toString("base64"),
    GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.ghola.xyz",
    GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "B7zL4qN9wX2cV8mK5rT1yP6sD3fH0jUa",
    PRIVATE_AGENT_EXECUTION_TOKEN: "B7zL4qN9wX2cV8mK5rT1yP6sD3fH0jUa",
    NEXT_PUBLIC_GOOGLE_CLIENT_ID: "ghola-investor.apps.googleusercontent.com",
    PRIVATE_AGENT_WORKER_CAPABILITY_SECRET: "M8pR2vW7xZ4cN9kL5tQ1sD6fH3jY0uBa",
  };
}

function plan(takeProfitLevel: number | undefined = 63_500): TradeOrderPlan {
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

function protectionProof() {
  return {
    position_protection_proven: true,
    protection_grouping: "normalTpsl",
    protection_trigger_source: "mark",
    protection_trigger_order_type: "bounded_limit",
    protection_max_slippage_bps: 50,
  } as const;
}

type DispatchInput = Parameters<typeof dispatchLiveTradingOrderImpl>[0];

function dispatchLiveTradingOrder(
  input: Omit<DispatchInput, "expected_launch_revision"> & { expected_launch_revision?: number | null },
) {
  const expectedLaunchRevision = Object.prototype.hasOwnProperty.call(input, "expected_launch_revision")
    ? input.expected_launch_revision ?? null
    : input.order_plan.execution_policy.reduce_only ? null : launchRevision;
  return dispatchLiveTradingOrderImpl({
    ...input,
    expected_launch_revision: expectedLaunchRevision,
  });
}
