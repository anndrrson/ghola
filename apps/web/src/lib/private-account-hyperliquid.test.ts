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
  verifyConnectorNoSubmit,
} from "./private-account-connectors";
import { sealedRuntimeHealth } from "./private-account-runtime";

const NOW = new Date("2026-05-27T12:00:00.000Z");

function exactPerpsNoSubmitChecks(venueId: "aster" | "lighter"): Record<string, boolean> {
  return {
    sdk_checked: true,
    signer_matches_key: true,
    market_data_checked: true,
    account_state_checked: true,
    ...(venueId === "lighter" ? { margin_state_checked: true } : {}),
    order_request_checked: true,
    transaction_broadcast: false,
  };
}

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

  it("allows the HYPE proof market in the default Hyperliquid policy", () => {
    const policy = createHyperliquidSessionPolicy({ now: NOW });

    expect(policy.market_allowlist).toContain("HYPE");
    expect(validateHyperliquidPolicyExecution({
      policy,
      operation: "limit_order",
      market: "HYPE",
      notional_bucket: "10",
      order_count: 0,
      now: NOW,
    })).toEqual({ ok: true });
  });

  it("blocks Hyperliquid readiness unless pilot, vault, funding, and connector gates are green", async () => {
    const blockedManifest = getConnectorManifest("hyperliquid_style_market", NOW);
    const blocked = await connectorReadiness({
      manifest: blockedManifest,
      venue_id: "hyperliquid",
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
      venue_id: "hyperliquid",
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
      venue_id: "hyperliquid",
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

  it("fails closed on a null exact venue while keeping platform summaries diagnostic", async () => {
    process.env.GHOLA_V6_HYPERLIQUID_PILOT_ENABLED = "true";
    process.env.GHOLA_CONNECTOR_MODE = "local_test";
    const manifest = getConnectorManifest("hyperliquid_style_market", NOW);
    const exact = await connectorReadiness({
      manifest,
      venue_id: null,
      now: NOW,
      execution_vault_ready: true,
      shielded_funding_ready: true,
    });
    expect(exact.status).toBe("blocked");
    expect(exact.live_submit_enabled).toBe(false);
    expect(exact.reason_codes).toContain("venue_binding_required");

    const summary = await connectorReadiness({
      manifest,
      venue_id: null,
      platform_summary: true,
      now: NOW,
    });
    expect(summary.status).toBe("missing");
    expect(summary.reason_codes).toContain("platform_summary_only");
  });

  it.each(["aster", "lighter"] as const)(
    "requires %s-specific pilot and live-mode gates instead of Hyperliquid defaults",
    async (venueId) => {
      process.env.GHOLA_V6_HYPERLIQUID_PILOT_ENABLED = "true";
      const manifest = getConnectorManifest("hyperliquid_style_market", NOW);
      const env = {
        NODE_ENV: "production",
        GHOLA_V6_HYPERLIQUID_PILOT_ENABLED: "true",
        GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL: "https://worker.ghola.test",
        GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_TOKEN: "worker-token-test",
        GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_READINESS: "ready",
      };
      const readiness = (overrides: Record<string, string | undefined>) => connectorReadiness({
        manifest,
        venue_id: venueId,
        now: NOW,
        env: { ...env, ...overrides },
        execution_mode: "byo_api_key",
        execution_vault_ready: true,
        shielded_funding_ready: true,
      });

      const inherited = await readiness({});
      expect(inherited.status).toBe("blocked");
      expect(inherited.reason_codes).toEqual(expect.arrayContaining([
        `${venueId}_pilot_disabled`,
        `${venueId}_live_mode_disabled`,
      ]));

      const readOnly = await readiness(venueId === "aster"
        ? { PRIVATE_AGENT_ASTER_ALLOW_MAINNET: "true", PRIVATE_AGENT_ASTER_LIVE_MODE: "read_only" }
        : { PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET: "true", PRIVATE_AGENT_LIGHTER_LIVE_MODE: "read_only" });
      expect(readOnly.status).toBe("blocked");
      expect(readOnly.reason_codes).toContain(`${venueId}_live_mode_disabled`);

      const fullTicket = await readiness(venueId === "aster"
        ? { PRIVATE_AGENT_ASTER_ALLOW_MAINNET: "true", PRIVATE_AGENT_ASTER_LIVE_MODE: "full_ticket" }
        : { PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET: "true", PRIVATE_AGENT_LIGHTER_LIVE_MODE: "full_ticket" });
      expect(fullTicket.status).toBe("ready");
      expect(fullTicket.live_submit_enabled).toBe(true);
    },
  );

  it("allows BYO Hyperliquid tiny-fill readiness without shielded funding evidence", async () => {
    process.env.GHOLA_V6_HYPERLIQUID_PILOT_ENABLED = "true";
    const env = {
      NODE_ENV: "production",
      GHOLA_V6_HYPERLIQUID_PILOT_ENABLED: "true",
      GHOLA_HYPERLIQUID_LIVE_MODE: "tiny_fill",
      GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL: "https://worker.ghola.test",
      PRIVATE_AGENT_WORKER_CAPABILITY_SECRET: "worker-capability-secret-test",
      GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_READINESS: "ready",
    };
    const manifest = getConnectorManifest("hyperliquid_style_market", NOW);
    const readiness = await connectorReadiness({
      manifest,
      venue_id: "hyperliquid",
      now: NOW,
      env,
      execution_mode: "byo_api_key",
      action_class: "trade_on_platform",
      execution_vault_ready: true,
      shielded_funding_ready: false,
      runtime_health: sealedRuntimeHealth(NOW, env),
    });

    expect(readiness.status).toBe("ready");
    expect(readiness.reason_codes).not.toContain("connector_token_missing");
    expect(manifest.supported_rails).toContain("direct_public_fallback");
    expect(readiness.reason_codes).not.toContain("shielded_funding_evidence_required");
    expect(readiness.reason_codes).not.toContain("sealed_runtime_unhealthy");
    expect(readiness.reason_codes).not.toContain("sealed_runtime_attestation_required");
    expect(readiness.reason_codes).not.toContain("sealed_runtime_measurement_required");
    expect(JSON.stringify(readiness).toLowerCase()).not.toContain("jurisdiction");
  });

  it("submits only commitments and encrypted vault material to the Hyperliquid executor", async () => {
    process.env.GHOLA_V6_HYPERLIQUID_PILOT_ENABLED = "true";
    const env = {
      NODE_ENV: "production",
      GHOLA_V6_HYPERLIQUID_PILOT_ENABLED: "true",
      GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL: "https://worker.ghola.test",
      GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_TOKEN: "worker-token-test",
      GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_READINESS: "ready",
      GHOLA_PRIVATE_RUNTIME_URL: "https://runtime.ghola.test",
      GHOLA_PRIVATE_RUNTIME_MEASUREMENT: "measurement-test",
    };
    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      return Response.json({
        ok: true,
        venue_id: request.venue_id,
        platform_class: request.platform_class,
        work_order_commitment: request.work_order_commitment,
        provider_ref_commitment: "hyperliquid_provider_ref_test",
        result_commitment: "hyperliquid_result_test",
      }, { status: 202 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const account = createPrivateExecutionAccount({ vaultReady: true });
    const action = createPrivateAccountAction({ action_class: "trade_on_platform", product_bucket: "perps", now: NOW });
    const manifest = getConnectorManifest("hyperliquid_style_market", NOW);
    const readiness = await connectorReadiness({
      manifest,
      venue_id: "hyperliquid",
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
      venue_id: "hyperliquid",
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

  it.each([
    ["aster", "/venues/aster/orders"],
    ["lighter", "/venues/lighter/orders"],
  ] as const)("binds %s submit route and vault before fetch", async (venueId, submitPath) => {
    process.env.GHOLA_V6_HYPERLIQUID_PILOT_ENABLED = "true";
    const env = {
      NODE_ENV: "production",
      GHOLA_V6_HYPERLIQUID_PILOT_ENABLED: "true",
      ...(venueId === "aster"
        ? { PRIVATE_AGENT_ASTER_ALLOW_MAINNET: "true", PRIVATE_AGENT_ASTER_LIVE_MODE: "full_ticket" }
        : { PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET: "true", PRIVATE_AGENT_LIGHTER_LIVE_MODE: "full_ticket" }),
      GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL: "https://worker.ghola.test",
      GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_TOKEN: "worker-token-test",
      GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_READINESS: "ready",
    };
    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () => Response.json({
      ok: true,
      venue_id: venueId,
      platform_class: "hyperliquid_style_market",
      work_order_commitment: `connector_work_order_placeholder`,
      provider_ref_commitment: `${venueId}_provider_ref_test`,
    }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const account = createPrivateExecutionAccount({ vaultReady: true });
    const action = createPrivateAccountAction({ action_class: "trade_on_platform", product_bucket: "perps", now: NOW });
    const manifest = getConnectorManifest("hyperliquid_style_market", NOW);
    const readiness = await connectorReadiness({
      manifest,
      venue_id: venueId,
      now: NOW,
      env,
      execution_mode: "byo_api_key",
      execution_vault_ready: true,
      shielded_funding_ready: true,
    });
    expect(readiness.status).toBe("ready");
    const compiled = compilePrivateConnectorIntent({
      intent_id: `intent_${venueId}_1`,
      account_commitment: account.account_commitment,
      action_commitment: action.action_commitment,
      action_class: action.action_class,
      platform_class: "hyperliquid_style_market",
      venue_id: venueId,
      product_bucket: "perps",
      manifest,
      safe_input: {
        venue_id: venueId,
        amount_bucket: "25",
        asset_bucket: "BTC",
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
      intent_id: `intent_${venueId}_1`,
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
    fetchMock.mockImplementation(async () => Response.json({
      ok: true,
      venue_id: venueId,
      platform_class: "hyperliquid_style_market",
      work_order_commitment: workOrder.work_order_commitment,
      provider_ref_commitment: `${venueId}_provider_ref_test`,
    }, { status: 202 }));
    const submit = (vaultVenue?: "aster" | "lighter") => submitConnectorWorkOrder({
      work_order: workOrder,
      manifest,
      compiled_intent: compiled.compiled_intent,
      preview,
      readiness,
      venue_execution_vault: vaultVenue ? {
        venue_id: vaultVenue,
        execution_mode: "byo_api_key",
        vault_commitment: `vault_${vaultVenue}`,
        encrypted_vault_commitment: `encrypted_${vaultVenue}`,
        policy_commitment: `policy_${vaultVenue}`,
        encrypted_execution_vault: { ciphertext: `sealed-${vaultVenue}` },
      } : null,
      encrypted_execution_instruction_bundle: { ciphertext: `instruction-${venueId}` },
      env,
      now: NOW,
    });

    expect(await submit()).toEqual({ ok: false, error: "connector_submit_blocked" });
    const wrongVenue = venueId === "aster" ? "lighter" : "aster";
    expect(await submit(wrongVenue)).toEqual({ ok: false, error: "connector_submit_blocked" });
    expect(fetchMock).not.toHaveBeenCalled();

    const submitted = await submit(venueId);
    expect(submitted.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`https://worker.ghola.test${submitPath}`);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      venue_id: venueId,
      platform_class: "hyperliquid_style_market",
      vault_commitment: `vault_${venueId}`,
      encrypted_execution_vault: { ciphertext: `sealed-${venueId}` },
    });

    fetchMock.mockResolvedValueOnce(Response.json({
      ok: true,
      venue_id: wrongVenue,
      platform_class: "hyperliquid_style_market",
      work_order_commitment: workOrder.work_order_commitment,
    }, { status: 202 }));
    expect(await submit(venueId)).toEqual({ ok: false, error: "connector_submit_ambiguous" });
  });

  it.each([
    ["aster", "/venues/aster/verify"],
    ["lighter", "/venues/lighter/verify"],
  ] as const)("binds %s no-submit route and response proof", async (venueId, verifyPath) => {
    process.env.GHOLA_V6_HYPERLIQUID_PILOT_ENABLED = "true";
    const env = {
      NODE_ENV: "production",
      GHOLA_V6_HYPERLIQUID_PILOT_ENABLED: "true",
      ...(venueId === "aster"
        ? { PRIVATE_AGENT_ASTER_ALLOW_MAINNET: "true", PRIVATE_AGENT_ASTER_LIVE_MODE: "full_ticket" }
        : { PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET: "true", PRIVATE_AGENT_LIGHTER_LIVE_MODE: "full_ticket" }),
      GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL: "https://worker.ghola.test",
      GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_TOKEN: "worker-token-test",
      GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_READINESS: "ready",
    };
    const manifest = getConnectorManifest("hyperliquid_style_market", NOW);
    const readiness = await connectorReadiness({
      manifest,
      venue_id: venueId,
      now: NOW,
      env,
      execution_mode: "byo_api_key",
      execution_vault_ready: true,
      shielded_funding_ready: true,
    });
    const workOrderCommitment = `work_order_${venueId}`;
    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () => Response.json({
      status: "verified_ready",
      venue_id: venueId,
      platform_class: "hyperliquid_style_market",
      work_order_commitment: workOrderCommitment,
      checks: exactPerpsNoSubmitChecks(venueId),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const verify = () => verifyConnectorNoSubmit({
      platform_class: "hyperliquid_style_market",
      manifest,
      readiness,
      work_order_commitment: workOrderCommitment,
      operation_class: "limit_order",
      venue_execution_vault: {
        venue_id: venueId,
        execution_mode: "byo_api_key",
        vault_commitment: `vault_${venueId}`,
        encrypted_vault_commitment: `encrypted_${venueId}`,
        policy_commitment: `policy_${venueId}`,
        encrypted_execution_vault: { ciphertext: `sealed-${venueId}` },
      },
      encrypted_execution_instruction_bundle: { ciphertext: `instruction-${venueId}` },
      now: NOW,
      env,
    });

    expect((await verify()).status).toBe("verified_no_funds");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`https://worker.ghola.test${verifyPath}`);
    fetchMock.mockResolvedValueOnce(Response.json({
      status: "verified_no_funds",
      venue_id: venueId === "aster" ? "lighter" : "aster",
      platform_class: "hyperliquid_style_market",
      work_order_commitment: workOrderCommitment,
      checks: exactPerpsNoSubmitChecks(venueId),
    }));
    const tampered = await verify();
    expect(tampered.status).toBe("failed");
    expect(tampered.reason).toBe("venue_response_mismatch");

    const incompleteChecks = exactPerpsNoSubmitChecks(venueId);
    delete incompleteChecks.order_request_checked;
    fetchMock.mockResolvedValueOnce(Response.json({
      status: "verified_no_funds",
      venue_id: venueId,
      platform_class: "hyperliquid_style_market",
      work_order_commitment: workOrderCommitment,
      checks: incompleteChecks,
    }));
    expect(await verify()).toMatchObject({
      status: "failed",
      reason: "mandatory_no_submit_checks_incomplete",
    });

    fetchMock.mockResolvedValueOnce(Response.json({
      status: "verified_no_funds",
      venue_id: venueId,
      platform_class: "hyperliquid_style_market",
      work_order_commitment: workOrderCommitment,
      checks: { ...exactPerpsNoSubmitChecks(venueId), account_state_checked: false },
    }));
    expect(await verify()).toMatchObject({
      status: "failed",
      reason: "mandatory_no_submit_check_failed",
    });

    fetchMock.mockResolvedValueOnce(Response.json({
      status: "verified_no_funds",
      venue_id: venueId,
      platform_class: "hyperliquid_style_market",
      work_order_commitment: workOrderCommitment,
      checks: { ...exactPerpsNoSubmitChecks(venueId), transaction_broadcast: true },
    }));
    expect(await verify()).toMatchObject({
      status: "failed",
      reason: "transaction_broadcast_not_false",
    });

    const missingBroadcastCheck = exactPerpsNoSubmitChecks(venueId);
    delete missingBroadcastCheck.transaction_broadcast;
    fetchMock.mockResolvedValueOnce(Response.json({
      status: "verified_no_funds",
      venue_id: venueId,
      platform_class: "hyperliquid_style_market",
      work_order_commitment: workOrderCommitment,
      checks: missingBroadcastCheck,
    }));
    expect(await verify()).toMatchObject({
      status: "failed",
      reason: "transaction_broadcast_not_false",
    });
  });

  it("submits managed Hyperliquid testnet allocations without encrypted vault material", async () => {
    process.env.GHOLA_V6_HYPERLIQUID_PILOT_ENABLED = "true";
    const env = {
      NODE_ENV: "production",
      GHOLA_V6_HYPERLIQUID_PILOT_ENABLED: "true",
      GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL: "https://worker.ghola.test",
      GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_TOKEN: "worker-token-test",
      GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_READINESS: "ready",
      GHOLA_PRIVATE_RUNTIME_URL: "https://runtime.ghola.test",
      GHOLA_PRIVATE_RUNTIME_MEASUREMENT: "measurement-test",
    };
    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      return Response.json({
        ok: true,
        venue_id: request.venue_id,
        platform_class: request.platform_class,
        work_order_commitment: request.work_order_commitment,
        provider_ref_commitment: "hyperliquid_provider_ref_managed",
        result_commitment: "hyperliquid_result_managed",
      }, { status: 202 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const account = createPrivateExecutionAccount({ vaultReady: true });
    const action = createPrivateAccountAction({ action_class: "trade_on_platform", product_bucket: "perps", now: NOW });
    const manifest = getConnectorManifest("hyperliquid_style_market", NOW);
    const readiness = await connectorReadiness({
      manifest,
      venue_id: "hyperliquid",
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
      venue_id: "hyperliquid",
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

  it("maps a deterministic Hyperliquid worker policy rejection separately from an ambiguous submit", async () => {
    process.env.GHOLA_V6_HYPERLIQUID_PILOT_ENABLED = "true";
    const env = {
      NODE_ENV: "production",
      GHOLA_V6_HYPERLIQUID_PILOT_ENABLED: "true",
      GHOLA_HYPERLIQUID_LIVE_MODE: "tiny_fill",
      GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL: "https://worker.ghola.test",
      GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_TOKEN: "worker-token-test",
      GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_READINESS: "ready",
      GHOLA_PRIVATE_RUNTIME_URL: "https://runtime.ghola.test",
      GHOLA_PRIVATE_RUNTIME_MEASUREMENT: "measurement-test",
    };
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({
        error: "hyperliquid live order must use tiny_fill mode",
      }, { status: 400 }),
    ));

    const account = createPrivateExecutionAccount({ vaultReady: true });
    const action = createPrivateAccountAction({ action_class: "trade_on_platform", product_bucket: "perps", now: NOW });
    const manifest = getConnectorManifest("hyperliquid_style_market", NOW);
    const readiness = await connectorReadiness({
      manifest,
      venue_id: "hyperliquid",
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
      venue_id: "hyperliquid",
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
