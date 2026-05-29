import { afterEach, describe, expect, it } from "vitest";
import { POST } from "./route";
import { POST as createIntent } from "../intent/route";
import { POST as queueAction } from "../queue/route";
import { POST as createFundingInstruction } from "../../funding/instruction/route";
import { POST as importFunding } from "../../funding/import/route";
import { POST as runBatchCoordinator } from "../../funding/batch/run/route";
import { resetPrivateAccountStoreForTests } from "@/lib/private-account-store";

const INTERNAL_TOKEN = "test_internal_private_account_token";

function auth(userId: string) {
  return `Bearer ${[
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: userId, email: `${userId}@example.com` })).toString("base64url"),
    "sig",
  ].join(".")}`;
}

function request(body: unknown, authorization = auth("user_1")) {
  return new Request("https://ghola.test/v1/private-account/actions/privacy-preview", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization,
    },
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

function routeRequest(path: string, body: unknown, authorization = auth("user_1")) {
  return new Request(`https://ghola.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization,
    },
    body: JSON.stringify(body),
  });
}

async function importCompatibleFunding(userId: string) {
  const instructionRes = await createFundingInstruction(
    routeRequest("/v1/private-account/funding/instruction", {
      amount_bucket: "25",
      asset_bucket: "stablecoin",
    }, auth(userId)),
  );
  const instruction = await instructionRes.json();
  const importRes = await importFunding(
    routeRequest("/v1/private-account/funding/import", {
      funding_intent_id: instruction.instruction.funding_intent_id,
      receipt_id: `custom_receipt_${userId}`,
    }, auth(userId)),
  );
  expect(importRes.status).toBe(201);
}

describe("private account privacy preview route", () => {
  afterEach(async () => {
    await resetPrivateAccountStoreForTests();
    delete process.env.GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN;
    delete process.env.GHOLA_CUSTOM_SHIELDED_VERIFIER_MODE;
    delete process.env.GHOLA_SHIELDED_POOL_MODE;
    delete process.env.GHOLA_PRIVATE_ACCOUNT_BATCH_MIN_DELAY_SECONDS;
    delete process.env.GHOLA_PRIVATE_ACCOUNT_BATCH_REQUIRED_SET;
  });

  it("does not trust client-submitted vault or anonymity evidence", async () => {
    const intentRes = await createIntent(
      request({
        action_class: "transfer",
        product_bucket: "stablecoin",
        vault_ready: true,
      }),
    );
    const intent = await intentRes.json();
    const res = await POST(
      request({
        intent_id: intent.intent_id,
        platform_class: "solana_private_balance",
        requested_rail: "shielded_pool",
        vault_ready: true,
        anonymity_set: {
          effective: 75,
          amount_bucketed: true,
          timing_window_met: true,
          uniqueness_score_bps: 500,
        },
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.preview.claim_status).toBe("wait_for_anonymity");
    expect(body.preview.wait_reasons).toContain("private account vault is not ready");
  });

  it("returns private-mode only after internal vault readiness and anonymity evidence exist", async () => {
    process.env.GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN = INTERNAL_TOKEN;
    process.env.GHOLA_CUSTOM_SHIELDED_VERIFIER_MODE = "local_test";
    process.env.GHOLA_SHIELDED_POOL_MODE = "local_test";
    process.env.GHOLA_PRIVATE_ACCOUNT_BATCH_MIN_DELAY_SECONDS = "0";
    process.env.GHOLA_PRIVATE_ACCOUNT_BATCH_REQUIRED_SET = "2";
    await importCompatibleFunding("user_1");
    await importCompatibleFunding("user_2");
    const intentRes = await createIntent(
      request({
        action_class: "transfer",
        product_bucket: "stablecoin",
        vault_ready: true,
      }),
    );
    const intent = await intentRes.json();
    const waitingRes = await POST(
      request({
        intent_id: intent.intent_id,
        platform_class: "solana_private_balance",
        requested_rail: "shielded_pool",
      }),
    );
    const waiting = await waitingRes.json();
    const queuedRes = await queueAction(
      routeRequest("/v1/private-account/actions/queue", {
        intent_id: intent.intent_id,
        preview_commitment: waiting.preview.preview_commitment,
      }),
    );
    const queued = await queuedRes.json();
    await runBatchCoordinator(
      internalRequest("/v1/private-account/funding/batch/run", {
        queue_id: queued.queued_action.queue_id,
      }),
    );
    const res = await POST(
      request({
        intent_id: intent.intent_id,
        platform_class: "solana_private_balance",
        requested_rail: "shielded_pool",
        vault_ready: false,
        anonymity_set: {
          effective: 0,
          amount_bucketed: false,
          timing_window_met: false,
          uniqueness_score_bps: 10_000,
        },
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.preview.claim_status).toBe("private_mode_available");
  });

  it("rejects forbidden raw public fields", async () => {
    const res = await POST(
      request({
        action_class: "transfer",
        platform_class: "solana_private_balance",
        wallet_address: "raw-wallet",
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("forbidden");
  });
});
