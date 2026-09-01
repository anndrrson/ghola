import { afterEach, describe, expect, it, vi } from "vitest";
import { createHyperliquidExecutionVault } from "./private-account";
import {
  getConnectorManifest,
  reconcileConnectorResult,
  type GholaConnectorWorkOrder,
} from "./private-account-connectors";

const NOW = new Date("2026-08-22T10:00:00.000Z");

afterEach(() => vi.unstubAllGlobals());

function workOrder(
  platformClass: GholaConnectorWorkOrder["platform_class"] = "hyperliquid_style_market",
  venueId: GholaConnectorWorkOrder["venue_id"] = platformClass === "coinbase_style_provider"
    ? "coinbase_advanced"
    : "hyperliquid",
): GholaConnectorWorkOrder {
  const manifest = getConnectorManifest(platformClass, NOW);
  return {
    version: 1,
    work_order_commitment: "connector_work_order_protocol_test",
    owner_commitment: "owner_test",
    intent_id: "intent_test",
    account_commitment: "account_test",
    action_commitment: "action_test",
    preview_commitment: "preview_test",
    approval_commitment: "approval_test",
    execution_plan_commitment: null,
    platform_class: platformClass,
    venue_id: venueId,
    selected_rail: "direct_public_fallback",
    manifest_commitment: manifest.manifest_commitment,
    connector_readiness_commitment: "readiness_test",
    compiler_commitment: "compiler_test",
    linkability_score_commitment: "linkability_test",
    platform_funding_account_commitment: "funding_test",
    rotation_commitment: "rotation_test",
    status: "ambiguous",
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
}

function vault() {
  const created = createHyperliquidExecutionVault({
    account_commitment: "account_test",
    encrypted_execution_vault: {
      ciphertext: "sealed",
      recipient: "phala:cvm:test",
      aad: "ghola/hyperliquid-execution-vault-v1",
    },
    now: NOW,
  });
  if (!created.ok) throw new Error("test vault creation failed");
  return created.vault;
}

function venueVault(venueId: "aster" | "lighter" | "coinbase_advanced") {
  return {
    venue_id: venueId,
    execution_mode: "byo_api_key",
    account_commitment: "account_test",
    vault_commitment: `vault_${venueId}`,
    encrypted_vault_commitment: `encrypted_${venueId}`,
    policy_commitment: `policy_${venueId}`,
    allocation_commitment: null,
    encrypted_execution_vault: {
      alg: "sealed-provider-v1",
      ciphertext: `sealed-${venueId}`,
      recipient: "phala:cvm:test",
      aad: `ghola/${venueId}-execution-vault-v1`,
    },
  };
}

function reconcileInstruction(venueId: "aster" | "lighter") {
  return {
    alg: "sealed-provider-v1",
    ciphertext: `sealed-reconcile-${venueId}`,
    recipient: "phala:cvm:test",
    aad: `ghola/private-execution-instruction-v1|work_order:${workOrder("hyperliquid_style_market", venueId).work_order_commitment}|venue:${venueId}|recipient:phala:cvm:test`,
  };
}

function env() {
  return {
    NODE_ENV: "production",
    GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL: "https://worker.test",
    GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_TOKEN: "test-token",
    GHOLA_CONNECTOR_COINBASE_STYLE_PROVIDER_URL: "https://worker.test",
    GHOLA_CONNECTOR_COINBASE_STYLE_PROVIDER_TOKEN: "test-token",
    GHOLA_CONNECTOR_SOLANA_SWAP_AGGREGATOR_URL: "https://worker.test",
    GHOLA_CONNECTOR_SOLANA_SWAP_AGGREGATOR_TOKEN: "test-token",
  };
}

function proof(proofKind: string) {
  return {
    version: 1,
    proof_kind: proofKind,
    status: "filled",
    venue_id: "hyperliquid",
    broadcast_performed: true,
    final_venue_execution_proven: true,
    final_fill_proven: true,
    cumulative_filled_micro_usdc: 11_000_000,
    filled_base_size: "0.25",
    target_client_order_matched: true,
    checked_at: NOW.toISOString(),
  };
}

describe("Hyperliquid reconciliation protocol", () => {
  it("does not honor a local-test connector flag in production", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await reconcileConnectorResult({
      work_order: workOrder(),
      manifest: getConnectorManifest("hyperliquid_style_market", NOW),
      venue_id: "hyperliquid",
      env: {
        NODE_ENV: "production",
        GHOLA_CONNECTOR_MODE: "local_test",
      },
      now: NOW,
    });
    expect(result.status).toBe("ambiguous");
    expect(result.reason).toBe("connector_endpoint_missing");
    expect(result.final_proof).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not synthesize reconciliation for a local-test flag without test runtime evidence", async () => {
    const result = await reconcileConnectorResult({
      work_order: workOrder(),
      manifest: getConnectorManifest("hyperliquid_style_market", NOW),
      venue_id: "hyperliquid",
      env: { GHOLA_SHIELDED_POOL_MODE: "local_test" },
      now: NOW,
    });
    expect(result.status).toBe("ambiguous");
    expect(result.reason).toBe("local_test_reconcile_disabled");
    expect(result.final_proof).toBeNull();
  });

  it("keeps legacy worker reconciliation ambiguous", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      status: "reconciled",
      work_order_commitment: workOrder().work_order_commitment,
      provider_ref_commitment: "legacy_provider",
      final_proof: proof("connector_execution_reconciliation_v1"),
    })));
    const result = await reconcileConnectorResult({
      work_order: workOrder(),
      manifest: getConnectorManifest("hyperliquid_style_market", NOW),
      venue_id: "hyperliquid",
      hyperliquid_execution_vault: vault(),
      env: env(),
      now: NOW,
    });
    expect(result.status).toBe("ambiguous");
    expect(result.reason).toBe("connector_submit_ambiguous");
  });

  it("accepts only proof-v2 venue order-status reconciliation", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      status: "reconciled",
      work_order_commitment: workOrder().work_order_commitment,
      execution_protocol: "ghola-hyperliquid-proof-v2",
      provider_ref_commitment: "proof_v2_provider",
      final_proof: proof("hyperliquid_order_status_reconciliation_v1"),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await reconcileConnectorResult({
      work_order: workOrder(),
      manifest: getConnectorManifest("hyperliquid_style_market", NOW),
      venue_id: "hyperliquid",
      hyperliquid_execution_vault: vault(),
      env: env(),
      now: NOW,
    });
    expect(result.status).toBe("reconciled");
    expect(result.final_proof?.final_fill_proven).toBe(true);
    const [url, request] = fetchMock.mock.calls[0] as unknown as [
      RequestInfo | URL,
      RequestInit,
    ];
    expect(String(url)).toBe("https://worker.test/hyperliquid/reconcile");
    expect(JSON.parse(String(request?.body))).toMatchObject({
      venue_id: "hyperliquid",
      platform_class: "hyperliquid_style_market",
      operation_class: "reconcile",
      account_commitment: "account_test",
    });
  });

  it("keeps a mismatched work-order proof ambiguous", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      status: "reconciled",
      work_order_commitment: "connector_work_order_wrong",
      execution_protocol: "ghola-hyperliquid-proof-v2",
      final_proof: proof("hyperliquid_order_status_reconciliation_v1"),
    })));
    const result = await reconcileConnectorResult({
      work_order: workOrder(),
      manifest: getConnectorManifest("hyperliquid_style_market", NOW),
      venue_id: "hyperliquid",
      hyperliquid_execution_vault: vault(),
      env: env(),
      now: NOW,
    });
    expect(result.status).toBe("ambiguous");
  });
});

describe("all-venue reconciliation proof gates", () => {
  it.each([
    ["aster", "/venues/aster/reconcile", "aster_client_order_reconciliation_v1"],
    ["lighter", "/venues/lighter/reconcile", "lighter_client_order_index_reconciliation_v1"],
  ] as const)("binds %s reconciliation route, vault, instruction, and proof", async (
    venueId,
    path,
    proofKind,
  ) => {
    const order = workOrder("hyperliquid_style_market", venueId);
    const fetchMock = vi.fn(async () => Response.json({
      status: "reconciled",
      venue_id: venueId,
      work_order_commitment: order.work_order_commitment,
      final_proof: {
        ...proof(proofKind),
        venue_id: venueId,
        broadcast_performed: false,
        original_order_target_matched: true,
      },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const instruction = reconcileInstruction(venueId);
    const result = await reconcileConnectorResult({
      work_order: order,
      manifest: getConnectorManifest("hyperliquid_style_market", NOW),
      venue_id: venueId,
      venue_execution_vault: venueVault(venueId),
      encrypted_execution_instruction_bundle: instruction,
      env: env(),
      now: NOW,
    });
    expect(result.status).toBe("reconciled");
    const [url, request] = fetchMock.mock.calls[0] as unknown as [
      RequestInfo | URL,
      RequestInit,
    ];
    expect(String(url)).toBe(`https://worker.test${path}`);
    expect(JSON.parse(String(request?.body))).toMatchObject({
      venue_id: venueId,
      platform_class: "hyperliquid_style_market",
      operation_class: "reconcile",
      execution_mode: "byo_api_key",
      account_commitment: "account_test",
      vault_commitment: `vault_${venueId}`,
      encrypted_execution_vault: venueVault(venueId).encrypted_execution_vault,
      encrypted_execution_instruction_bundle: instruction,
    });
  });

  it("rejects a cross-venue proof for an exact Lighter reconciliation", async () => {
    const order = workOrder("hyperliquid_style_market", "lighter");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      status: "reconciled",
      venue_id: "aster",
      work_order_commitment: order.work_order_commitment,
      final_proof: {
        ...proof("aster_client_order_reconciliation_v1"),
        venue_id: "aster",
        broadcast_performed: false,
        original_order_target_matched: true,
      },
    })));
    const result = await reconcileConnectorResult({
      work_order: order,
      manifest: getConnectorManifest("hyperliquid_style_market", NOW),
      venue_id: "lighter",
      venue_execution_vault: venueVault("lighter"),
      encrypted_execution_instruction_bundle: reconcileInstruction("lighter"),
      env: env(),
      now: NOW,
    });
    expect(result.status).toBe("ambiguous");
  });

  it("fails closed before fetch when the venue does not match the platform", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await reconcileConnectorResult({
      work_order: workOrder("coinbase_style_provider"),
      manifest: getConnectorManifest("coinbase_style_provider", NOW),
      venue_id: "lighter",
      venue_execution_vault: venueVault("lighter"),
      encrypted_execution_instruction_bundle: reconcileInstruction("lighter"),
      env: env(),
      now: NOW,
    });
    expect(result.status).toBe("ambiguous");
    expect(result.reason).toBe("connector_reconcile_venue_mismatch");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed before fetch for a legacy work order with no venue", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const legacyOrder = {
      ...workOrder("hyperliquid_style_market", "lighter"),
      venue_id: null as unknown as GholaConnectorWorkOrder["venue_id"],
    };
    const result = await reconcileConnectorResult({
      work_order: legacyOrder,
      manifest: getConnectorManifest("hyperliquid_style_market", NOW),
      venue_id: "lighter",
      venue_execution_vault: venueVault("lighter"),
      encrypted_execution_instruction_bundle: reconcileInstruction("lighter"),
      env: env(),
      now: NOW,
    });
    expect(result.status).toBe("ambiguous");
    expect(result.reason).toBe("connector_reconcile_venue_mismatch");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects generic Coinbase 2xx reconciliation", async () => {
    const order = workOrder("coinbase_style_provider");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      status: "reconciled",
      work_order_commitment: order.work_order_commitment,
      final_proof: {
        ...proof("connector_execution_reconciliation_v1"),
        venue_id: "coinbase_advanced",
      },
    })));
    const result = await reconcileConnectorResult({
      work_order: order,
      manifest: getConnectorManifest("coinbase_style_provider", NOW),
      venue_id: "coinbase_advanced",
      env: env(),
      now: NOW,
    });
    expect(result.status).toBe("ambiguous");
  });

  it("accepts only exact terminal Coinbase order proof", async () => {
    const order = workOrder("coinbase_style_provider");
    const fetchMock = vi.fn(async () => Response.json({
      status: "reconciled",
      venue_id: "coinbase_advanced",
      work_order_commitment: order.work_order_commitment,
      final_proof: {
        ...proof("coinbase_advanced_order_state_v1"),
        venue_id: "coinbase_advanced",
        target_order_matched: true,
        target_client_order_matched: true,
        target_product_matched: true,
        original_order_target_matched: true,
      },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await reconcileConnectorResult({
      work_order: order,
      manifest: getConnectorManifest("coinbase_style_provider", NOW),
      venue_id: "coinbase_advanced",
      venue_execution_vault: venueVault("coinbase_advanced"),
      env: env(),
      now: NOW,
    });
    expect(result.status).toBe("reconciled");
    const [url, request] = fetchMock.mock.calls[0] as unknown as [
      RequestInfo | URL,
      RequestInit,
    ];
    expect(String(url)).toBe("https://worker.test/venues/coinbase/reconcile");
    expect(JSON.parse(String(request?.body))).toMatchObject({
      venue_id: "coinbase_advanced",
      platform_class: "coinbase_style_provider",
      operation_class: "reconcile",
      account_commitment: "account_test",
      vault_commitment: "vault_coinbase_advanced",
    });
  });

  it("does not treat a Jupiter broadcast signature as terminal reconciliation", async () => {
    const order = workOrder("solana_swap_aggregator");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      status: "reconciled",
      work_order_commitment: order.work_order_commitment,
      final_proof: {
        ...proof("jupiter_swap_execution_proof_v1"),
        venue_id: "jupiter",
        signature_commitment: "jupiter_signature_test",
      },
    })));
    const result = await reconcileConnectorResult({
      work_order: order,
      manifest: getConnectorManifest("solana_swap_aggregator", NOW),
      venue_id: "hyperliquid",
      env: env(),
      now: NOW,
    });
    expect(result.status).toBe("ambiguous");
  });
});
