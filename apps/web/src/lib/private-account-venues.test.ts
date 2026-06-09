import { afterEach, describe, expect, it, vi } from "vitest";
import {
  containsForbiddenPublicPrivateAccountField,
  createCoinbaseAdvancedExecutionVault,
  createOmnibusAllocation,
  createPooledVenueAllocation,
  createPrivateAccountAction,
  createPrivateExecutionAccount,
  createSecretHandle,
  createStealthVenueAccount,
  createVenueSessionPolicy,
  getVenueManifest,
  listVenueManifests,
  previewPrivateAccountAction,
  validateVenuePolicyExecution,
  venuePlatformClass,
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

describe("Coinbase Advanced private venue and omnibus model", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.GHOLA_V6_COINBASE_PILOT_ENABLED;
    delete process.env.GHOLA_COINBASE_PARTNER_OMNIBUS_ENABLED;
    delete process.env.GHOLA_COINBASE_PARTNER_OMNIBUS_POOL_READY;
    delete process.env.GHOLA_CONNECTOR_MODE;
  });

  it("stores only sealed Coinbase API-key vault material", () => {
    expect(containsForbiddenPublicPrivateAccountField({
      api_key_name: "organizations/raw/apiKeys/raw",
      coinbase_private_key: "raw-pem",
      portfolio_id: "raw-portfolio",
      order_payload: { product_id: "BTC-USD" },
    })).toBe(true);

    const created = createCoinbaseAdvancedExecutionVault({
      account_commitment: "acct_commitment_test",
      encrypted_execution_vault: {
        ciphertext: "sealed-coinbase-vault-only",
        recipient: "phala:cvm:test",
        aad: "ghola/coinbase-advanced-execution-vault-v1|account:acct_commitment_test|recipient:phala:cvm:test|mode:byo_api_key|network:mainnet",
      },
      now: NOW,
    });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const serialized = JSON.stringify(created.vault);
    expect(created.vault.venue_id).toBe("coinbase_advanced");
    expect(created.vault.execution_mode).toBe("byo_api_key");
    expect(created.vault.vault_commitment).toMatch(/^venue_execution_vault_/);
    expect(serialized).not.toContain("organizations/raw");
    expect(serialized).not.toContain("raw-pem");
    expect(serialized).not.toContain("raw-portfolio");
  });

  it("creates a commitment-only partner omnibus allocation", () => {
    const allocation = createOmnibusAllocation({
      account_commitment: "acct_commitment_test",
      settlement_funding_commitment: "funding_import_commitment_test",
      utilization_bucket: "10",
      now: NOW,
    });

    expect(allocation.execution_mode).toBe("partner_omnibus");
    expect(allocation.status).toBe("allocated");
    expect(allocation.allocation_commitment).toMatch(/^omnibus_allocation_/);
    expect(JSON.stringify(allocation)).not.toContain("api_key");
  });

  it("enforces Coinbase policy caps and blocked custody operations", () => {
    const policy = createVenueSessionPolicy({
      venue_id: "coinbase_advanced",
      execution_mode: "partner_omnibus",
      market_allowlist: ["BTC-USD"],
      max_notional_bucket: "25",
      max_order_count: 1,
      now: NOW,
    });

    expect(validateVenuePolicyExecution({
      policy,
      operation: "spot_limit_order",
      market: "BTC-USD",
      notional_bucket: "25",
      order_count: 0,
      now: NOW,
    })).toEqual({ ok: true });

    expect(validateVenuePolicyExecution({
      policy,
      operation: "withdraw",
      market: "ETH-USD",
      notional_bucket: "50",
      order_count: 1,
      now: NOW,
    })).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        "operation_blocked",
        "market_not_allowed",
        "notional_bucket_exceeds_cap",
        "order_count_exceeded",
      ]),
    });
  });

  it("blocks Coinbase readiness unless pilot, omnibus, funding, runtime, and connector gates are green", async () => {
    const blockedManifest = getConnectorManifest("coinbase_style_provider", NOW);
    const blocked = await connectorReadiness({
      manifest: blockedManifest,
      now: NOW,
      execution_mode: "partner_omnibus",
      omnibus_allocation_ready: false,
      shielded_funding_ready: false,
    });

    expect(blocked.status).toBe("blocked");
    expect(blocked.reason_codes).toEqual(expect.arrayContaining([
      "coinbase_pilot_disabled",
      "coinbase_partner_omnibus_disabled",
      "coinbase_omnibus_allocation_not_ready",
      "shielded_funding_evidence_required",
    ]));

    process.env.GHOLA_V6_COINBASE_PILOT_ENABLED = "true";
    process.env.GHOLA_COINBASE_PARTNER_OMNIBUS_ENABLED = "true";
    process.env.GHOLA_COINBASE_PARTNER_OMNIBUS_POOL_READY = "true";
    process.env.GHOLA_CONNECTOR_MODE = "local_test";
    const readyManifest = getConnectorManifest("coinbase_style_provider", NOW);
    const ready = await connectorReadiness({
      manifest: readyManifest,
      now: NOW,
      execution_mode: "partner_omnibus",
      omnibus_allocation_ready: true,
      shielded_funding_ready: true,
      runtime_health: sealedRuntimeHealth(NOW, {
        NODE_ENV: "test",
        GHOLA_CONNECTOR_MODE: "local_test",
      }),
    });

    expect(ready.status).toBe("ready");
  });

  it("submits Coinbase omnibus orders with allocation commitments and no API-key ciphertext", async () => {
    process.env.GHOLA_V6_COINBASE_PILOT_ENABLED = "true";
    process.env.GHOLA_COINBASE_PARTNER_OMNIBUS_ENABLED = "true";
    const env = {
      NODE_ENV: "production",
      GHOLA_V6_COINBASE_PILOT_ENABLED: "true",
      GHOLA_COINBASE_PARTNER_OMNIBUS_ENABLED: "true",
      GHOLA_COINBASE_PARTNER_OMNIBUS_POOL_READY: "true",
      GHOLA_CONNECTOR_COINBASE_STYLE_PROVIDER_URL: "https://worker.ghola.test",
      GHOLA_CONNECTOR_COINBASE_STYLE_PROVIDER_TOKEN: "worker-token-test",
      GHOLA_CONNECTOR_COINBASE_STYLE_PROVIDER_READINESS: "ready",
      GHOLA_PRIVATE_RUNTIME_URL: "https://runtime.ghola.test",
      GHOLA_PRIVATE_RUNTIME_MEASUREMENT: "measurement-test",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return Response.json({
        ok: true,
        provider_ref_commitment: "coinbase_provider_ref_test",
        result_commitment: "coinbase_result_test",
      }, { status: 202 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const account = createPrivateExecutionAccount({ vaultReady: true });
    const action = createPrivateAccountAction({ action_class: "trade_on_platform", product_bucket: "provider", now: NOW });
    const manifest = getConnectorManifest("coinbase_style_provider", NOW);
    const readiness = await connectorReadiness({
      manifest,
      now: NOW,
      env,
      execution_mode: "partner_omnibus",
      omnibus_allocation_ready: true,
      shielded_funding_ready: true,
      runtime_health: sealedRuntimeHealth(NOW, env),
    });
    const compiled = compilePrivateConnectorIntent({
      intent_id: "intent_cb_1",
      account_commitment: account.account_commitment,
      action_commitment: action.action_commitment,
      action_class: action.action_class,
      platform_class: "coinbase_style_provider",
      product_bucket: "provider",
      manifest,
      safe_input: {
        amount_bucket: "25",
        asset_bucket: "BTC",
        destination_class: "platform_subaccount",
        urgency: "maximum_privacy",
      },
      now: NOW,
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const linkability = scoreConnectorLinkability({
      account_commitment: account.account_commitment,
      platform_class: "coinbase_style_provider",
      compiled_intent: compiled.compiled_intent,
      now: NOW,
    });
    const preview = previewPrivateAccountAction({
      account,
      action,
      platform_class: "coinbase_style_provider",
      requested_rail: "provider_omnibus_subaccount",
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
      intent_id: "intent_cb_1",
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
    const allocation = createOmnibusAllocation({
      account_commitment: account.account_commitment,
      settlement_funding_commitment: "funding_import_test",
      now: NOW,
    });

    const submitted = await submitConnectorWorkOrder({
      work_order: workOrder,
      manifest,
      compiled_intent: compiled.compiled_intent,
      preview,
      readiness,
      omnibus_allocation: allocation,
      encrypted_execution_instruction_bundle: {
        alg: "sealed-provider-v1",
        ciphertext: "sealed-instruction",
        recipient: "phala:cvm:test",
        aad: "ghola/private-execution-instruction-v1|work_order:connector_work_order_test|venue:coinbase_advanced|recipient:phala:cvm:test",
      },
      env,
      now: NOW,
    });

    expect(submitted.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://worker.ghola.test/venues/coinbase/orders");
    const body = JSON.parse(String(init?.body));
    expect(body.execution_mode).toBe("partner_omnibus");
    expect(body.operation_class).toBe("spot_limit_order");
    expect(body.encrypted_execution_instruction_bundle.ciphertext).toBe("sealed-instruction");
    expect(body.omnibus_allocation.allocation_commitment).toBe(allocation.allocation_commitment);
    expect(body.encrypted_execution_vault).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("api_private_key");
    expect(JSON.stringify(body)).not.toContain("order_payload");
    expect(JSON.stringify(body)).not.toContain("BTC-USD");
  });

  it("submits Phoenix-style Solana perps work orders through the shared private worker", async () => {
    const env = {
      NODE_ENV: "production",
      GHOLA_VENUE_PHOENIX_PILOT_ENABLED: "true",
      GHOLA_CONNECTOR_SOLANA_PERPS_MARKET_URL: "https://worker.ghola.test",
      GHOLA_CONNECTOR_SOLANA_PERPS_MARKET_READINESS: "ready",
      GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "worker-token",
      GHOLA_PRIVATE_RUNTIME_URL: "https://runtime.ghola.test",
      GHOLA_PRIVATE_RUNTIME_MEASUREMENT: "measurement-test",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return Response.json({
        ok: true,
        provider_ref_commitment: "phoenix_provider_ref_test",
        result_commitment: "phoenix_result_test",
      }, { status: 202 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const account = createPrivateExecutionAccount({ vaultReady: true });
    const action = createPrivateAccountAction({ action_class: "trade_on_platform", product_bucket: "perps", now: NOW });
    const manifest = getConnectorManifest("solana_perps_market", NOW);
    const readiness = await connectorReadiness({
      manifest,
      now: NOW,
      env,
      execution_mode: "user_stealth",
      execution_vault_ready: true,
      shielded_funding_ready: true,
      runtime_health: sealedRuntimeHealth(NOW, env),
    });
    expect(readiness.status).toBe("ready");

    const compiled = compilePrivateConnectorIntent({
      intent_id: "intent_phoenix_1",
      account_commitment: account.account_commitment,
      action_commitment: action.action_commitment,
      action_class: action.action_class,
      platform_class: "solana_perps_market",
      product_bucket: "perps",
      manifest,
      safe_input: {
        amount_bucket: "25",
        asset_bucket: "SOL",
        destination_class: "platform_subaccount",
        urgency: "maximum_privacy",
      },
      now: NOW,
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    const linkability = scoreConnectorLinkability({
      account_commitment: account.account_commitment,
      platform_class: "solana_perps_market",
      compiled_intent: compiled.compiled_intent,
      now: NOW,
    });
    const preview = previewPrivateAccountAction({
      account,
      action,
      platform_class: "solana_perps_market",
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
      intent_id: "intent_phoenix_1",
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
      venue_execution_vault: {
        venue_id: "phoenix",
        execution_mode: "user_stealth",
        vault_commitment: "phoenix_stealth_vault_commitment",
        encrypted_vault_commitment: "encrypted_phoenix_stealth_vault_commitment",
        policy_commitment: "phoenix_policy_commitment",
        encrypted_execution_vault: null,
      },
      encrypted_execution_instruction_bundle: {
        alg: "sealed-provider-v1",
        ciphertext: "sealed-phoenix-instruction",
        recipient: "phala:cvm:test",
        aad: "ghola/private-execution-instruction-v1|work_order:connector_work_order_test|venue:phoenix|recipient:phala:cvm:test",
      },
      env,
      now: NOW,
    });

    expect(submitted.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://worker.ghola.test/venues/solana-perps/orders");
    expect(init?.headers).toMatchObject({ authorization: "Bearer worker-token" });
    const body = JSON.parse(String(init?.body));
    expect(body.venue_id).toBe("phoenix");
    expect(body.execution_mode).toBe("user_stealth");
    expect(body.operation_class).toBe("perp_limit_order");
    expect(body.encrypted_execution_instruction_bundle.ciphertext).toBe("sealed-phoenix-instruction");
    expect(body.encrypted_execution_vault).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("raw_private_key");
    expect(JSON.stringify(body)).not.toContain("order_payload");
    expect(JSON.stringify(body)).not.toContain("SOL-PERP");
  });
});

describe("Ghola secret gravity venue model", () => {
  it("publishes broad venue manifests with stealth and pooled account modes", () => {
    const manifests = listVenueManifests(NOW);
    const phoenix = getVenueManifest("phoenix", NOW);
    const hyperliquid = getVenueManifest("hyperliquid", NOW);

    expect(manifests.map((item) => item.venue_id)).toEqual(expect.arrayContaining([
      "hyperliquid",
      "phoenix",
      "drift",
      "jupiter",
      "backpack",
      "coinbase_advanced",
      "rfq_network",
    ]));
    expect(venuePlatformClass("phoenix")).toBe("solana_perps_market");
    expect(phoenix.supported_account_modes).toEqual(["byo_account", "user_stealth", "ghola_pooled"]);
    expect(phoenix.default_account_mode).toBe("user_stealth");
    expect(phoenix.main_wallet_hidden_modes).toContain("user_stealth");
    expect(phoenix.venue_account_hidden_modes).toEqual(["ghola_pooled"]);
    expect(hyperliquid.manifest_commitment).toMatch(/^venue_manifest_/);
  });

  it("creates commitment-only secret handles, stealth accounts, and pooled allocations", () => {
    const secret = createSecretHandle({
      owner_commitment: "owner_secret_test",
      account_commitment: "acct_secret_test",
      venue_id: "phoenix",
      account_mode: "user_stealth",
      purpose: "trader_authority",
      encrypted_secret_commitment: "encrypted_secret_commitment_test",
      sealed_runtime_recipient_commitment: "sealed_recipient_commitment_test",
      now: NOW,
    });
    const stealth = createStealthVenueAccount({
      account_commitment: "acct_secret_test",
      venue_id: "phoenix",
      secret_handle_commitment: secret.secret_handle_commitment,
      funding_evidence_commitment: "funding_evidence_test",
      now: NOW,
    });
    const pooled = createPooledVenueAllocation({
      account_commitment: "acct_secret_test",
      venue_id: "phoenix",
      funding_evidence_commitment: "funding_evidence_test",
      utilization_bucket: "5",
      now: NOW,
    });

    expect(secret.secret_handle_commitment).toMatch(/^secret_handle_/);
    expect(secret.status).toBe("sealed");
    expect(stealth.venue_account_commitment).toMatch(/^stealth_venue_account_/);
    expect(stealth.main_wallet_exposed).toBe(false);
    expect(stealth.venue_account_visible_to_venue).toBe(true);
    expect(pooled.pooled_allocation_commitment).toMatch(/^pooled_venue_allocation_/);
    expect(pooled.venue_account_visible_to_venue).toBe(false);
    expect(JSON.stringify({ secret, stealth, pooled })).not.toContain("api_wallet_private_key");
    expect(JSON.stringify({ secret, stealth, pooled })).not.toContain("raw_private_key");
  });
});
