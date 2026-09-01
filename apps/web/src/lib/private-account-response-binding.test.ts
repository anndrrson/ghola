import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GholaPlatformClass,
  GholaPrivacyPreview,
  GholaVenueId,
} from "./private-account";
import {
  getConnectorManifest,
  submitConnectorWorkOrder,
  verifyConnectorNoSubmit,
  type GholaCompiledPrivateIntent,
  type GholaConnectorReadiness,
  type GholaConnectorWorkOrder,
} from "./private-account-connectors";

const NOW = new Date("2026-08-31T12:00:00.000Z");
const VENUES = [
  ["hyperliquid", "hyperliquid_style_market"],
  ["phoenix", "solana_perps_market"],
  ["drift", "solana_perps_market"],
  ["backpack", "solana_perps_market"],
  ["jupiter", "solana_swap_aggregator"],
  ["coinbase_advanced", "coinbase_style_provider"],
] as const satisfies ReadonlyArray<readonly [GholaVenueId, GholaPlatformClass]>;

describe("exact worker response binding", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(VENUES)("rejects missing or mismatched %s submit echoes", async (venueId, platformClass) => {
    const fixture = submitFixture(venueId, platformClass);
    const correct = responseBinding(venueId, platformClass, fixture.workOrder.work_order_commitment);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      ...correct,
      provider_ref_commitment: `provider_${venueId}`,
    }, { status: 202 })));
    expect((await submitConnectorWorkOrder(fixture.input)).ok).toBe(true);

    for (const field of ["venue_id", "work_order_commitment", "platform_class"] as const) {
      for (const mutation of ["missing", "mismatched"] as const) {
        const body: Record<string, unknown> = { ...correct };
        if (mutation === "missing") delete body[field];
        else body[field] = `wrong_${field}`;
        vi.stubGlobal("fetch", vi.fn(async () => Response.json(body, { status: 202 })));
        await expect(submitConnectorWorkOrder(fixture.input)).resolves.toEqual({
          ok: false,
          error: "connector_submit_ambiguous",
        });
      }
    }
  });

  it.each(VENUES)("rejects missing or mismatched %s no-submit echoes", async (venueId, platformClass) => {
    const fixture = noSubmitFixture(venueId, platformClass);
    const correct = {
      status: "verified_no_funds",
      ...responseBinding(venueId, platformClass, fixture.workOrderCommitment),
      checks: noSubmitChecks(venueId),
    };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(correct)));
    expect((await verifyConnectorNoSubmit(fixture.input)).status).toBe("verified_no_funds");

    for (const field of ["venue_id", "work_order_commitment", "platform_class"] as const) {
      for (const mutation of ["missing", "mismatched"] as const) {
        const body: Record<string, unknown> = { ...correct };
        if (mutation === "missing") delete body[field];
        else body[field] = `wrong_${field}`;
        vi.stubGlobal("fetch", vi.fn(async () => Response.json(body)));
        await expect(verifyConnectorNoSubmit(fixture.input)).resolves.toMatchObject({
          status: "failed",
          reason: "venue_response_mismatch",
        });
      }
    }
  });
});

function submitFixture(venueId: GholaVenueId, platformClass: GholaPlatformClass) {
  const manifest = getConnectorManifest(platformClass, NOW);
  const workOrderCommitment = `work_order_${venueId}_binding`;
  const readiness = connectorReadiness(venueId, platformClass, manifest.manifest_commitment);
  const compiledIntent: GholaCompiledPrivateIntent = {
    version: 1,
    compiler_version: "ghola-intent-compiler-v1",
    compiler_commitment: `compiler_${venueId}`,
    ticket_commitment: `ticket_${venueId}`,
    intent_id: `intent_${venueId}`,
    account_commitment: `account_${venueId}`,
    action_commitment: `action_${venueId}`,
    action_class: "trade_on_platform",
    platform_class: platformClass,
    venue_id: venueId,
    product_bucket: "perps",
    amount_bucket: "5",
    asset_bucket: "BTC",
    destination_class: "platform_subaccount",
    urgency_bucket: "standard",
    solver_count_bucket: "5+",
    manifest_commitment: manifest.manifest_commitment,
    runtime_payload_policy: "sealed_runtime_only",
    created_at: NOW.toISOString(),
  };
  const workOrder: GholaConnectorWorkOrder = {
    version: 1,
    work_order_commitment: workOrderCommitment,
    owner_commitment: "owner_binding",
    intent_id: compiledIntent.intent_id,
    account_commitment: compiledIntent.account_commitment,
    action_commitment: compiledIntent.action_commitment,
    preview_commitment: `preview_${venueId}`,
    approval_commitment: `approval_${venueId}`,
    execution_plan_commitment: null,
    platform_class: platformClass,
    venue_id: venueId,
    selected_rail: "shielded_pool",
    manifest_commitment: manifest.manifest_commitment,
    connector_readiness_commitment: readiness.readiness_commitment,
    compiler_commitment: compiledIntent.compiler_commitment,
    linkability_score_commitment: `linkability_${venueId}`,
    platform_funding_account_commitment: `funding_${venueId}`,
    rotation_commitment: `rotation_${venueId}`,
    status: "prepared",
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
  const preview = {
    preview_commitment: workOrder.preview_commitment,
    selected_rail: workOrder.selected_rail,
    claim_status: "private_mode_available",
  } as GholaPrivacyPreview;
  return {
    workOrder,
    input: {
      work_order: workOrder,
      manifest,
      compiled_intent: compiledIntent,
      preview,
      readiness,
      encrypted_execution_instruction_bundle: { ciphertext: `sealed_${venueId}` },
      now: NOW,
      env: connectorEnv(platformClass),
    },
  };
}

function noSubmitFixture(venueId: GholaVenueId, platformClass: GholaPlatformClass) {
  const manifest = getConnectorManifest(platformClass, NOW);
  const workOrderCommitment = `work_order_${venueId}_no_submit_binding`;
  return {
    workOrderCommitment,
    input: {
      platform_class: platformClass,
      manifest,
      readiness: connectorReadiness(venueId, platformClass, manifest.manifest_commitment),
      work_order_commitment: workOrderCommitment,
      operation_class: "limit_order",
      venue_execution_vault: {
        venue_id: venueId,
        execution_mode: "byo_api_key",
        policy_commitment: `policy_${venueId}`,
      },
      encrypted_execution_instruction_bundle: { ciphertext: `sealed_${venueId}` },
      now: NOW,
      env: connectorEnv(platformClass),
    },
  };
}

function connectorReadiness(
  venueId: GholaVenueId,
  platformClass: GholaPlatformClass,
  manifestCommitment: string,
): GholaConnectorReadiness {
  return {
    version: 1,
    platform_class: platformClass,
    venue_id: venueId,
    status: "ready",
    mode: "http",
    manifest_commitment: manifestCommitment,
    readiness_commitment: `readiness_${venueId}`,
    live_submit_enabled: true,
    reason_codes: [],
    checked_at: NOW.toISOString(),
  };
}

function connectorEnv(platformClass: GholaPlatformClass): Record<string, string> {
  const suffix = platformClass.toUpperCase();
  return {
    NODE_ENV: "production",
    [`GHOLA_CONNECTOR_${suffix}_URL`]: "https://worker.ghola.test",
    [`GHOLA_CONNECTOR_${suffix}_READINESS`]: "ready",
  };
}

function responseBinding(
  venueId: GholaVenueId,
  platformClass: GholaPlatformClass,
  workOrderCommitment: string,
) {
  return {
    venue_id: venueId,
    platform_class: platformClass,
    work_order_commitment: workOrderCommitment,
  };
}

function noSubmitChecks(venueId: GholaVenueId): Record<string, boolean> {
  const common = {
    sealed_vault_opened: true,
    sealed_instruction_opened: true,
    authority_derived: true,
    policy_enforced: true,
    live_gate_enforced: true,
    transaction_broadcast: false,
  };
  if (venueId === "hyperliquid") return {
    ...common,
    api_wallet_loaded: true,
    hyperliquid_api_reachable: true,
    hyperliquid_sdk_ready: true,
    account_read_checked: true,
    order_request_built: true,
    live_venue_checked: true,
  };
  if (venueId === "backpack") return {
    ...common,
    rpc_reachable: true,
    backpack_rest_ready: true,
    order_packet_built: true,
  };
  if (venueId === "phoenix" || venueId === "drift") return {
    ...common,
    rpc_reachable: true,
    phoenix_sdk_ready: true,
    order_packet_built: true,
  };
  if (venueId === "jupiter") return {
    ...common,
    order_request_built: true,
    jupiter_api_reachable: true,
    jupiter_token_allowlist_passed: true,
    jupiter_order_built: true,
    jupiter_transaction_built: true,
  };
  return {
    ...common,
    coinbase_api_reachable: true,
    coinbase_order_request_built: true,
  };
}
