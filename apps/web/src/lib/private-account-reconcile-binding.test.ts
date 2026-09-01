import { afterEach, describe, expect, it } from "vitest";
import {
  connectorReconcileFromBody,
  type PrivateAccountRequestOwner,
} from "@/app/v1/private-account/_lib";
import {
  getConnectorManifest,
  reconcileConnectorResult,
  type GholaConnectorResult,
  type GholaConnectorWorkOrder,
} from "./private-account-connectors";
import {
  putConnectorManifest,
  putConnectorResult,
  putConnectorWorkOrder,
  resetPrivateAccountStoreForTests,
  type PrivateConnectorResultRecordV1,
} from "./private-account-store";

const NOW = new Date("2026-09-01T12:00:00.000Z");
const owner: PrivateAccountRequestOwner = {
  owner_commitment: "owner_reconcile_binding_test",
  user: { id: "reconcile-binding-test", email: "reconcile-binding-test@example.com" },
};

afterEach(async () => resetPrivateAccountStoreForTests());

async function seededResult(input: {
  record?: Partial<PrivateConnectorResultRecordV1>;
  result?: Record<string, unknown>;
} = {}) {
  const manifest = getConnectorManifest("hyperliquid_style_market", NOW);
  const workOrder: GholaConnectorWorkOrder = {
    version: 1,
    work_order_commitment: "connector_work_order_binding_test",
    owner_commitment: owner.owner_commitment,
    intent_id: "intent_binding_test",
    account_commitment: "account_binding_test",
    action_commitment: "action_binding_test",
    preview_commitment: "preview_binding_test",
    approval_commitment: "approval_binding_test",
    execution_plan_commitment: null,
    platform_class: "hyperliquid_style_market",
    venue_id: "hyperliquid",
    selected_rail: "direct_public_fallback",
    manifest_commitment: manifest.manifest_commitment,
    connector_readiness_commitment: "readiness_binding_test",
    compiler_commitment: "compiler_binding_test",
    linkability_score_commitment: "linkability_binding_test",
    platform_funding_account_commitment: "funding_binding_test",
    rotation_commitment: "rotation_binding_test",
    status: "ambiguous",
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
  await putConnectorManifest({
    version: 1,
    manifest_commitment: manifest.manifest_commitment,
    platform_class: manifest.platform_class,
    manifest,
    status: "current",
    created_at: NOW.toISOString(),
    expires_at: manifest.expires_at,
    updated_at: NOW.toISOString(),
  });
  await putConnectorWorkOrder({
    version: 1,
    work_order_commitment: workOrder.work_order_commitment,
    owner_commitment: owner.owner_commitment,
    intent_id: workOrder.intent_id,
    account_commitment: workOrder.account_commitment,
    action_commitment: workOrder.action_commitment,
    preview_commitment: workOrder.preview_commitment,
    approval_commitment: workOrder.approval_commitment,
    execution_plan_commitment: null,
    platform_class: workOrder.platform_class,
    venue_id: workOrder.venue_id,
    status: workOrder.status,
    work_order: workOrder,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  });
  const baseResult = await reconcileConnectorResult({
    work_order: workOrder,
    manifest,
    venue_id: "hyperliquid",
    env: { NODE_ENV: "test" },
    now: NOW,
  });
  const record: PrivateConnectorResultRecordV1 = {
    version: 1,
    connector_result_commitment: baseResult.connector_result_commitment,
    work_order_commitment: workOrder.work_order_commitment,
    owner_commitment: owner.owner_commitment,
    intent_id: workOrder.intent_id,
    platform_class: workOrder.platform_class,
    status: baseResult.status,
    result: { ...baseResult, ...input.result } as GholaConnectorResult,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...input.record,
  };
  await putConnectorResult(record);
  return {
    body: {
      work_order_commitment: workOrder.work_order_commitment,
      connector_result_commitment: record.connector_result_commitment,
    },
  };
}

describe("connector reconciliation result binding", () => {
  it("hides and rejects a cross-owner result", async () => {
    const { body } = await seededResult({ record: { owner_commitment: "owner_other" } });
    await expect(connectorReconcileFromBody(body, owner)).resolves.toEqual({
      error: "connector_result_not_found",
    });
  });

  it.each([
    ["record work order", { record: { work_order_commitment: "connector_work_order_other" } }],
    ["embedded work order", { result: { work_order_commitment: "connector_work_order_other" } }],
    ["record platform", { record: { platform_class: "coinbase_style_provider" as const } }],
    ["embedded platform", { result: { platform_class: "coinbase_style_provider" } }],
    ["legacy null venue", { result: { venue_id: null } }],
    ["cross venue", { result: { venue_id: "aster" } }],
  ])("rejects a %s binding", async (_name, mutation) => {
    const { body } = await seededResult(mutation);
    await expect(connectorReconcileFromBody(body, owner)).resolves.toEqual({
      error: "connector_result_binding_mismatch",
    });
  });
});
