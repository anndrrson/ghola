import { describe, expect, it } from "vitest";
import { connectorExecutionCachedResultBindingValid } from "@/app/v1/private-account/_lib";

type BindingInput = Parameters<typeof connectorExecutionCachedResultBindingValid>[0];

function exactBinding(): BindingInput {
  return {
    owner_commitment: "owner_exact",
    work_order_record: {
      work_order_commitment: "work_order_exact",
      platform_class: "hyperliquid_style_market",
      venue_id: "hyperliquid",
    },
    result_record: {
      owner_commitment: "owner_exact",
      work_order_commitment: "work_order_exact",
      platform_class: "hyperliquid_style_market",
      result: {
        version: 1,
        connector_result_commitment: "connector_result_exact",
        work_order_commitment: "work_order_exact",
        platform_class: "hyperliquid_style_market",
        venue_id: "hyperliquid",
        status: "submitted",
        provider_ref_commitment: null,
        result_commitment: "result_exact",
        final_proof: null,
        visibility_summary: {
          main_wallet_exposed: false,
          venue_saw_order_class: true,
          public_chain_settlement: "hidden",
        },
        venue_access_summary: {
          venue_access_source: "user_provided_credentials",
          ghola_access_role: "connector_only",
          venue_gate: "venue_accepts_or_rejects_credentials",
          venue_visibility: "execution_account_and_order_activity",
          source_wallet_visibility: "not_exposed_to_public_chain_by_ghola",
          privacy_claim: "venue_visible_order_degraded",
        },
        reason: null,
        created_at: "2026-09-01T12:00:00.000Z",
        updated_at: "2026-09-01T12:00:00.000Z",
      },
    },
  };
}

describe("cached connector execution result binding", () => {
  it("accepts only the exact owner, work-order, platform, and venue binding", () => {
    expect(connectorExecutionCachedResultBindingValid(exactBinding())).toBe(true);
  });

  it.each([
    ["owner", (input: BindingInput) => { input.result_record.owner_commitment = "owner_other"; }],
    ["outer work order", (input: BindingInput) => { input.result_record.work_order_commitment = "work_order_other"; }],
    ["inner work order", (input: BindingInput) => { input.result_record.result.work_order_commitment = "work_order_other"; }],
    ["outer platform", (input: BindingInput) => { input.result_record.platform_class = "coinbase_style_provider"; }],
    ["inner platform", (input: BindingInput) => { input.result_record.result.platform_class = "coinbase_style_provider"; }],
    ["null venue", (input: BindingInput) => {
      (input.result_record.result as { venue_id: string | null }).venue_id = null;
    }],
    ["cross venue", (input: BindingInput) => { input.result_record.result.venue_id = "aster"; }],
  ])("rejects a mismatched %s", (_name, mutate) => {
    const input = exactBinding();
    mutate(input);
    expect(connectorExecutionCachedResultBindingValid(input)).toBe(false);
  });
});
