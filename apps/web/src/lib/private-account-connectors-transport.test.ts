import { describe, expect, it } from "vitest";
import {
  getConnectorManifest,
  reconcileConnectorResult,
  verifyConnectorNoSubmit,
  type GholaConnectorReadiness,
  type GholaConnectorWorkOrder,
} from "./private-account-connectors";

const now = new Date("2026-08-12T12:00:00.000Z");

describe("private-account connector transport policy", () => {
  it("blocks verify and reconcile POSTs when tests inherit live-looking flags", async () => {
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const manifest = getConnectorManifest("hyperliquid_style_market", now);
    const env = {
      NODE_ENV: "production",
      VERCEL_ENV: "production",
      GHOLA_PRIVATE_AGENT_SPEND_ARMED: "true",
      GHOLA_CONNECTOR_MODE: "http",
      GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL: "https://worker.example",
      GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_TOKEN: "token",
      GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_READINESS: "ready",
    };

    const verification = await verifyConnectorNoSubmit({
      platform_class: manifest.platform_class,
      manifest,
      readiness: readyReadiness(manifest.manifest_commitment),
      work_order_commitment: "work_order_transport_policy",
      operation_class: "limit_order",
      venue_execution_vault: {
        venue_id: "hyperliquid",
        execution_mode: "byo_api_key",
        vault_commitment: "vault_commitment",
        encrypted_vault_commitment: "encrypted_vault_commitment",
        policy_commitment: "policy_commitment",
        encrypted_execution_vault: { ciphertext: "sealed" },
      },
      encrypted_execution_instruction_bundle: { ciphertext: "sealed_instruction" },
      env,
      fetchImpl,
      now,
    });
    const reconciled = await reconcileConnectorResult({
      work_order: workOrder(manifest.manifest_commitment),
      manifest,
      env,
      fetchImpl,
      now,
    });

    expect(verification).toMatchObject({
      status: "failed",
      reason: "private_agent_transport_blocked",
    });
    expect(reconciled).toMatchObject({
      status: "failed",
      reason: "private_agent_transport_blocked",
    });
    expect(fetchCalls).toBe(0);
  });

  it("preserves pure local-test verification and reconciliation without transport", async () => {
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const manifest = getConnectorManifest("hyperliquid_style_market", now);
    const env = { NODE_ENV: "test", GHOLA_CONNECTOR_MODE: "local_test" };

    const verification = await verifyConnectorNoSubmit({
      platform_class: manifest.platform_class,
      manifest,
      readiness: readyReadiness(manifest.manifest_commitment),
      work_order_commitment: "work_order_local_test",
      operation_class: "limit_order",
      venue_execution_vault: {
        venue_id: "hyperliquid",
        execution_mode: "byo_api_key",
        vault_commitment: "vault_commitment",
        encrypted_vault_commitment: "encrypted_vault_commitment",
        policy_commitment: "policy_commitment",
        encrypted_execution_vault: { ciphertext: "sealed" },
      },
      encrypted_execution_instruction_bundle: { ciphertext: "sealed_instruction" },
      env,
      fetchImpl,
      now,
    });
    const reconciled = await reconcileConnectorResult({
      work_order: workOrder(manifest.manifest_commitment),
      manifest,
      env,
      fetchImpl,
      now,
    });

    expect(verification.status).toBe("verified_no_funds");
    expect(reconciled.status).toBe("reconciled");
    expect(fetchCalls).toBe(0);
  });
});

function readyReadiness(manifestCommitment: string): GholaConnectorReadiness {
  return {
    version: 1,
    platform_class: "hyperliquid_style_market",
    status: "ready",
    mode: "http",
    manifest_commitment: manifestCommitment,
    readiness_commitment: "readiness_commitment",
    live_submit_enabled: true,
    reason_codes: [],
    checked_at: now.toISOString(),
  };
}

function workOrder(manifestCommitment: string): GholaConnectorWorkOrder {
  return {
    version: 1,
    work_order_commitment: "work_order_transport_policy",
    owner_commitment: "owner_transport_policy",
    intent_id: "intent_transport_policy",
    account_commitment: "account_transport_policy",
    action_commitment: "action_transport_policy",
    preview_commitment: "preview_transport_policy",
    approval_commitment: null,
    execution_plan_commitment: null,
    platform_class: "hyperliquid_style_market",
    selected_rail: "direct_public_fallback",
    manifest_commitment: manifestCommitment,
    connector_readiness_commitment: "readiness_commitment",
    compiler_commitment: "compiler_commitment",
    linkability_score_commitment: "linkability_commitment",
    platform_fee_policy_commitment: null,
    platform_funding_account_commitment: "funding_account_commitment",
    rotation_commitment: "rotation_commitment",
    status: "submitted",
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
}
