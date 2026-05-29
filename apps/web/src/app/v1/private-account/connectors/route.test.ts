import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as manifestsRoute } from "./manifests/route";
import { POST as readinessRoute } from "./readiness/route";
import { POST as compileIntentRoute } from "../actions/compile-intent/route";
import { POST as createIntent } from "../actions/intent/route";
import { POST as previewAction } from "../actions/privacy-preview/route";
import { POST as queueAction } from "../actions/queue/route";
import { POST as refreshQueue } from "../actions/queue/refresh/route";
import { POST as planAction } from "../actions/plan/route";
import { POST as approveAction } from "../actions/approve/route";
import { POST as executeAction } from "../actions/execute/route";
import { POST as verifyReceiptAction } from "../actions/verify-receipt/route";
import { GET as operationsRoute } from "./operations/route";
import { POST as verifyNoSubmitRoute } from "./verify-no-submit/route";
import { POST as createFundingInstruction } from "../funding/instruction/route";
import { POST as importFunding } from "../funding/import/route";
import { POST as runBatchCoordinator } from "../funding/batch/run/route";
import { GET as getVenueVault, POST as sealVenueVault } from "../venues/[platform_class]/vault/route";
import { resetPrivateAccountStoreForTests } from "@/lib/private-account-store";

const INTERNAL_TOKEN = "test_internal_private_account_token";

function auth(userId: string) {
  return `Bearer ${[
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: userId, email: `${userId}@example.com` })).toString("base64url"),
    "sig",
  ].join(".")}`;
}

const AUTH = auth("connector_user_1");

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

async function importCompatibleFunding(userId: string) {
  const instructionRes = await createFundingInstruction(
    post("/v1/private-account/funding/instruction", {
      amount_bucket: "25",
      asset_bucket: "stablecoin",
    }, auth(userId)),
  );
  const instruction = await instructionRes.json();
  const importRes = await importFunding(
    post("/v1/private-account/funding/import", {
      funding_intent_id: instruction.instruction.funding_intent_id,
      receipt_id: `custom_receipt_${userId}`,
    }, auth(userId)),
  );
  expect(importRes.status).toBe(201);
}

describe("private account connector gateway routes", () => {
  beforeEach(() => {
    process.env.GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN = INTERNAL_TOKEN;
    process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
    process.env.GHOLA_CONNECTOR_MODE = "local_test";
    process.env.GHOLA_CUSTOM_SHIELDED_VERIFIER_MODE = "local_test";
    process.env.GHOLA_SHIELDED_POOL_MODE = "local_test";
    process.env.GHOLA_ENABLE_MOCK_ATTESTED_PROVIDER = "true";
    process.env.GHOLA_SOLANA_PERPS_LIVE_MODE = "sdk_runner";
    process.env.GHOLA_PRIVATE_ACCOUNT_BATCH_MIN_DELAY_SECONDS = "0";
    process.env.GHOLA_PRIVATE_ACCOUNT_BATCH_REQUIRED_SET = "2";
  });

  afterEach(async () => {
    await resetPrivateAccountStoreForTests();
    delete process.env.GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN;
    delete process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS;
    delete process.env.GHOLA_CONNECTOR_MODE;
    delete process.env.GHOLA_CUSTOM_SHIELDED_VERIFIER_MODE;
    delete process.env.GHOLA_SHIELDED_POOL_MODE;
    delete process.env.GHOLA_ENABLE_MOCK_ATTESTED_PROVIDER;
    delete process.env.GHOLA_SOLANA_PERPS_LIVE_MODE;
    delete process.env.GHOLA_PRIVATE_ACCOUNT_BATCH_MIN_DELAY_SECONDS;
    delete process.env.GHOLA_PRIVATE_ACCOUNT_BATCH_REQUIRED_SET;
    delete process.env.GHOLA_V6_HYPERLIQUID_PILOT_ENABLED;
    delete process.env.GHOLA_HYPERLIQUID_LIVE_MODE;
    delete process.env.GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL;
    delete process.env.GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_READINESS;
    delete process.env.GHOLA_PRIVATE_RUNTIME_URL;
    delete process.env.GHOLA_PRIVATE_RUNTIME_MEASUREMENT;
  });

  it("publishes commitment-safe connector manifests and readiness", async () => {
    const manifestRes = await manifestsRoute();
    const manifests = await manifestRes.json();
    expect(manifestRes.status).toBe(200);
    expect(manifests.manifests).toHaveLength(8);
    expect(manifests.manifests.map((item: { platform_class: string }) => item.platform_class))
      .toEqual(expect.arrayContaining(["solana_perps_market", "solana_swap_aggregator"]));
    expect(manifests.manifests[0].manifest_commitment).toMatch(/^connector_manifest_/);
    expect(manifests.manifests[0].manifest_auth_commitment).toMatch(/^connector_manifest_auth_/);
    expect(JSON.stringify(manifests)).not.toContain("\"signature\"");

    const readinessRes = await readinessRoute(
      post("/v1/private-account/connectors/readiness", {
        platform_class: "solana_private_balance",
      }),
    );
    const readiness = await readinessRes.json();
    expect(readinessRes.status).toBe(200);
    expect(readiness.readiness[0].status).toBe("ready");
    expect(readiness.readiness[0].connector_readiness_commitment).toMatch(/^connector_readiness_/);
  });

  it("reports Hyperliquid tiny-fill connector as globally launchable without per-account vault state", async () => {
    delete process.env.GHOLA_CONNECTOR_MODE;
    delete process.env.GHOLA_SHIELDED_POOL_MODE;
    process.env.GHOLA_V6_HYPERLIQUID_PILOT_ENABLED = "true";
    process.env.GHOLA_HYPERLIQUID_LIVE_MODE = "tiny_fill";
    process.env.GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL = "https://worker.ghola.test";
    process.env.GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_READINESS = "ready";
    process.env.GHOLA_PRIVATE_RUNTIME_URL = "https://runtime.ghola.test";
    process.env.GHOLA_PRIVATE_RUNTIME_MEASUREMENT = "measurement-test";

    const readinessRes = await readinessRoute(
      post("/v1/private-account/connectors/readiness", {
        platform_class: "hyperliquid_style_market",
      }),
    );
    const readiness = await readinessRes.json();

    expect(readinessRes.status).toBe(200);
    expect(readiness.readiness[0]).toMatchObject({
      platform_class: "hyperliquid_style_market",
      status: "ready",
      live_submit_enabled: true,
    });
    expect(readiness.readiness[0].reason_codes).not.toContain("hyperliquid_execution_vault_not_ready");
    expect(readiness.readiness[0].reason_codes).not.toContain("shielded_funding_evidence_required");
    expect(JSON.stringify(readiness).toLowerCase()).not.toContain("jurisdiction");
  });

  it("compiles only commitment-safe connector tickets", async () => {
    const intentRes = await createIntent(
      post("/v1/private-account/actions/intent", {
        action_class: "transfer",
        product_bucket: "stablecoin",
      }),
    );
    const intent = await intentRes.json();
    const forbiddenRes = await compileIntentRoute(
      post("/v1/private-account/actions/compile-intent", {
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

    const compileRes = await compileIntentRoute(
      post("/v1/private-account/actions/compile-intent", {
        intent_id: intent.intent_id,
        platform_class: "solana_private_balance",
        requested_rail: "shielded_pool",
        safe_input: {
          amount_bucket: "25",
          asset_bucket: "stablecoin",
          destination_class: "ghola_user",
          urgency: "maximum_privacy",
          solver_count_bucket: "5+",
        },
      }),
    );
    const compiled = await compileRes.json();
    expect(compileRes.status).toBe(201);
    expect(compiled.compiled_intent.compiler_commitment).toMatch(/^intent_compiler_/);
    expect(compiled.compiled_intent.ticket_commitment).toMatch(/^connector_ticket_/);
    expect(compiled.connector_context.manifest_commitment).toBe(compiled.manifest.manifest_commitment);
  });

  it("describes Hyperliquid as BYO venue access in connector context", async () => {
    process.env.GHOLA_V6_HYPERLIQUID_PILOT_ENABLED = "true";
    const intentRes = await createIntent(
      post("/v1/private-account/actions/intent", {
        action_class: "trade_on_platform",
        product_bucket: "perps",
      }),
    );
    const intent = await intentRes.json();
    const compileRes = await compileIntentRoute(
      post("/v1/private-account/actions/compile-intent", {
        intent_id: intent.intent_id,
        platform_class: "hyperliquid_style_market",
        requested_rail: "direct_public_fallback",
        safe_input: {
          amount_bucket: "5",
          asset_bucket: "BTC",
          destination_class: "platform_subaccount",
          urgency: "fast_degraded",
          solver_count_bucket: "5+",
        },
      }),
    );
    const compiled = await compileRes.json();

    expect(compileRes.status).toBe(201);
    expect(compiled.connector_context).toMatchObject({
      venue_access_source: "user_provided_credentials",
      ghola_access_role: "private_execution_router",
      venue_gate: "venue_accepts_or_rejects_credentials",
      venue_visibility: "execution_account_and_order_activity",
      source_wallet_visibility: "not_exposed_to_public_chain_by_ghola",
      privacy_claim: "venue_visible_order_degraded",
    });
    expect(JSON.stringify(compiled).toLowerCase()).not.toContain("bypass");
    expect(JSON.stringify(compiled).toLowerCase()).not.toContain("jurisdiction");
  });

  it("verifies Phoenix no-submit connection without exposing raw fields", async () => {
    const statusRes = await getVenueVault(
      get("/v1/private-account/venues/solana_perps_market/vault"),
      { params: Promise.resolve({ platform_class: "solana_perps_market" }) },
    );
    const status = await statusRes.json();
    const accountCommitment = status.account_commitment;
    expect(accountCommitment).toMatch(/^acct_/);

    const vaultAad = [
      "ghola/solana-perps-execution-vault-v1",
      `account:${accountCommitment}`,
      "recipient:mock_attested:dev",
      "mode:user_stealth",
      "network:mainnet",
      "venue:phoenix",
    ].join("|");
    const sealRes = await sealVenueVault(
      post("/v1/private-account/venues/solana_perps_market/vault", {
        execution_mode: "user_stealth",
        encrypted_execution_vault: {
          alg: "sealed-provider-v1",
          ciphertext: "sealed-phoenix-vault",
          recipient: "mock_attested:dev",
          aad: vaultAad,
        },
      }),
      { params: Promise.resolve({ platform_class: "solana_perps_market" }) },
    );
    expect(sealRes.status).toBe(201);

    const workOrderCommitment = "connector_work_order_phoenix_verify_test";
    const verifyRes = await verifyNoSubmitRoute(
      post("/v1/private-account/connectors/verify-no-submit", {
        platform_class: "solana_perps_market",
        work_order_commitment: workOrderCommitment,
        encrypted_execution_instruction_bundle: {
          alg: "sealed-provider-v1",
          ciphertext: "sealed-phoenix-instruction",
          recipient: "mock_attested:dev",
          aad: [
            "ghola/private-execution-instruction-v1",
            `work_order:${workOrderCommitment}`,
            "venue:phoenix",
            "recipient:mock_attested:dev",
          ].join("|"),
        },
      }),
    );
    const verified = await verifyRes.json();

    expect(verifyRes.status).toBe(200);
    expect(verified.verification.status).toBe("verified_no_funds");
    expect(verified.verification.checks.transaction_broadcast).toBe(false);
    expect(verified.verification.verification_commitment).toMatch(/^connector_no_submit_verification_/);
    expect(verified.verification.live_readiness_certificate.status).toBe("ready_to_attempt_broadcast");
    expect(verified.verification.live_readiness_certificate.broadcast_performed).toBe(false);
    expect(verified.verification.live_readiness_certificate.final_fill_proven).toBe(false);
    expect(verified.verification.live_readiness_certificate.certificate_commitment).toMatch(
      /^live_readiness_certificate_/,
    );
    expect(verified.verification.live_readiness_certificate.what_is_not_proven).toContain("the order filled");
    expect(JSON.stringify(verified)).not.toContain("sealed-phoenix-vault");
    expect(JSON.stringify(verified)).not.toContain("sealed-phoenix-instruction");
  });

  it("binds connector evidence into Private Mode execution receipts", async () => {
    await importCompatibleFunding("connector_user_1");
    await importCompatibleFunding("connector_user_2");
    const safeInput = {
      amount_bucket: "25",
      asset_bucket: "stablecoin",
      destination_class: "ghola_user",
      urgency: "maximum_privacy",
      solver_count_bucket: "5+",
    };
    const intentRes = await createIntent(
      post("/v1/private-account/actions/intent", {
        action_class: "transfer",
        product_bucket: "stablecoin",
      }),
    );
    const intent = await intentRes.json();
    const previewRes = await previewAction(
      post("/v1/private-account/actions/privacy-preview", {
        intent_id: intent.intent_id,
        platform_class: "solana_private_balance",
        requested_rail: "shielded_pool",
        safe_input: safeInput,
      }),
    );
    const waiting = await previewRes.json();
    expect(waiting.preview.connector_context.manifest_commitment).toMatch(/^connector_manifest_/);
    expect(waiting.preview.claim_status).toBe("wait_for_anonymity");

    const queuedRes = await queueAction(
      post("/v1/private-account/actions/queue", {
        intent_id: intent.intent_id,
        preview_commitment: waiting.preview.preview_commitment,
      }),
    );
    const queued = await queuedRes.json();
    await runBatchCoordinator(
      internalPost("/v1/private-account/funding/batch/run", {
        queue_id: queued.queued_action.queue_id,
      }),
    );
    const refreshedRes = await refreshQueue(
      post("/v1/private-account/actions/queue/refresh", {
        queue_id: queued.queued_action.queue_id,
        safe_input: safeInput,
      }),
    );
    const refreshed = await refreshedRes.json();
    expect(refreshed.preview.claim_status).toBe("private_mode_available");
    expect(refreshed.preview.connector_context.connector_status).toBe("ready");
    expect(refreshed.preview.connector_context.main_wallet_exposed).toBe(false);

    const planRes = await planAction(
      post("/v1/private-account/actions/plan", {
        preview_commitment: refreshed.preview.preview_commitment,
      }),
    );
    const plan = await planRes.json();
    expect(plan.plan.manifest_commitment).toBe(refreshed.preview.connector_context.manifest_commitment);
    expect(plan.plan.compiler_commitment).toBe(refreshed.preview.connector_context.compiler_commitment);

    const approvalRes = await approveAction(
      post("/v1/private-account/actions/approve", {
        intent_id: intent.intent_id,
        preview_commitment: refreshed.preview.preview_commitment,
        execution_plan_commitment: plan.plan.plan_commitment,
      }),
    );
    const approval = await approvalRes.json();
    const executeRes = await executeAction(
      post("/v1/private-account/actions/execute", {
        intent_id: intent.intent_id,
        preview_commitment: refreshed.preview.preview_commitment,
        approval_commitment: approval.approval.approval_commitment,
      }),
    );
    const executed = await executeRes.json();
    expect(executeRes.status).toBe(201);
    expect(executed.receipt.manifest_commitment).toBe(refreshed.preview.connector_context.manifest_commitment);
    expect(executed.receipt.compiler_commitment).toBe(refreshed.preview.connector_context.compiler_commitment);
    expect(executed.receipt.work_order_commitment).toMatch(/^connector_work_order_/);
    expect(executed.receipt.connector_result_commitment).toMatch(/^connector_result_/);
    expect(executed.receipt.venue_access_source).toBe("none");
    expect(executed.receipt.ghola_access_role).toBe("private_state_operator");

    const verifyRes = await verifyReceiptAction(
      post("/v1/private-account/actions/verify-receipt", {
        receipt_commitment: executed.receipt.receipt_commitment,
      }),
    );
    const verified = await verifyRes.json();
    expect(verified.verified).toBe(true);
    expect(verified.checks.manifest_bound).toBe("pass");
    expect(verified.checks.connector_readiness_bound).toBe("pass");
    expect(verified.checks.compiler_bound).toBe("pass");
    expect(verified.checks.linkability_bound).toBe("pass");
    expect(verified.checks.work_order_bound).toBe("pass");
    expect(verified.checks.connector_result_bound).toBe("pass");

    const opsRes = await operationsRoute(
      get("/v1/private-account/connectors/operations"),
    );
    const ops = await opsRes.json();
    expect(ops.work_order_depth).toBe(1);
    expect(ops.results[0].connector_result_commitment).toBe(executed.receipt.connector_result_commitment);
    expect(ops.linkability.length).toBeGreaterThan(0);
  });
});
