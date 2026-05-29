import { afterEach, describe, expect, it, vi } from "vitest";
import {
  containsForbiddenPublicPrivateAccountField,
  createHyperliquidExecutionVault,
  createHyperliquidSessionPolicy,
  createPrivateAccountAction,
  createPrivateExecutionAccount,
  previewPrivateAccountAction,
  validateHyperliquidPolicyExecution,
} from "./private-account";
import {
  buildConnectorWorkOrder,
  compilePrivateConnectorIntent,
  connectorReadiness,
  getConnectorManifest,
  scoreConnectorLinkability,
  submitConnectorWorkOrder,
} from "./private-account-connectors";
import { sealedRuntimeHealth } from "./private-account-runtime";

const NOW = new Date("2026-05-27T12:00:00.000Z");

describe("Hyperliquid private execution layer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.GHOLA_V6_HYPERLIQUID_PILOT_ENABLED;
    delete process.env.GHOLA_CONNECTOR_MODE;
  });

  it("stores sealed vault ciphertext and commitments without raw Hyperliquid identifiers or secrets", () => {
    expect(containsForbiddenPublicPrivateAccountField({
      hyperliquid_account_id: "raw-account",
      api_secret: "raw-secret",
      strategy_text: "buy ETH on momentum",
      order_payload: { market: "ETH" },
    })).toBe(true);

    const created = createHyperliquidExecutionVault({
      account_commitment: "acct_commitment_test",
      encrypted_execution_vault: {
        ciphertext: "sealed-ciphertext-only",
        recipient: "phala:cvm:test",
        aad: "ghola/hyperliquid-execution-vault-v1",
      },
      now: NOW,
    });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const serialized = JSON.stringify(created.vault);
    expect(created.vault.vault_commitment).toMatch(/^hyperliquid_execution_vault_/);
    expect(created.vault.encrypted_vault_commitment).toMatch(/^hyperliquid_encrypted_vault_/);
    expect(serialized).not.toContain("raw-account");
    expect(serialized).not.toContain("raw-secret");
    expect(serialized).not.toContain("buy ETH");
    expect(serialized).not.toContain("order_payload");
  });

  it("enforces capped Hyperliquid policy controls", () => {
    const policy = createHyperliquidSessionPolicy({
      market_allowlist: ["ETH"],
      max_notional_bucket: "25",
      max_order_count: 1,
      now: NOW,
    });

    expect(validateHyperliquidPolicyExecution({
      policy,
      operation: "limit_order",
      market: "ETH",
      notional_bucket: "25",
      order_count: 0,
      now: NOW,
    })).toEqual({ ok: true });

    expect(validateHyperliquidPolicyExecution({
      policy,
      operation: "limit_order",
      market: "SOL",
      notional_bucket: "50",
      order_count: 1,
      now: NOW,
    })).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        "market_not_allowed",
        "notional_bucket_exceeds_cap",
        "order_count_exceeded",
      ]),
    });

    expect(validateHyperliquidPolicyExecution({
      policy,
      operation: "withdraw",
      market: "ETH",
      now: NOW,
    })).toMatchObject({
      ok: false,
      errors: expect.arrayContaining(["operation_blocked"]),
    });

    const stopped = createHyperliquidSessionPolicy({ kill_switch: true, now: NOW });
    expect(validateHyperliquidPolicyExecution({
      policy: stopped,
      operation: "limit_order",
      now: NOW,
    })).toMatchObject({
      ok: false,
      errors: expect.arrayContaining(["kill_switch_active"]),
    });
  });

  it("blocks Hyperliquid readiness unless pilot, runtime, vault, funding, and connector gates are green", async () => {
    const blockedManifest = getConnectorManifest("hyperliquid_style_market", NOW);
    const blocked = await connectorReadiness({
      manifest: blockedManifest,
      now: NOW,
      execution_vault_ready: false,
      shielded_funding_ready: false,
    });

    expect(blocked.status).toBe("blocked");
    expect(blocked.reason_codes).toEqual(expect.arrayContaining([
      "hyperliquid_pilot_disabled",
      "venue_access_required",
      "hyperliquid_execution_vault_not_ready",
      "shielded_funding_evidence_required",
    ]));

    process.env.GHOLA_V6_HYPERLIQUID_PILOT_ENABLED = "true";
    process.env.GHOLA_CONNECTOR_MODE = "local_test";
    const readyManifest = getConnectorManifest("hyperliquid_style_market", NOW);
    const ready = await connectorReadiness({
      manifest: readyManifest,
      now: NOW,
      execution_vault_ready: true,
      shielded_funding_ready: true,
      runtime_health: sealedRuntimeHealth(NOW, {
        NODE_ENV: "test",
        GHOLA_CONNECTOR_MODE: "local_test",
      }),
    });

    expect(ready.status).toBe("ready");
    expect(ready.live_submit_enabled).toBe(true);
  });

  it("allows Hyperliquid read readiness without private funding evidence", async () => {
    process.env.GHOLA_V6_HYPERLIQUID_PILOT_ENABLED = "true";
    process.env.GHOLA_CONNECTOR_MODE = "local_test";
    const manifest = getConnectorManifest("hyperliquid_style_market", NOW);
    const readiness = await connectorReadiness({
      manifest,
      now: NOW,
      action_class: "fund_platform",
      execution_vault_ready: true,
      shielded_funding_ready: false,
      runtime_health: sealedRuntimeHealth(NOW, {
        NODE_ENV: "test",
        GHOLA_CONNECTOR_MODE: "local_test",
      }),
    });

    expect(readiness.status).toBe("ready");
    expect(readiness.reason_codes).not.toContain("shielded_funding_evidence_required");
  });

  it("allows BYO Hyperliquid tiny-fill readiness without shielded funding evidence", async () => {
    process.env.GHOLA_V6_HYPERLIQUID_PILOT_ENABLED = "true";
    const env = {
      NODE_ENV: "production",
      GHOLA_V6_HYPERLIQUID_PILOT_ENABLED: "true",
      GHOLA_HYPERLIQUID_LIVE_MODE: "tiny_fill",
      GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL: "https://worker.ghola.test",
      GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_READINESS: "ready",
      GHOLA_PRIVATE_RUNTIME_URL: "https://runtime.ghola.test",
      GHOLA_PRIVATE_RUNTIME_MEASUREMENT: "measurement-test",
    };
    const manifest = getConnectorManifest("hyperliquid_style_market", NOW);
    const readiness = await connectorReadiness({
      manifest,
      now: NOW,
      env,
      execution_mode: "byo_api_key",
      action_class: "trade_on_platform",
      execution_vault_ready: true,
      shielded_funding_ready: false,
      runtime_health: sealedRuntimeHealth(NOW, env),
    });

    expect(readiness.status).toBe("ready");
    expect(manifest.supported_rails).toContain("direct_public_fallback");
    expect(readiness.reason_codes).not.toContain("shielded_funding_evidence_required");
    expect(JSON.stringify(readiness).toLowerCase()).not.toContain("jurisdiction");
  });

  it("submits only commitments and encrypted vault material to the Hyperliquid executor", async () => {
    process.env.GHOLA_V6_HYPERLIQUID_PILOT_ENABLED = "true";
    const env = {
      NODE_ENV: "production",
      GHOLA_V6_HYPERLIQUID_PILOT_ENABLED: "true",
      GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL: "https://worker.ghola.test",
      GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_READINESS: "ready",
      GHOLA_PRIVATE_RUNTIME_URL: "https://runtime.ghola.test",
      GHOLA_PRIVATE_RUNTIME_MEASUREMENT: "measurement-test",
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        ok: true,
        provider_ref_commitment: "hyperliquid_provider_ref_test",
        result_commitment: "hyperliquid_result_test",
      }, { status: 202 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const account = createPrivateExecutionAccount({ vaultReady: true });
    const action = createPrivateAccountAction({ action_class: "trade_on_platform", product_bucket: "perps", now: NOW });
    const manifest = getConnectorManifest("hyperliquid_style_market", NOW);
    const readiness = await connectorReadiness({
      manifest,
      now: NOW,
      env,
      execution_vault_ready: true,
      shielded_funding_ready: true,
      runtime_health: sealedRuntimeHealth(NOW, env),
    });
    const compiled = compilePrivateConnectorIntent({
      intent_id: "intent_hl_1",
      account_commitment: account.account_commitment,
      action_commitment: action.action_commitment,
      action_class: action.action_class,
      platform_class: "hyperliquid_style_market",
      product_bucket: "perps",
      manifest,
      safe_input: {
        amount_bucket: "25",
        asset_bucket: "ETH",
        destination_class: "platform_subaccount",
        urgency: "maximum_privacy",
      },
      now: NOW,
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const linkability = scoreConnectorLinkability({
      account_commitment: account.account_commitment,
      platform_class: "hyperliquid_style_market",
      compiled_intent: compiled.compiled_intent,
      now: NOW,
    });
    const preview = previewPrivateAccountAction({
      account,
      action,
      platform_class: "hyperliquid_style_market",
      requested_rail: "shielded_pool",
      anonymity_set: {
        required: 2,
        effective: 2,
        amount_bucketed: true,
        timing_window_met: true,
        uniqueness_score_bps: 0,
      },
      evidence_status: "ready",
      evidence_chain: {
        version: 1,
        funding_import_commitment: "funding_import_test",
        batch_id: "batch_test",
        batch_evidence_commitment: "anon_evidence_test",
        preview_commitment: "pending",
        approval_commitment: null,
        execution_commitment: null,
      },
      now: NOW,
    });
    const workOrder = buildConnectorWorkOrder({
      owner_commitment: "owner_commitment_test",
      intent_id: "intent_hl_1",
      account_commitment: account.account_commitment,
      action_commitment: action.action_commitment,
      preview,
      approval_commitment: "approval_test",
      execution_plan_commitment: null,
      compiled_intent: compiled.compiled_intent,
      manifest,
      readiness,
      linkability_score: linkability,
      now: NOW,
    });
    const vault = createHyperliquidExecutionVault({
      account_commitment: account.account_commitment,
      encrypted_execution_vault: {
        ciphertext: "sealed-ciphertext-only",
        recipient: "phala:cvm:test",
        aad: "ghola/hyperliquid-execution-vault-v1",
      },
      now: NOW,
    });
    expect(vault.ok).toBe(true);
    if (!vault.ok) return;

    const submitted = await submitConnectorWorkOrder({
      work_order: workOrder,
      manifest,
      compiled_intent: compiled.compiled_intent,
      preview,
      readiness,
      hyperliquid_execution_vault: vault.vault,
      env,
      now: NOW,
    });

    expect(submitted.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://worker.ghola.test/hyperliquid/orders");
    const body = JSON.parse(String(init?.body));
    expect(body.work_order_commitment).toBe(workOrder.work_order_commitment);
    expect(body.operation_class).toBe("limit_order");
    expect(body.encrypted_execution_vault.ciphertext).toBe("sealed-ciphertext-only");
    expect(JSON.stringify(body)).not.toContain("api_secret");
    expect(JSON.stringify(body)).not.toContain("order_payload");
    expect(JSON.stringify(body)).not.toContain("strategy_text");
  });

  it("submits managed Hyperliquid testnet allocations without encrypted vault material", async () => {
    process.env.GHOLA_V6_HYPERLIQUID_PILOT_ENABLED = "true";
    const env = {
      NODE_ENV: "production",
      GHOLA_V6_HYPERLIQUID_PILOT_ENABLED: "true",
      GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL: "https://worker.ghola.test",
      GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_READINESS: "ready",
      GHOLA_PRIVATE_RUNTIME_URL: "https://runtime.ghola.test",
      GHOLA_PRIVATE_RUNTIME_MEASUREMENT: "measurement-test",
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        ok: true,
        provider_ref_commitment: "hyperliquid_provider_ref_managed",
        result_commitment: "hyperliquid_result_managed",
      }, { status: 202 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const account = createPrivateExecutionAccount({ vaultReady: true });
    const action = createPrivateAccountAction({ action_class: "trade_on_platform", product_bucket: "perps", now: NOW });
    const manifest = getConnectorManifest("hyperliquid_style_market", NOW);
    const readiness = await connectorReadiness({
      manifest,
      now: NOW,
      env,
      action_class: action.action_class,
      execution_vault_ready: true,
      shielded_funding_ready: true,
      execution_mode: "managed_testnet",
      runtime_health: sealedRuntimeHealth(NOW, env),
    });
    const compiled = compilePrivateConnectorIntent({
      intent_id: "intent_hl_managed",
      account_commitment: account.account_commitment,
      action_commitment: action.action_commitment,
      action_class: action.action_class,
      platform_class: "hyperliquid_style_market",
      product_bucket: "perps",
      manifest,
      safe_input: {
        amount_bucket: "25",
        asset_bucket: "ETH",
        destination_class: "platform_subaccount",
      },
      now: NOW,
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const linkability = scoreConnectorLinkability({
      account_commitment: account.account_commitment,
      platform_class: "hyperliquid_style_market",
      compiled_intent: compiled.compiled_intent,
      now: NOW,
    });
    const preview = previewPrivateAccountAction({
      account,
      action,
      platform_class: "hyperliquid_style_market",
      requested_rail: "shielded_pool",
      anonymity_set: {
        required: 2,
        effective: 2,
        amount_bucketed: true,
        timing_window_met: true,
        uniqueness_score_bps: 0,
      },
      evidence_status: "ready",
      now: NOW,
    });
    const workOrder = buildConnectorWorkOrder({
      owner_commitment: "owner_commitment_test",
      intent_id: "intent_hl_managed",
      account_commitment: account.account_commitment,
      action_commitment: action.action_commitment,
      preview,
      approval_commitment: "approval_test",
      execution_plan_commitment: null,
      compiled_intent: compiled.compiled_intent,
      manifest,
      readiness,
      linkability_score: linkability,
      now: NOW,
    });

    const submitted = await submitConnectorWorkOrder({
      work_order: workOrder,
      manifest,
      compiled_intent: compiled.compiled_intent,
      preview,
      readiness,
      hyperliquid_managed_allocation: {
        allocation_commitment: "hyperliquid_managed_allocation_test",
        policy_commitment: "hyperliquid_policy_test",
        pool_commitment: "hyperliquid_pool_test",
        subledger_account_commitment: "hyperliquid_subledger_test",
        status: "allocated",
      },
      env,
      now: NOW,
    });

    expect(submitted.ok).toBe(true);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body.execution_mode).toBe("managed_testnet");
    expect(body.managed_allocation_commitment).toBe("hyperliquid_managed_allocation_test");
    expect(body.encrypted_execution_vault).toBeUndefined();
  });

  it("maps Hyperliquid venue rejection separately from connector failure", async () => {
    process.env.GHOLA_V6_HYPERLIQUID_PILOT_ENABLED = "true";
    const env = {
      NODE_ENV: "production",
      GHOLA_V6_HYPERLIQUID_PILOT_ENABLED: "true",
      GHOLA_HYPERLIQUID_LIVE_MODE: "tiny_fill",
      GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL: "https://worker.ghola.test",
      GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_READINESS: "ready",
      GHOLA_PRIVATE_RUNTIME_URL: "https://runtime.ghola.test",
      GHOLA_PRIVATE_RUNTIME_MEASUREMENT: "measurement-test",
    };
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({
        error: "hyperliquid request failed",
        error_code: "venue_rejected",
      }, { status: 422 }),
    ));

    const account = createPrivateExecutionAccount({ vaultReady: true });
    const action = createPrivateAccountAction({ action_class: "trade_on_platform", product_bucket: "perps", now: NOW });
    const manifest = getConnectorManifest("hyperliquid_style_market", NOW);
    const readiness = await connectorReadiness({
      manifest,
      now: NOW,
      env,
      execution_mode: "byo_api_key",
      action_class: action.action_class,
      execution_vault_ready: true,
      shielded_funding_ready: false,
      runtime_health: sealedRuntimeHealth(NOW, env),
    });
    const compiled = compilePrivateConnectorIntent({
      intent_id: "intent_hl_rejected",
      account_commitment: account.account_commitment,
      action_commitment: action.action_commitment,
      action_class: action.action_class,
      platform_class: "hyperliquid_style_market",
      product_bucket: "perps",
      manifest,
      safe_input: { amount_bucket: "5", asset_bucket: "BTC", destination_class: "platform_subaccount" },
      now: NOW,
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const preview = previewPrivateAccountAction({
      account,
      action,
      platform_class: "hyperliquid_style_market",
      requested_rail: "direct_public_fallback",
      evidence_status: "missing",
      degraded_accepted: true,
      now: NOW,
    });
    const workOrder = buildConnectorWorkOrder({
      owner_commitment: "owner_commitment_test",
      intent_id: "intent_hl_rejected",
      account_commitment: account.account_commitment,
      action_commitment: action.action_commitment,
      preview,
      approval_commitment: "approval_test",
      execution_plan_commitment: null,
      compiled_intent: compiled.compiled_intent,
      manifest,
      readiness,
      linkability_score: scoreConnectorLinkability({
        account_commitment: account.account_commitment,
        platform_class: "hyperliquid_style_market",
        compiled_intent: compiled.compiled_intent,
        now: NOW,
      }),
      now: NOW,
    });

    const submitted = await submitConnectorWorkOrder({
      work_order: workOrder,
      manifest,
      compiled_intent: compiled.compiled_intent,
      preview,
      readiness,
      hyperliquid_execution_vault: {
        vault_commitment: "hyperliquid_vault_test",
        encrypted_vault_commitment: "hyperliquid_encrypted_vault_test",
        policy_commitment: "hyperliquid_policy_test",
        encrypted_execution_vault: { ciphertext: "sealed" },
      },
      env,
      now: NOW,
    });

    expect(submitted).toEqual({ ok: false, error: "venue_rejected" });
  });
});
