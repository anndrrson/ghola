import { afterEach, describe, expect, it } from "vitest";
import { POST as createIntent } from "../actions/intent/route";
import { POST as createPreview } from "../actions/privacy-preview/route";
import { POST as queueAction } from "../actions/queue/route";
import { POST as refreshQueue } from "../actions/queue/refresh/route";
import { POST as createInstruction } from "./instruction/route";
import { POST as importFunding } from "./import/route";
import { GET as fundingStatus } from "./status/route";
import { POST as refreshBatch } from "./batch/refresh/route";
import { POST as runBatch } from "./batch/run/route";
import { GET as runBatchCron } from "./batch/cron/route";
import { resetPrivateAccountStoreForTests } from "@/lib/private-account-store";

function auth(userId: string) {
  return `Bearer ${[
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: userId, email: `${userId}@example.com` })).toString("base64url"),
    "sig",
  ].join(".")}`;
}

function request(path: string, body?: unknown, userId = "user_1") {
  return new Request(`https://ghola.test${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      authorization: auth(userId),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function internalRequest(path: string, body: unknown) {
  return new Request(`https://ghola.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test_internal_private_account_token",
    },
    body: JSON.stringify(body),
  });
}

async function importCompatibleFunding(userId: string, input: {
  amount_bucket?: "25" | "50";
  asset_bucket?: "stablecoin" | "SOL";
  receipt_id?: string;
  expect_ok?: boolean;
} = {}) {
  const instructionRes = await createInstruction(
    request("/v1/private-account/funding/instruction", {
      amount_bucket: input.amount_bucket || "25",
      asset_bucket: input.asset_bucket || "stablecoin",
    }, userId),
  );
  const instruction = await instructionRes.json();
  const importRes = await importFunding(
    request("/v1/private-account/funding/import", {
      funding_intent_id: instruction.instruction.funding_intent_id,
      receipt_id: input.receipt_id || `custom_receipt_${userId}`,
    }, userId),
  );
  const imported = await importRes.json();
  if (input.expect_ok !== false) expect(importRes.status).toBe(201);
  return {
    instruction: instruction.instruction,
    import_status: importRes.status,
    imported: imported.import,
    body: imported,
  };
}

describe("private account funding routes", () => {
  afterEach(async () => {
    await resetPrivateAccountStoreForTests();
    delete process.env.GHOLA_CUSTOM_SHIELDED_VERIFIER_MODE;
    delete process.env.GHOLA_SHIELDED_POOL_MODE;
    delete process.env.GHOLA_PRIVATE_ACCOUNT_BATCH_MIN_DELAY_SECONDS;
    delete process.env.GHOLA_PRIVATE_ACCOUNT_BATCH_REQUIRED_SET;
    delete process.env.GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN;
    delete process.env.CRON_SECRET;
  });

  it("creates auth-only shielded funding instructions", async () => {
    const res = await createInstruction(
      request("/v1/private-account/funding/instruction", {
        amount_bucket: "25",
        asset_bucket: "stablecoin",
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.instruction.funding_intent_commitment).toMatch(/^funding_intent_/);
    expect(body.instruction.destination_commitment).toMatch(/^funding_destination_/);
    expect(body.instruction.shielded_destination).toContain("ghola_shielded_");
    expect(JSON.stringify(body)).not.toContain("wallet_address");
  });

  it("fails closed when the custom shielded verifier is not configured", async () => {
    const instructionRes = await createInstruction(
      request("/v1/private-account/funding/instruction", {
        amount_bucket: "25",
        asset_bucket: "stablecoin",
      }),
    );
    const instruction = await instructionRes.json();
    const res = await importFunding(
      request("/v1/private-account/funding/import", {
        funding_intent_id: instruction.instruction.funding_intent_id,
        receipt_id: "custom_receipt_unconfigured",
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("custom_shielded_verifier_unconfigured");
  });

  it("imports verified funding, refreshes batch evidence, and promotes a queued action", async () => {
    process.env.GHOLA_CUSTOM_SHIELDED_VERIFIER_MODE = "local_test";
    process.env.GHOLA_SHIELDED_POOL_MODE = "local_test";
    process.env.GHOLA_PRIVATE_ACCOUNT_BATCH_MIN_DELAY_SECONDS = "0";
    await importCompatibleFunding("user_1");
    for (let index = 2; index <= 50; index += 1) {
      await importCompatibleFunding(`user_${index}`);
    }

    const statusRes = await fundingStatus(
      request("/v1/private-account/funding/status", undefined, "user_1"),
    );
    const status = await statusRes.json();
    expect(status.vault_ready).toBe(true);
    expect(status.imports).toHaveLength(1);

    const intentRes = await createIntent(
      request("/v1/private-account/actions/intent", {
        action_class: "transfer",
        product_bucket: "stablecoin",
      }, "user_1"),
    );
    const intent = await intentRes.json();
    const previewRes = await createPreview(
      request("/v1/private-account/actions/privacy-preview", {
        intent_id: intent.intent_id,
        platform_class: "solana_private_balance",
        requested_rail: "shielded_pool",
      }, "user_1"),
    );
    const preview = await previewRes.json();
    expect(preview.preview.claim_status).toBe("wait_for_anonymity");

    const queueRes = await queueAction(
      request("/v1/private-account/actions/queue", {
        intent_id: intent.intent_id,
        preview_commitment: preview.preview.preview_commitment,
      }, "user_1"),
    );
    const queued = await queueRes.json();
    const batchRes = await refreshBatch(
      request("/v1/private-account/funding/batch/refresh", {
        queue_id: queued.queued_action.queue_id,
      }, "user_1"),
    );
    const batch = await batchRes.json();
    expect(batch.batch.status).toBe("evidence_ready");
    expect(batch.batch.effective_anonymity_set).toBe(50);
    expect(batch.evidence_commitment).toMatch(/^anon_evidence_/);

    const refreshedRes = await refreshQueue(
      request("/v1/private-account/actions/queue/refresh", {
        queue_id: queued.queued_action.queue_id,
      }, "user_1"),
    );
    const refreshed = await refreshedRes.json();
    expect(refreshed.preview.claim_status).toBe("private_mode_available");
    expect(refreshed.queued_action.status).toBe("ready");
  });

  it("rejects stale verifier state and insufficient confirmations", async () => {
    process.env.GHOLA_CUSTOM_SHIELDED_VERIFIER_MODE = "local_test";
    const stale = await importCompatibleFunding("user_1", {
      receipt_id: "custom_receipt_stale_user_1",
      expect_ok: false,
    });
    expect(stale.import_status).toBe(400);
    expect(stale.body.error).toBe("custom_shielded_verifier_stale");
    expect(stale.imported).toBeUndefined();

    const instructionRes = await createInstruction(
      request("/v1/private-account/funding/instruction", {
        amount_bucket: "25",
        asset_bucket: "stablecoin",
      }, "user_2"),
    );
    const instruction = await instructionRes.json();
    const lowConfRes = await importFunding(
      request("/v1/private-account/funding/import", {
        funding_intent_id: instruction.instruction.funding_intent_id,
        receipt_id: "custom_receipt_lowconf_user_2",
      }, "user_2"),
    );
    const lowConf = await lowConfRes.json();
    expect(lowConfRes.status).toBe(400);
    expect(lowConf.error).toBe("insufficient_confirmations");
  });

  it("does not count incompatible buckets in a batch", async () => {
    process.env.GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN = "test_internal_private_account_token";
    process.env.GHOLA_CUSTOM_SHIELDED_VERIFIER_MODE = "local_test";
    process.env.GHOLA_SHIELDED_POOL_MODE = "local_test";
    process.env.GHOLA_PRIVATE_ACCOUNT_BATCH_MIN_DELAY_SECONDS = "0";
    process.env.GHOLA_PRIVATE_ACCOUNT_BATCH_REQUIRED_SET = "2";
    await importCompatibleFunding("user_1", { amount_bucket: "25" });
    await importCompatibleFunding("user_2", { amount_bucket: "50" });

    const runRes = await runBatch(
      internalRequest("/v1/private-account/funding/batch/run", {}),
    );
    const run = await runRes.json();
    expect(run.run.status).toBe("waiting");

    const batchRes = await refreshBatch(
      request("/v1/private-account/funding/batch/refresh", {}, "user_1"),
    );
    const batch = await batchRes.json();
    expect(batch.batch.status).toBe("waiting");
    expect(batch.batch.effective_anonymity_set).toBe(1);
    expect(batch.evidence_commitment).toBeNull();
  });

  it("runs the batch coordinator from cron only with cron auth", async () => {
    process.env.CRON_SECRET = "test_cron_secret";
    process.env.GHOLA_CUSTOM_SHIELDED_VERIFIER_MODE = "local_test";
    process.env.GHOLA_SHIELDED_POOL_MODE = "local_test";

    const unauthorized = await runBatchCron(
      new Request("https://ghola.test/v1/private-account/funding/batch/cron", {
        method: "GET",
        headers: { authorization: "Bearer wrong" },
      }),
    );
    expect(unauthorized.status).toBe(401);

    const res = await runBatchCron(
      new Request("https://ghola.test/v1/private-account/funding/batch/cron", {
        method: "GET",
        headers: { authorization: "Bearer test_cron_secret" },
      }),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.run.run_id).toMatch(/^batch_run_/);
  });

  it("rejects duplicate funding nullifiers", async () => {
    process.env.GHOLA_CUSTOM_SHIELDED_VERIFIER_MODE = "local_test";
    const first = await importCompatibleFunding("user_1");
    const res = await importFunding(
      request("/v1/private-account/funding/import", {
        funding_intent_id: first.instruction.funding_intent_id,
        receipt_id: "custom_receipt_user_1",
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("funding_already_imported");

    const secondInstructionRes = await createInstruction(
      request("/v1/private-account/funding/instruction", {
        amount_bucket: "25",
        asset_bucket: "stablecoin",
      }),
    );
    const secondInstruction = await secondInstructionRes.json();
    const duplicateRes = await importFunding(
      request("/v1/private-account/funding/import", {
        funding_intent_id: secondInstruction.instruction.funding_intent_id,
        receipt_id: "custom_receipt_user_1",
      }),
    );
    const duplicate = await duplicateRes.json();
    expect(duplicateRes.status).toBe(400);
    expect(duplicate.error).toBe("duplicate_nullifier");
  });
});
