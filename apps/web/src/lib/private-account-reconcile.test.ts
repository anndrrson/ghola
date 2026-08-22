import { afterEach, describe, expect, it, vi } from "vitest";
import { createHyperliquidExecutionVault } from "./private-account";
import {
  getConnectorManifest,
  reconcileConnectorResult,
  type GholaConnectorWorkOrder,
} from "./private-account-connectors";

const NOW = new Date("2026-08-22T10:00:00.000Z");

afterEach(() => vi.unstubAllGlobals());

function workOrder(): GholaConnectorWorkOrder {
  const manifest = getConnectorManifest("hyperliquid_style_market", NOW);
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
    platform_class: "hyperliquid_style_market",
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

function env() {
  return {
    NODE_ENV: "production",
    GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL: "https://worker.test",
    GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_TOKEN: "test-token",
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
    checked_at: NOW.toISOString(),
  };
}

describe("Hyperliquid reconciliation protocol", () => {
  it("keeps legacy worker reconciliation ambiguous", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      status: "reconciled",
      provider_ref_commitment: "legacy_provider",
      final_proof: proof("connector_execution_reconciliation_v1"),
    })));
    const result = await reconcileConnectorResult({
      work_order: workOrder(),
      manifest: getConnectorManifest("hyperliquid_style_market", NOW),
      hyperliquid_execution_vault: vault(),
      env: env(),
      now: NOW,
    });
    expect(result.status).toBe("ambiguous");
    expect(result.reason).toBe("connector_submit_ambiguous");
  });

  it("accepts only proof-v2 venue order-status reconciliation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      status: "reconciled",
      execution_protocol: "ghola-hyperliquid-proof-v2",
      provider_ref_commitment: "proof_v2_provider",
      final_proof: proof("hyperliquid_order_status_reconciliation_v1"),
    })));
    const result = await reconcileConnectorResult({
      work_order: workOrder(),
      manifest: getConnectorManifest("hyperliquid_style_market", NOW),
      hyperliquid_execution_vault: vault(),
      env: env(),
      now: NOW,
    });
    expect(result.status).toBe("reconciled");
    expect(result.final_proof?.final_fill_proven).toBe(true);
  });
});
