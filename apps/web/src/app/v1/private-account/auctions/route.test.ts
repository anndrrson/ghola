import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as createIntent } from "../actions/intent/route";
import { POST as createPreview } from "../actions/privacy-preview/route";
import { POST as queueAction } from "../actions/queue/route";
import { POST as refreshQueue } from "../actions/queue/refresh/route";
import { GET as operationsStatus } from "../operations/status/route";
import { GET as listAuctions } from "./route";
import { POST as commitAuction } from "./commit/route";
import { POST as closeAuction } from "./close/route";
import { POST as confirmAuction } from "./confirm/route";
import { POST as confirmInternalAuction } from "./confirm-internal/route";
import { POST as prepareMarket } from "./market/route";
import { POST as openAuctionEpoch } from "./open/route";
import { POST as settleAuction } from "./settle/route";
import { POST as createFundingInstruction } from "../funding/instruction/route";
import { POST as importFunding } from "../funding/import/route";
import { POST as runBatchCoordinator } from "../funding/batch/run/route";
import { gholaCommitment } from "@/lib/private-account";
import { resetPrivateAccountStoreForTests } from "@/lib/private-account-store";

const INTERNAL_TOKEN = "test_internal_private_account_token";

function auth(userId: string) {
  return `Bearer ${[
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: userId, email: `${userId}@example.com` })).toString("base64url"),
    "sig",
  ].join(".")}`;
}

const AUTH = auth("auction_user_1");

function post(path: string, body: unknown, authorization = AUTH) {
  return new Request(`https://ghola.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization },
    body: JSON.stringify(body),
  });
}

function get(path: string, authorization = AUTH) {
  return new Request(`https://ghola.test${path}`, {
    headers: { authorization },
  });
}

function internalPost(path: string, body: unknown) {
  return post(path, body, `Bearer ${INTERNAL_TOKEN}`);
}

function setInstitutionalAuctionProductionEnv() {
  vi.stubEnv("GHOLA_INSTITUTIONAL_FULL_PRODUCTION_ENABLED", "true");
  vi.stubEnv("GHOLA_SHIELDED_POOL_PROGRAM_ID", "5bmCDeaQceBpWgK8aADB4Tz4JzqZ9hkCi3qedC6oZR8A");
  vi.stubEnv("GHOLA_SHIELDED_POOL_MINT", "So11111111111111111111111111111111111111112");
  vi.stubEnv("GHOLA_AUCTION_RECENT_BLOCKHASH", "11111111111111111111111111111111");
  vi.stubEnv("GHOLA_AUCTION_CONFIRMATION_MODE", "local_test");
}

function hex(byte: string, bytes = 32) {
  return byte.repeat(bytes);
}

async function queueAuctionIntent() {
  const safeInput = {
    product_bucket: "perps",
    amount_bucket: "25",
    asset_bucket: "ETH",
    destination_class: "platform_subaccount",
    urgency: "maximum_privacy",
    solver_count_bucket: "5+",
  };
  const intentRes = await createIntent(
    post("/v1/private-account/actions/intent", {
      action_class: "trade_on_platform",
      product_bucket: "perps",
    }),
  );
  expect(intentRes.status).toBe(201);
  const intent = await intentRes.json();
  const previewRes = await createPreview(
    post("/v1/private-account/actions/privacy-preview", {
      intent_id: intent.intent_id,
      platform_class: "rfq_solver_network",
      requested_rail: "shielded_batch_auction",
      safe_input: safeInput,
    }),
  );
  const preview = await previewRes.json();
  expect(previewRes.status).toBe(200);
  expect(preview.preview.selected_rail).toBe("shielded_batch_auction");
  expect(preview.preview.claim_status).toBe("wait_for_anonymity");

  const queuedRes = await queueAction(
    post("/v1/private-account/actions/queue", {
      intent_id: intent.intent_id,
      preview_commitment: preview.preview.preview_commitment,
    }),
  );
  const queued = await queuedRes.json();
  expect(queuedRes.status).toBe(201);
  return queued.queued_action.queue_id as string;
}

async function importCompatibleFunding(userId: string) {
  const instructionRes = await createFundingInstruction(
    post("/v1/private-account/funding/instruction", {
      action_class: "trade_on_platform",
      amount_bucket: "25",
      asset_bucket: "stablecoin",
    }, auth(userId)),
  );
  const instruction = await instructionRes.json();
  const importRes = await importFunding(
    post("/v1/private-account/funding/import", {
      funding_intent_id: instruction.instruction.funding_intent_id,
      receipt_id: `custom_receipt_auction_${userId}`,
    }, auth(userId)),
  );
  expect(importRes.status).toBe(201);
}

describe("private account shielded batch auction routes", () => {
  beforeEach(() => {
    process.env.GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN = INTERNAL_TOKEN;
    process.env.GHOLA_CONNECTOR_MODE = "local_test";
    process.env.GHOLA_CUSTOM_SHIELDED_VERIFIER_MODE = "local_test";
    process.env.GHOLA_SHIELDED_POOL_MODE = "local_test";
    process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
    process.env.GHOLA_PRIVATE_ACCOUNT_BATCH_MIN_DELAY_SECONDS = "0";
    process.env.GHOLA_PRIVATE_ACCOUNT_BATCH_REQUIRED_SET = "2";
  });

  afterEach(async () => {
    await resetPrivateAccountStoreForTests();
    vi.unstubAllEnvs();
    delete process.env.GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN;
    delete process.env.GHOLA_CONNECTOR_MODE;
    delete process.env.GHOLA_CUSTOM_SHIELDED_VERIFIER_MODE;
    delete process.env.GHOLA_SHIELDED_POOL_MODE;
    delete process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS;
    delete process.env.GHOLA_PRIVATE_ACCOUNT_BATCH_MIN_DELAY_SECONDS;
    delete process.env.GHOLA_PRIVATE_ACCOUNT_BATCH_REQUIRED_SET;
  });

  it("commits queued trade intents, closes a uniform clearing, and settles idempotently", async () => {
    const buyQueueId = await queueAuctionIntent();
    const sellQueueId = await queueAuctionIntent();

    const buyCommitRes = await commitAuction(
      post("/v1/private-account/auctions/commit", {
        queue_id: buyQueueId,
        side: "buy",
        amount_bucket: "25",
        asset_bucket: "ETH",
      }),
    );
    const buyCommit = await buyCommitRes.json();
    expect(buyCommitRes.status).toBe(201);
    expect(buyCommit.order.status).toBe("committed");
    expect(buyCommit.epoch.status).toBe("open");

    const sellCommitRes = await commitAuction(
      post("/v1/private-account/auctions/commit", {
        queue_id: sellQueueId,
        side: "sell",
        amount_bucket: "25",
        asset_bucket: "ETH",
      }),
    );
    const sellCommit = await sellCommitRes.json();
    expect(sellCommitRes.status).toBe(201);
    expect(sellCommit.epoch.auction_epoch_commitment).toBe(buyCommit.epoch.auction_epoch_commitment);
    expect(sellCommit.epoch.order_count).toBe(2);

    const idempotentCommitRes = await commitAuction(
      post("/v1/private-account/auctions/commit", {
        queue_id: buyQueueId,
        side: "sell",
        amount_bucket: "25",
        asset_bucket: "ETH",
      }),
    );
    const idempotentCommit = await idempotentCommitRes.json();
    expect(idempotentCommitRes.status).toBe(200);
    expect(idempotentCommit.order.auction_order_commitment).toBe(buyCommit.order.auction_order_commitment);

    const closeRes = await closeAuction(
      internalPost("/v1/private-account/auctions/close", {
        auction_epoch_commitment: buyCommit.epoch.auction_epoch_commitment,
      }),
    );
    const closed = await closeRes.json();
    expect(closeRes.status).toBe(201);
    expect(closed.clearing.status).toBe("cleared");
    expect(closed.clearing.matched_order_commitments).toHaveLength(2);
    expect(closed.epoch.status).toBe("cleared");

    const settleRes = await settleAuction(
      post("/v1/private-account/auctions/settle", {
        clearing_commitment: closed.clearing.clearing_commitment,
      }),
    );
    const settled = await settleRes.json();
    expect(settleRes.status).toBe(200);
    expect(settled.clearing.status).toBe("settled");
    expect(settled.clearing.settlement_commitment).toMatch(/^auction_settlement_/);

    const listRes = await listAuctions(get("/v1/private-account/auctions"));
    const list = await listRes.json();
    expect(list.epochs[0].status).toBe("settled");
    expect(list.orders.filter((order: { status: string }) => order.status === "settled")).toHaveLength(2);
    expect(list.clearings[0].settlement_commitment).toBe(settled.clearing.settlement_commitment);

    const opsRes = await operationsStatus(get("/v1/private-account/operations/status"));
    const ops = await opsRes.json();
    expect(ops.auction_epochs[0].auction_epoch_commitment).toBe(buyCommit.epoch.auction_epoch_commitment);
    expect(ops.auction_orders).toHaveLength(2);
  });

  it("certifies zero-front-run after the queued auction order is settled", async () => {
    await importCompatibleFunding("auction_user_1");
    await importCompatibleFunding("auction_user_2");
    const buyQueueId = await queueAuctionIntent();
    const sellQueueId = await queueAuctionIntent();
    await runBatchCoordinator(
      internalPost("/v1/private-account/funding/batch/run", {
        queue_id: buyQueueId,
      }),
    );

    const buyCommitRes = await commitAuction(
      post("/v1/private-account/auctions/commit", {
        queue_id: buyQueueId,
        side: "buy",
        amount_bucket: "25",
        asset_bucket: "ETH",
      }),
    );
    const buyCommit = await buyCommitRes.json();
    expect(buyCommitRes.status).toBe(201);

    const sellCommitRes = await commitAuction(
      post("/v1/private-account/auctions/commit", {
        queue_id: sellQueueId,
        side: "sell",
        amount_bucket: "25",
        asset_bucket: "ETH",
      }),
    );
    expect(sellCommitRes.status).toBe(201);

    const closeRes = await closeAuction(
      internalPost("/v1/private-account/auctions/close", {
        auction_epoch_commitment: buyCommit.epoch.auction_epoch_commitment,
      }),
    );
    const closed = await closeRes.json();
    expect(closeRes.status).toBe(201);

    const settleRes = await settleAuction(
      post("/v1/private-account/auctions/settle", {
        clearing_commitment: closed.clearing.clearing_commitment,
      }),
    );
    expect(settleRes.status).toBe(200);

    const refreshRes = await refreshQueue(
      post("/v1/private-account/actions/queue/refresh", {
        queue_id: buyQueueId,
        front_run_mode: "zero_front_run",
        safe_input: {
          product_bucket: "perps",
          amount_bucket: "25",
          asset_bucket: "ETH",
          destination_class: "platform_subaccount",
          urgency: "maximum_privacy",
          solver_count_bucket: "5+",
        },
      }),
    );
    const refreshed = await refreshRes.json();

    expect(refreshRes.status).toBe(200);
    expect(refreshed.preview.front_run_mode).toBe("zero_front_run");
    expect(refreshed.preview.front_run_certificate_commitment).toMatch(/^front_run_certificate_[0-9a-f]{48}$/);
    expect(refreshed.preview.front_run_protection).toMatchObject({
      kind: "zero_certified",
      zeroFrontRun: true,
      canLiveSubmitInZeroMode: true,
      certificateCommitment: refreshed.preview.front_run_certificate_commitment,
    });
    expect(refreshed.preview.evidence_chain.front_run_certificate_commitment).toBe(
      refreshed.preview.front_run_certificate_commitment,
    );
  });

  it("keeps technical auction requests scoped while marking enterprise gates blocking in production", async () => {
    vi.stubEnv("GHOLA_INSTITUTIONAL_FULL_PRODUCTION_ENABLED", "true");

    const commitRes = await commitAuction(
      post("/v1/private-account/auctions/commit", {
        queue_id: "missing_queue",
      }),
    );
    const commitBody = await commitRes.json();

    expect(commitRes.status).toBe(400);
    expect(commitBody.error).toBe("queue_not_found");

    const listRes = await listAuctions(get("/v1/private-account/auctions"));
    const listBody = await listRes.json();
    expect(listBody.institutional_auction_readiness.production_required).toBe(true);
    expect(listBody.institutional_auction_readiness.status).toBe("not_configured");
    expect(listBody.institutional_auction_readiness.on_chain_routes_implemented).toBe(true);
    expect(listBody.institutional_auction_readiness.full_enterprise_ready).toBe(false);
    expect(listBody.institutional_auction_readiness.enterprise_gate.status).toBe("blocked");
    expect(listBody.institutional_auction_readiness.checks).toContainEqual(expect.objectContaining({
      check: "enterprise_external_gate",
      status: "blocked",
      blocking: true,
    }));
    expect(listBody.institutional_auction_readiness.checks.map((check: { check: string }) => check.check)).toContain(
      "web_on_chain_routes_wired",
    );

    const closeRes = await closeAuction(
      internalPost("/v1/private-account/auctions/close", {
        auction_epoch_commitment: "missing_epoch",
      }),
    );
    const settleRes = await settleAuction(
      post("/v1/private-account/auctions/settle", {
        clearing_commitment: "missing_clearing",
      }),
    );

    expect(closeRes.status).toBe(400);
    expect((await closeRes.json()).error).toBe("auction_signer_required");
    expect(settleRes.status).toBe(400);
    expect((await settleRes.json()).error).toBe("auction_signer_required");
  });

  it("still blocks production auction preparation on missing technical on-chain config", async () => {
    const queueId = await queueAuctionIntent();
    vi.stubEnv("GHOLA_INSTITUTIONAL_FULL_PRODUCTION_ENABLED", "true");

    const missingProgramRes = await commitAuction(
      post("/v1/private-account/auctions/commit", {
        queue_id: queueId,
        side: "buy",
        amount_bucket: "25",
        asset_bucket: "ETH",
        signer_public_key: "11111111111111111111111111111111",
        market_commitment_hex: hex("01"),
        epoch_id: 42,
        order_commitment_hex: hex("02"),
        order_nullifier_hex: hex("03"),
        price_bucket_commitment_hex: hex("04"),
        institution_policy_commitment_hex: hex("05"),
      }),
    );
    expect(missingProgramRes.status).toBe(400);
    expect((await missingProgramRes.json()).error).toBe("auction_program_id_missing");

    vi.stubEnv("GHOLA_SHIELDED_POOL_PROGRAM_ID", "5bmCDeaQceBpWgK8aADB4Tz4JzqZ9hkCi3qedC6oZR8A");
    const missingMintRes = await commitAuction(
      post("/v1/private-account/auctions/commit", {
        queue_id: queueId,
        side: "buy",
        amount_bucket: "25",
        asset_bucket: "ETH",
        signer_public_key: "11111111111111111111111111111111",
        market_commitment_hex: hex("01"),
        epoch_id: 42,
        order_commitment_hex: hex("02"),
        order_nullifier_hex: hex("03"),
        price_bucket_commitment_hex: hex("04"),
        institution_policy_commitment_hex: hex("05"),
      }),
    );
    expect(missingMintRes.status).toBe(400);
    expect((await missingMintRes.json()).error).toBe("auction_mint_missing");
  });

  it("prepares internal on-chain market and epoch transactions in institutional production", async () => {
    setInstitutionalAuctionProductionEnv();
    const signer = "11111111111111111111111111111111";
    const ownerCommitment = gholaCommitment("owner", "auction_user_1");

    const marketRes = await prepareMarket(
      internalPost("/v1/private-account/auctions/market", {
        signer_public_key: signer,
        owner_commitment: ownerCommitment,
        account_commitment: ownerCommitment,
        market_commitment_hex: hex("06"),
        asset_id_hex: hex("07"),
        auction_verifier_key_hash_hex: hex("08"),
        batch_size: 128,
      }),
    );
    const market = await marketRes.json();

    expect(marketRes.status).toBe(201);
    expect(market.mode).toBe("on_chain_prepare");
    expect(market.prepared_transaction.operation).toBe("init_market");
    expect(market.auction_readiness.status).toBe("blocked");
    expect(market.auction_readiness.enterprise_gate.status).toBe("blocked");
    expect(market.prepared_transaction.required_signers).toContain(signer);
    expect(market.prepared_transaction.accounts.auction_market).toEqual(expect.any(String));

    const marketConfirmRes = await confirmInternalAuction(
      internalPost("/v1/private-account/auctions/confirm-internal", {
        client_reference: market.prepared_transaction.client_reference,
        signature: "test_signature_market_init",
      }),
    );
    const marketConfirmed = await marketConfirmRes.json();
    expect(marketConfirmRes.status).toBe(200);
    expect(marketConfirmed.local_update).toBe("auction_market_initialized");

    const openRes = await openAuctionEpoch(
      internalPost("/v1/private-account/auctions/open", {
        signer_public_key: signer,
        owner_commitment: ownerCommitment,
        account_commitment: ownerCommitment,
        market_commitment_hex: hex("06"),
        platform_class: "rfq_solver_network",
        asset_bucket: "ETH",
        amount_bucket: "25",
        epoch_id: 7,
        closes_slot: 12345,
      }),
    );
    const opened = await openRes.json();

    expect(openRes.status).toBe(201);
    expect(opened.mode).toBe("on_chain_prepare");
    expect(opened.prepared_transaction.operation).toBe("open_epoch");
    expect(opened.prepared_transaction.required_signers).toContain(signer);
    expect(opened.prepared_transaction.accounts.auction_epoch).toEqual(expect.any(String));

    const openConfirmRes = await confirmInternalAuction(
      internalPost("/v1/private-account/auctions/confirm-internal", {
        client_reference: opened.prepared_transaction.client_reference,
        signature: "test_signature_open_epoch",
      }),
    );
    const openConfirmed = await openConfirmRes.json();
    expect(openConfirmRes.status).toBe(200);
    expect(openConfirmed.local_update).toBe("auction_epoch_opened");
    expect(openConfirmed.epoch.status).toBe("open");

    const listRes = await listAuctions(get("/v1/private-account/auctions"));
    const list = await listRes.json();
    expect(list.epochs[0].auction_epoch_commitment).toBe(openConfirmed.epoch.auction_epoch_commitment);
  });

  it("prepares unsigned on-chain commit transactions in institutional production and confirms them before local mutation", async () => {
    const queueId = await queueAuctionIntent();
    setInstitutionalAuctionProductionEnv();

    const prepareRes = await commitAuction(
      post("/v1/private-account/auctions/commit", {
        queue_id: queueId,
        side: "buy",
        amount_bucket: "25",
        asset_bucket: "ETH",
        signer_public_key: "11111111111111111111111111111111",
        market_commitment_hex: hex("01"),
        epoch_id: 42,
        order_commitment_hex: hex("02"),
        order_nullifier_hex: hex("03"),
        price_bucket_commitment_hex: hex("04"),
        institution_policy_commitment_hex: hex("05"),
      }),
    );
    const prepared = await prepareRes.json();

    expect(prepareRes.status).toBe(201);
    expect(prepared.mode).toBe("on_chain_prepare");
    expect(prepared.auction_readiness.status).toBe("blocked");
    expect(prepared.auction_readiness.enterprise_gate.status).toBe("blocked");
    expect(prepared.prepared_transaction.operation).toBe("commit_order");
    expect(prepared.prepared_transaction.transaction_base64).toEqual(expect.any(String));
    expect(prepared.prepared_transaction.required_signers).toContain("11111111111111111111111111111111");

    const listBeforeRes = await listAuctions(get("/v1/private-account/auctions"));
    const listBefore = await listBeforeRes.json();
    expect(listBefore.orders).toHaveLength(0);

    const confirmRes = await confirmAuction(
      post("/v1/private-account/auctions/confirm", {
        client_reference: prepared.prepared_transaction.client_reference,
        signature: "test_signature_auction_commit",
      }),
    );
    const confirmed = await confirmRes.json();

    expect(confirmRes.status).toBe(200);
    expect(confirmed.confirmation.status).toBe("confirmed");
    expect(confirmed.local_update).toBe("auction_order_committed");
    expect(confirmed.order.status).toBe("committed");

    const internalCommitConfirmRes = await confirmInternalAuction(
      internalPost("/v1/private-account/auctions/confirm-internal", {
        client_reference: prepared.prepared_transaction.client_reference,
        signature: "test_signature_auction_commit",
      }),
    );
    expect(internalCommitConfirmRes.status).toBe(400);
    expect((await internalCommitConfirmRes.json()).error).toBe("auction_internal_confirmation_forbidden");
  });

  it("rejects non-auction queue entries", async () => {
    const intentRes = await createIntent(
      post("/v1/private-account/actions/intent", {
        action_class: "transfer",
        product_bucket: "stablecoin",
      }),
    );
    const intent = await intentRes.json();
    const previewRes = await createPreview(
      post("/v1/private-account/actions/privacy-preview", {
        intent_id: intent.intent_id,
        platform_class: "solana_private_balance",
        requested_rail: "shielded_pool",
        safe_input: {
          product_bucket: "stablecoin",
          amount_bucket: "25",
          asset_bucket: "stablecoin",
          destination_class: "ghola_user",
          urgency: "maximum_privacy",
          solver_count_bucket: "5+",
        },
      }),
    );
    const preview = await previewRes.json();
    const queuedRes = await queueAction(
      post("/v1/private-account/actions/queue", {
        intent_id: intent.intent_id,
        preview_commitment: preview.preview.preview_commitment,
      }),
    );
    const queued = await queuedRes.json();
    const res = await commitAuction(
      post("/v1/private-account/auctions/commit", {
        queue_id: queued.queued_action.queue_id,
        side: "buy",
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("auction_rail_required");
  });
});
