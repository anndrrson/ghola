import { afterEach, describe, expect, it } from "vitest";
import { POST as createIntent } from "../intent/route";
import { POST as createPreview } from "../privacy-preview/route";
import { GET, POST } from "./route";
import { POST as refreshQueue } from "./refresh/route";
import { POST as cancelQueue } from "./cancel/route";
import { POST as createFundingInstruction } from "../../funding/instruction/route";
import { POST as importFunding } from "../../funding/import/route";
import { POST as runBatchCoordinator } from "../../funding/batch/run/route";
import { resetPrivateAccountStoreForTests } from "@/lib/private-account-store";

function auth(userId: string) {
  return `Bearer ${[
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: userId, email: `${userId}@example.com` })).toString("base64url"),
    "sig",
  ].join(".")}`;
}

const AUTH = auth("user_1");
const INTERNAL_TOKEN = "test_internal_private_account_token";

function request(path: string, body?: unknown, authorization = AUTH) {
  return new Request(`https://ghola.test${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      authorization,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
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

describe("private account action queue route", () => {
  afterEach(async () => {
    await resetPrivateAccountStoreForTests();
    delete process.env.GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN;
    delete process.env.GHOLA_CUSTOM_SHIELDED_VERIFIER_MODE;
    delete process.env.GHOLA_SHIELDED_POOL_MODE;
    delete process.env.GHOLA_PRIVATE_ACCOUNT_BATCH_MIN_DELAY_SECONDS;
    delete process.env.GHOLA_PRIVATE_ACCOUNT_BATCH_REQUIRED_SET;
  });

  it("queues wait-for-privacy previews and refreshes them only from server evidence", async () => {
    process.env.GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN = INTERNAL_TOKEN;
    process.env.GHOLA_CUSTOM_SHIELDED_VERIFIER_MODE = "local_test";
    process.env.GHOLA_SHIELDED_POOL_MODE = "local_test";
    process.env.GHOLA_PRIVATE_ACCOUNT_BATCH_MIN_DELAY_SECONDS = "0";
    process.env.GHOLA_PRIVATE_ACCOUNT_BATCH_REQUIRED_SET = "2";
    await importCompatibleFunding("user_1");
    await importCompatibleFunding("user_2");
    const intentRes = await createIntent(
      request("/v1/private-account/actions/intent", {
        action_class: "transfer",
        product_bucket: "stablecoin",
        vault_ready: true,
      }),
    );
    const intent = await intentRes.json();
    const previewRes = await createPreview(
      request("/v1/private-account/actions/privacy-preview", {
        intent_id: intent.intent_id,
        platform_class: "solana_private_balance",
        requested_rail: "shielded_pool",
        anonymity_set: {
          effective: 10,
          amount_bucketed: true,
          timing_window_met: false,
          uniqueness_score_bps: 500,
        },
      }),
    );
    const preview = await previewRes.json();
    expect(preview.preview.claim_status).toBe("wait_for_anonymity");

    const queuedRes = await POST(
      request("/v1/private-account/actions/queue", {
        intent_id: intent.intent_id,
        preview_commitment: preview.preview.preview_commitment,
      }),
    );
    const queued = await queuedRes.json();
    expect(queuedRes.status).toBe(201);
    expect(queued.queued_action.status).toBe("queued");

    const refreshedRes = await refreshQueue(
      request("/v1/private-account/actions/queue/refresh", {
        queue_id: queued.queued_action.queue_id,
        effective_anonymity_set: 75,
      }),
    );
    const refreshed = await refreshedRes.json();
    expect(refreshed.preview.claim_status).toBe("wait_for_anonymity");
    expect(refreshed.queued_action.status).toBe("queued");

    await runBatchCoordinator(
      internalRequest("/v1/private-account/funding/batch/run", {
        queue_id: queued.queued_action.queue_id,
      }),
    );
    const readyRes = await refreshQueue(
      request("/v1/private-account/actions/queue/refresh", {
        queue_id: queued.queued_action.queue_id,
        effective_anonymity_set: 0,
      }),
    );
    const ready = await readyRes.json();
    expect(ready.preview.claim_status).toBe("private_mode_available");
    expect(ready.queued_action.status).toBe("ready");

    const listRes = await GET(request("/v1/private-account/actions/queue"));
    const list = await listRes.json();
    expect(list.queued_actions).toHaveLength(1);
  });

  it("cancels queued actions", async () => {
    const intentRes = await createIntent(
      request("/v1/private-account/actions/intent", {
        action_class: "transfer",
        product_bucket: "stablecoin",
        vault_ready: true,
      }),
    );
    const intent = await intentRes.json();
    const previewRes = await createPreview(
      request("/v1/private-account/actions/privacy-preview", {
        intent_id: intent.intent_id,
        platform_class: "solana_private_balance",
        requested_rail: "shielded_pool",
        anonymity_set: {
          effective: 10,
          amount_bucketed: true,
          timing_window_met: false,
          uniqueness_score_bps: 500,
        },
      }),
    );
    const preview = await previewRes.json();
    const queuedRes = await POST(
      request("/v1/private-account/actions/queue", {
        intent_id: intent.intent_id,
        preview_commitment: preview.preview.preview_commitment,
      }),
    );
    const queued = await queuedRes.json();
    const cancelledRes = await cancelQueue(
      request("/v1/private-account/actions/queue/cancel", {
        queue_id: queued.queued_action.queue_id,
      }),
    );
    const cancelled = await cancelledRes.json();

    expect(cancelled.status).toBe("cancelled");
  });
});
