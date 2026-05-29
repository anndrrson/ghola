import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getPrivateSettlement,
  putPrivateSettlement,
  resetPrivateAccountStoreForTests,
} from "@/lib/private-account-store";
import { POST as createIntent } from "../intent/route";
import { POST as runtimeEnvelopeAction } from "../runtime-envelope/route";
import { POST as previewAction } from "../privacy-preview/route";
import { POST as planAction } from "../plan/route";
import { POST as approveAction } from "../approve/route";
import { POST as settleAction } from "../settle/route";
import { POST as executeAction } from "./route";
import { POST as verifyReceiptAction } from "../verify-receipt/route";
import { POST as receiptAction } from "../receipt/route";
import { GET as receiptListAction } from "../receipts/route";
import { GET as receiptDetailAction } from "../receipts/[receipt_commitment]/route";
import { POST as receiptExportAction } from "../receipts/export/route";
import { POST as privateReceiptExportAction } from "../receipts/export-private/route";
import { POST as leakageMapAction } from "../leakage-map/route";
import { POST as queueAction } from "../queue/route";
import { POST as refreshQueue } from "../queue/refresh/route";
import { GET as canaryStatus } from "../../canaries/status/route";
import { POST as runCanaries } from "../../canaries/run/route";
import { POST as writeAnonymityEvidence } from "../../anonymity-evidence/route";
import { POST as createFundingInstruction } from "../../funding/instruction/route";
import { POST as importFunding } from "../../funding/import/route";
import { POST as runBatchCoordinator } from "../../funding/batch/run/route";

function auth(userId: string) {
  return `Bearer ${[
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: userId, email: `${userId}@example.com` })).toString("base64url"),
    "sig",
  ].join(".")}`;
}

const AUTH = auth("user_1");
const INTERNAL_TOKEN = "test_internal_private_account_token";

function request(path: string, body: unknown, auth = AUTH) {
  return new Request(`https://ghola.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify(body),
  });
}

function internalRequest(path: string, body: unknown) {
  return new Request(`https://ghola.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${INTERNAL_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
}

async function importCompatibleFunding(userId: string) {
  const instructionRes = await createFundingInstruction(
    request("/v1/private-account/funding/instruction", {
      action_class: "transfer",
      amount_bucket: "25",
      asset_bucket: "stablecoin",
    }, auth(userId)),
  );
  const instruction = await instructionRes.json();
  const importRes = await importFunding(
    request("/v1/private-account/funding/import", {
      funding_intent_id: instruction.instruction.funding_intent_id,
      receipt_id: `custom_receipt_${userId}`,
    }, auth(userId)),
  );
  expect(importRes.status).toBe(201);
}

async function happyPathInput(input: {
  action_class?: string;
  product_bucket?: string;
  platform_class?: string;
  requested_rail?: string;
} = {}) {
  await importCompatibleFunding("user_1");
  await importCompatibleFunding("user_2");
  const intentRes = await createIntent(
    request("/v1/private-account/actions/intent", {
      action_class: input.action_class || "transfer",
      product_bucket: input.product_bucket || "stablecoin",
      vault_ready: true,
    }),
  );
  const intent = await intentRes.json();
  const previewRes = await previewAction(
    request("/v1/private-account/actions/privacy-preview", {
      intent_id: intent.intent_id,
      platform_class: input.platform_class || "solana_private_balance",
      requested_rail: input.requested_rail || "shielded_pool",
    }),
  );
  const preview = await previewRes.json();
  expect(preview.preview.claim_status).toBe("wait_for_anonymity");
  const queueRes = await queueAction(
    request("/v1/private-account/actions/queue", {
      intent_id: intent.intent_id,
      preview_commitment: preview.preview.preview_commitment,
    }),
  );
  const queued = await queueRes.json();
  await runBatchCoordinator(
    internalRequest("/v1/private-account/funding/batch/run", {
      queue_id: queued.queued_action.queue_id,
    }),
  );
  const refreshedRes = await refreshQueue(
    request("/v1/private-account/actions/queue/refresh", {
      queue_id: queued.queued_action.queue_id,
    }),
  );
  const refreshed = await refreshedRes.json();
  const planRes = await planAction(
    request("/v1/private-account/actions/plan", {
      preview_commitment: refreshed.preview.preview_commitment,
    }),
  );
  const plan = await planRes.json();
  expect(planRes.status).toBe(201);
  expect(plan.plan.status).toBe(
    refreshed.preview.claim_status === "private_mode_available" ? "ready" : "degraded",
  );
  const approvalRes = await approveAction(
    request("/v1/private-account/actions/approve", {
      intent_id: intent.intent_id,
      preview_commitment: refreshed.preview.preview_commitment,
      execution_plan_commitment: plan.plan.plan_commitment,
    }),
  );
  const approval = await approvalRes.json();
  return { intent, preview: { preview: refreshed.preview }, plan, approval };
}

describe("private account stateful execution route", () => {
  afterEach(async () => {
    await resetPrivateAccountStoreForTests();
    delete process.env.GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN;
    delete process.env.GHOLA_CUSTOM_SHIELDED_VERIFIER_MODE;
    delete process.env.GHOLA_SHIELDED_POOL_MODE;
    delete process.env.GHOLA_PRIVATE_ACCOUNT_BATCH_MIN_DELAY_SECONDS;
    delete process.env.GHOLA_PRIVATE_ACCOUNT_BATCH_REQUIRED_SET;
  });

  beforeEach(() => {
    process.env.GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN = INTERNAL_TOKEN;
    process.env.GHOLA_CUSTOM_SHIELDED_VERIFIER_MODE = "local_test";
    process.env.GHOLA_SHIELDED_POOL_MODE = "local_test";
    process.env.GHOLA_PRIVATE_ACCOUNT_BATCH_MIN_DELAY_SECONDS = "0";
    process.env.GHOLA_PRIVATE_ACCOUNT_BATCH_REQUIRED_SET = "2";
  });

  it("executes only after stored intent, preview, and approval are bound", async () => {
    const { intent, preview, plan, approval } = await happyPathInput();

    const settleRes = await settleAction(
      request("/v1/private-account/actions/settle", {
        intent_id: intent.intent_id,
        preview_commitment: preview.preview.preview_commitment,
        approval_commitment: approval.approval.approval_commitment,
        execution_plan_commitment: plan.plan.plan_commitment,
      }),
    );
    const settled = await settleRes.json();
    expect(settleRes.status).toBe(201);
    expect(settled.settlement.settlement_commitment).toMatch(/^settlement_/);
    expect(settled.settlement.proof_commitment).toMatch(/^settlement_proof_/);

    const res = await executeAction(
      request("/v1/private-account/actions/execute", {
        intent_id: intent.intent_id,
        preview_commitment: preview.preview.preview_commitment,
        approval_commitment: approval.approval.approval_commitment,
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.ok).toBe(true);
    expect(body.receipt.preview_commitment).toBe(preview.preview.preview_commitment);
    expect(body.receipt.execution_commitment).toBe(body.execution_commitment);
    expect(body.receipt.evidence_chain.funding_import_commitment).toMatch(/^funding_import_/);
    expect(body.receipt.evidence_chain.batch_evidence_commitment).toMatch(/^anon_evidence_/);
    expect(body.receipt.evidence_chain.preview_commitment).toBe(preview.preview.preview_commitment);
    expect(body.receipt.evidence_chain.execution_plan_commitment).toBe(plan.plan.plan_commitment);
    expect(body.receipt.evidence_chain.approval_commitment).toBe(approval.approval.approval_commitment);
    expect(body.receipt.evidence_chain.execution_commitment).toBe(body.execution_commitment);
    expect(body.receipt.evidence_chain.settlement_commitment).toBe(settled.settlement.settlement_commitment);
    expect(body.receipt.evidence_chain.relay_commitment).toMatch(/^settlement_relay_/);
    expect(body.receipt.evidence_chain.finality_commitment).toMatch(/^settlement_finality_/);
    expect(body.receipt.evidence_chain.runtime_envelope_commitment).toMatch(/^runtime_envelope_/);
    expect(body.receipt.evidence_chain.runtime_attestation_commitment).toMatch(/^runtime_attestation_/);
    expect(body.receipt.evidence_chain.runtime_health_commitment).toMatch(/^runtime_health_/);
    expect(body.receipt.evidence_chain.schedule_commitment).toMatch(/^privacy_schedule_/);
    expect(body.receipt.evidence_chain.rotation_commitment).toMatch(/^platform_rotation_/);
    expect(body.receipt.evidence_chain.simulator_commitment).toMatch(/^adversarial_linkability_simulator_/);
    expect(body.receipt.execution_plan_commitment).toBe(plan.plan.plan_commitment);
    expect(body.receipt.settlement_commitment).toBe(settled.settlement.settlement_commitment);
    expect(body.receipt.runtime_envelope_commitment).toBe(
      body.receipt.evidence_chain.runtime_envelope_commitment,
    );
    expect(body.receipt.claim_levels_achieved).toEqual(
      expect.arrayContaining([
        "source_wallet_hidden",
        "amount_bucketed",
        "batched_anonymity_set",
        "operator_sealed",
        "selectively_disclosable",
      ]),
    );
    expect(body.receipt.claim_levels_missing).toHaveLength(0);

    const verifyRes = await verifyReceiptAction(
      request("/v1/private-account/actions/verify-receipt", {
        receipt_commitment: body.receipt.receipt_commitment,
      }),
    );
    const verified = await verifyRes.json();
    expect(verifyRes.status).toBe(200);
    expect(verified.verified).toBe(true);
    expect(verified.checks.execution_plan_bound).toBe("pass");
    expect(verified.checks.settlement_bound).toBe("pass");
    expect(verified.checks.witness_bound).toBe("pass");
    expect(verified.checks.proof_bound).toBe("pass");
    expect(verified.checks.relay_bound).toBe("pass");
    expect(verified.checks.finality_bound).toBe("pass");
    expect(verified.checks.runtime_envelope_bound).toBe("pass");
    expect(verified.checks.runtime_attestation_bound).toBe("pass");
    expect(verified.checks.schedule_bound).toBe("pass");
    expect(verified.checks.rotation_bound).toBe("pass");
    expect(verified.checks.simulator_bound).toBe("pass");
    expect(verified.checks.claim_levels_bound).toBe("pass");

    const receiptRes = await receiptAction(
      request("/v1/private-account/actions/receipt", {
        receipt_commitment: body.receipt.receipt_commitment,
      }),
    );
    expect(receiptRes.status).toBe(200);

    const listRes = await receiptListAction(
      new Request("https://ghola.test/v1/private-account/actions/receipts?limit=10", {
        headers: { authorization: AUTH },
      }),
    );
    const list = await listRes.json();
    expect(list.receipts).toHaveLength(1);
    expect(list.receipts[0].receipt_commitment).toBe(body.receipt.receipt_commitment);
    expect(JSON.stringify(list)).not.toContain("signature");

    const leakageRes = await leakageMapAction(
      request("/v1/private-account/actions/leakage-map", {
        preview_commitment: preview.preview.preview_commitment,
      }),
    );
    const leakage = await leakageRes.json();
    expect(leakage.simulated).toBe(false);
    expect(leakage.leakage_map.channels.source_wallet_graph).toBe("hidden_by_private_account");

    const detailRes = await receiptDetailAction(
      new Request(`https://ghola.test/v1/private-account/actions/receipts/${body.receipt.receipt_commitment}`, {
        headers: { authorization: AUTH },
      }),
      { params: Promise.resolve({ receipt_commitment: body.receipt.receipt_commitment }) },
    );
    const detail = await detailRes.json();
    expect(detail.receipt.receipt_commitment).toBe(body.receipt.receipt_commitment);
    expect(detail.leakage_map.channels.source_wallet_graph).toBe("hidden_by_private_account");

    const exportRes = await receiptExportAction(
      request("/v1/private-account/actions/receipts/export", {
        receipt_commitment: body.receipt.receipt_commitment,
        scope: "auditor_commitment_summary",
      }),
    );
    const exported = await exportRes.json();
    expect(exported.export_commitment).toMatch(/^receipt_export_/);
    expect(exported.evidence_chain.batch_evidence_commitment).toBe(
      body.receipt.evidence_chain.batch_evidence_commitment,
    );
    expect(JSON.stringify(exported)).not.toContain("signature");
    expect(JSON.stringify(exported)).not.toContain("encrypted_receipt_ciphertext");

    const privateExportRes = await privateReceiptExportAction(
      request("/v1/private-account/actions/receipts/export-private", {
        receipt_commitment: body.receipt.receipt_commitment,
        scope: "user_private_receipt",
      }),
    );
    const privateExport = await privateExportRes.json();
    expect(privateExportRes.status).toBe(200);
    expect(privateExport.private_export.private_export_commitment).toMatch(/^private_receipt_export_/);
    expect(privateExport.private_export.encrypted_receipt_commitment).toMatch(/^encrypted_private_receipt_/);
    expect(privateExport.private_export.encrypted_receipt_ciphertext).toEqual(expect.any(String));
    expect(privateExport.view_key.view_key_commitment).toMatch(/^view_key_/);
  });

  it("creates commitment-safe sealed runtime envelopes and rejects raw runtime fields", async () => {
    const intentRes = await createIntent(
      request("/v1/private-account/actions/intent", {
        action_class: "transfer",
        product_bucket: "stablecoin",
      }),
    );
    const intent = await intentRes.json();
    const forbiddenRes = await runtimeEnvelopeAction(
      request("/v1/private-account/actions/runtime-envelope", {
        intent_id: intent.intent_id,
        platform_class: "solana_private_balance",
        safe_input: {
          amount_bucket: "25",
          wallet_address: "raw-wallet",
        },
      }),
    );
    const forbidden = await forbiddenRes.json();
    expect(forbiddenRes.status).toBe(400);
    expect(forbidden.error).toContain("forbidden");

    const res = await runtimeEnvelopeAction(
      request("/v1/private-account/actions/runtime-envelope", {
        intent_id: intent.intent_id,
        platform_class: "solana_private_balance",
        safe_input: {
          amount_bucket: "25",
          asset_bucket: "stablecoin",
          destination_class: "ghola_user",
          urgency: "maximum_privacy",
        },
      }),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.runtime_envelope.runtime_envelope_commitment).toMatch(/^runtime_envelope_/);
    expect(body.runtime_envelope.encrypted_payload_commitment).toMatch(/^runtime_encrypted_payload_/);
    expect(body.sealed_runtime_context.runtime_status).toBe("ready");
    expect(JSON.stringify(body)).not.toContain("wallet_address");
    expect(JSON.stringify(body)).not.toContain("recipient_address");
  });

  it("does not approve a waiting Private Mode preview without evidence", async () => {
    const intentRes = await createIntent(
      request("/v1/private-account/actions/intent", {
        action_class: "transfer",
        product_bucket: "stablecoin",
      }),
    );
    const intent = await intentRes.json();
    const previewRes = await previewAction(
      request("/v1/private-account/actions/privacy-preview", {
        intent_id: intent.intent_id,
        platform_class: "solana_private_balance",
        requested_rail: "shielded_pool",
      }),
    );
    const preview = await previewRes.json();
    expect(preview.preview.claim_status).toBe("wait_for_anonymity");

    const approvalRes = await approveAction(
      request("/v1/private-account/actions/approve", {
        intent_id: intent.intent_id,
        preview_commitment: preview.preview.preview_commitment,
      }),
    );
    const approval = await approvalRes.json();
    expect(approvalRes.status).toBe(400);
    expect(approval.error).toBe("wait_for_anonymity");
  });

  it("rejects unsigned intent creation", async () => {
    const res = await createIntent(
      request(
        "/v1/private-account/actions/intent",
        { action_class: "transfer", product_bucket: "stablecoin" },
        "",
      ),
    );
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("private_account_auth_required");
  });

  it("rejects execution without approval", async () => {
    const { intent, preview } = await happyPathInput();

    const res = await executeAction(
      request("/v1/private-account/actions/execute", {
        intent_id: intent.intent_id,
        preview_commitment: preview.preview.preview_commitment,
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("approval_not_found");
  });

  it("rejects a mismatched approval", async () => {
    const { intent, preview } = await happyPathInput();

    const res = await executeAction(
      request("/v1/private-account/actions/execute", {
        intent_id: intent.intent_id,
        preview_commitment: preview.preview.preview_commitment,
        approval_commitment: "approval_wrong",
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("approval_not_found");
  });

  it("prevents another owner from executing the intent", async () => {
    const otherAuth = auth("user_2");
    const { intent, preview, approval } = await happyPathInput();

    const res = await executeAction(
      request(
        "/v1/private-account/actions/execute",
        {
          intent_id: intent.intent_id,
          preview_commitment: preview.preview.preview_commitment,
          approval_commitment: approval.approval.approval_commitment,
        },
        otherAuth,
      ),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("intent_not_found");
  });

  it("does not list another owner's receipts", async () => {
    const otherAuth = auth("user_2");
    const { intent, preview, approval } = await happyPathInput();
    await executeAction(
      request("/v1/private-account/actions/execute", {
        intent_id: intent.intent_id,
        preview_commitment: preview.preview.preview_commitment,
        approval_commitment: approval.approval.approval_commitment,
      }),
    );

    const listRes = await receiptListAction(
      new Request("https://ghola.test/v1/private-account/actions/receipts?limit=10", {
        headers: { authorization: otherAuth },
      }),
    );
    const list = await listRes.json();

    expect(list.receipts).toHaveLength(0);
  });

  it("requires explicit degraded acceptance for direct public fallback previews", async () => {
    const intentRes = await createIntent(
      request("/v1/private-account/actions/intent", {
        action_class: "pay",
        product_bucket: "solana",
      }),
    );
    const intent = await intentRes.json();
    await writeAnonymityEvidence(
      internalRequest("/v1/private-account/anonymity-evidence", {
        intent_id: intent.intent_id,
        effective_anonymity_set: 75,
        amount_bucketed: true,
        timing_window_met: true,
        uniqueness_score_bps: 500,
      }),
    );
    const previewRes = await previewAction(
      request("/v1/private-account/actions/privacy-preview", {
        intent_id: intent.intent_id,
        platform_class: "solana_public_wallet",
        requested_rail: "direct_public_fallback",
        safe_input: {
          amount_bucket: "25",
          asset_bucket: "stablecoin",
          destination_class: "external_public_address",
          urgency: "fast_degraded",
          solver_count_bucket: "5+",
        },
      }),
    );
    const preview = await previewRes.json();
    expect(preview.preview.claim_status, preview.preview.wait_reasons.join(" | ")).toBe("degraded_user_accepted_required");
    const approvalRes = await approveAction(
      request("/v1/private-account/actions/approve", {
        intent_id: intent.intent_id,
        preview_commitment: preview.preview.preview_commitment,
      }),
    );
    const approval = await approvalRes.json();

    expect(approvalRes.status).toBe(400);
    expect(approval.error).toBe("degraded_acceptance_required");
  });

  it("does not create a second execution for the same approval", async () => {
    const { intent, preview, approval } = await happyPathInput();
    const payload = {
      intent_id: intent.intent_id,
      preview_commitment: preview.preview.preview_commitment,
      approval_commitment: approval.approval.approval_commitment,
    };

    const first = await executeAction(request("/v1/private-account/actions/execute", payload));
    const second = await executeAction(request("/v1/private-account/actions/execute", payload));
    const firstBody = await first.json();
    const secondBody = await second.json();

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(secondBody.execution_commitment).toBe(firstBody.execution_commitment);
  });

  it("refuses execution when shielded settlement evidence is not finalized", async () => {
    const { intent, preview, plan, approval } = await happyPathInput();
    const settleRes = await settleAction(
      request("/v1/private-account/actions/settle", {
        intent_id: intent.intent_id,
        preview_commitment: preview.preview.preview_commitment,
        approval_commitment: approval.approval.approval_commitment,
        execution_plan_commitment: plan.plan.plan_commitment,
      }),
    );
    const settled = await settleRes.json();
    const record = await getPrivateSettlement(settled.settlement.settlement_commitment);
    expect(record).toBeTruthy();
    if (!record) return;
    await putPrivateSettlement({
      ...record,
      lifecycle_status: "finality_pending",
      evidence: {
        ...record.evidence,
        lifecycle_status: "finality_pending",
      },
      updated_at: new Date().toISOString(),
    });

    const res = await executeAction(
      request("/v1/private-account/actions/execute", {
        intent_id: intent.intent_id,
        preview_commitment: preview.preview.preview_commitment,
        approval_commitment: approval.approval.approval_commitment,
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("settlement_not_finalized");
  });

  it("reports and runs Private Mode canaries behind internal auth", async () => {
    const statusRes = await canaryStatus();
    const status = await statusRes.json();
    expect(statusRes.status).toBe(200);
    expect(status.status).toBe("green");
    expect(status.canaries).toHaveLength(3);

    const unauthorized = await runCanaries(
      internalRequest("/v1/private-account/canaries/run", {}),
    );
    expect(unauthorized.status).toBe(200);
    const body = await unauthorized.json();
    expect(body.status).toBe("green");

    const blocked = await runCanaries(
      new Request("https://ghola.test/v1/private-account/canaries/run", {
        method: "POST",
        headers: { authorization: "Bearer wrong" },
      }),
    );
    expect(blocked.status).toBe(401);
  });
});
