import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { GET as manifestsRoute } from "./manifests/route";
import { POST as readinessRoute } from "./readiness/route";
import { POST as compileIntentRoute } from "../actions/compile-intent/route";
import { POST as createIntent } from "../actions/intent/route";
import { POST as previewAction } from "../actions/privacy-preview/route";
import { POST as queueAction } from "../actions/queue/route";
import { POST as refreshQueue } from "../actions/queue/refresh/route";
import { GET as operationsRoute } from "./operations/route";
import { POST as verifyNoSubmitRoute } from "./verify-no-submit/route";
import { GET as getHyperliquidVault, POST as sealHyperliquidVault } from "../hyperliquid/vault/route";
import { POST as allocateHyperliquidManaged } from "../hyperliquid/managed-allocation/route";
import { POST as createFundingInstruction } from "../funding/instruction/route";
import { POST as importFunding } from "../funding/import/route";
import { POST as runBatchCoordinator } from "../funding/batch/run/route";
import { GET as getGholaBalance } from "../balance/route";
import { POST as createBalanceFundingIntent } from "../balance/funding-intent/route";
import { POST as importBalanceCredit } from "../balance/import-credit/route";
import { GET as getVenueVault, POST as sealVenueVault } from "../venues/[platform_class]/vault/route";
import { POST as armVenueAgent } from "../venues/[platform_class]/agent/session/route";
import { POST as verifyVenueEligibility } from "../venues/[platform_class]/eligibility/route";
import { POST as allocatePooledVenue } from "../venues/[platform_class]/pool/allocate/route";
import { POST as allocateOmnibus } from "../omnibus/allocate/route";
import {
  getLatestLiveTradingCanaryReport,
  resetPrivateAccountStoreForTests,
} from "@/lib/private-account-store";
import { gholaCommitment } from "@/lib/private-account";
import { signHyperliquidApiWalletBinding } from "@/lib/hyperliquid-api-wallet";

const INTERNAL_TOKEN = "test_internal_private_account_token";
const JUPITER_SOL_MINT = "So11111111111111111111111111111111111111112";
const JUPITER_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TEST_HYPERLIQUID_OWNER = "0x1111111111111111111111111111111111111111";
const TEST_HYPERLIQUID_AGENT = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const TEST_HYPERLIQUID_AGENT_KEY = `0x${"00".repeat(31)}01`;

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

function textPost(path: string, body: string, authorization = AUTH) {
  return new Request(`https://ghola.test${path}`, {
    method: "POST",
    headers: { "content-type": "text/plain", authorization },
    body,
  });
}

function proofPost(
  path: string,
  body: unknown,
  userId: string,
  secret: string,
  nonce = `nonce-${Date.now()}-${Math.random().toString(16).slice(2)}`,
) {
  const timestamp = String(Date.now());
  const bodyHash = createHash("sha256").update(stableJson(body)).digest("hex");
  const message = [
    "POST",
    path,
    gholaCommitment("owner", userId),
    timestamp,
    nonce,
    bodyHash,
  ].join("\n");
  const proof = createHmac("sha256", secret).update(message).digest("hex");
  return new Request(`https://ghola.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: auth(userId),
      "x-ghola-request-timestamp": timestamp,
      "x-ghola-request-nonce": nonce,
      "x-ghola-request-proof": proof,
    },
    body: JSON.stringify(body),
  });
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
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

async function creditGholaBalance(userId: string, amountBucket = "25") {
  const instructionRes = await createBalanceFundingIntent(
    post("/v1/private-account/balance/funding-intent", {
      amount_bucket: amountBucket,
      asset_bucket: "stablecoin",
    }, auth(userId)),
  );
  expect(instructionRes.status).toBe(201);
  const instruction = await instructionRes.json();
  const importRes = await importBalanceCredit(
    post("/v1/private-account/balance/import-credit", {
      funding_intent_id: instruction.instruction.funding_intent_id,
      receipt_id: `custom_receipt_balance_${userId}_${amountBucket}_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    }, auth(userId)),
  );
  expect(importRes.status).toBe(201);
  return importRes.json();
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
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify([{
      address: TEST_HYPERLIQUID_AGENT,
      name: "ghola-test",
      validUntil: null,
    }]), { status: 200, headers: { "content-type": "application/json" } }));
  });

  afterEach(async () => {
    await resetPrivateAccountStoreForTests();
    vi.unstubAllEnvs();
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
    delete process.env.GHOLA_VENUE_JUPITER_PILOT_ENABLED;
    delete process.env.GHOLA_JUPITER_LIVE_MODE;
    vi.restoreAllMocks();
    delete process.env.GHOLA_V6_COINBASE_PILOT_ENABLED;
    delete process.env.GHOLA_COINBASE_PARTNER_OMNIBUS_ENABLED;
    delete process.env.GHOLA_COINBASE_PARTNER_OMNIBUS_POOL_READY;
    delete process.env.GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL;
    delete process.env.GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_READINESS;
    delete process.env.GHOLA_PRIVATE_RUNTIME_URL;
    delete process.env.GHOLA_PRIVATE_RUNTIME_MEASUREMENT;
    delete process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_MODE;
    delete process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET;
    delete process.env.GHOLA_PRIVATE_ACCOUNT_LIVE_RATE_LIMIT_MAX;
    delete process.env.GHOLA_PRIVATE_ACCOUNT_LIVE_RATE_LIMIT_WINDOW_MS;
    delete process.env.GHOLA_PRIVATE_AGENT_PROVIDER;
    delete process.env.PRIVATE_AGENT_WORKER_CAPABILITY_SECRET;
  });

  it("guards mutating live routes with JSON, auth, proof, replay, and rate limits", async () => {
    const nonJsonRes = await verifyNoSubmitRoute(
      textPost("/v1/private-account/connectors/verify-no-submit", "not json"),
    );
    expect(nonJsonRes.status).toBe(415);
    await expect(nonJsonRes.json()).resolves.toMatchObject({
      error: "json_content_type_required",
    });

    const missingAuthRes = await verifyNoSubmitRoute(
      post("/v1/private-account/connectors/verify-no-submit", {}, ""),
    );
    expect(missingAuthRes.status).toBe(401);

    process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_MODE = "enforce";
    process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET =
      "test_private_account_request_proof_secret_32";
    const missingProofRes = await verifyNoSubmitRoute(
      post("/v1/private-account/connectors/verify-no-submit", {}),
    );
    expect(missingProofRes.status).toBe(403);
    await expect(missingProofRes.json()).resolves.toMatchObject({
      error: "request_proof_required",
    });

    const proofBody = {
      platform_class: "hyperliquid_style_market",
      work_order_commitment: "work_order_guard_test",
      encrypted_execution_instruction_bundle: {
        instruction_commitment: "instruction_guard_test",
      },
    };
    const replayNonce = "nonce-guard-replay-1";
    const firstProofRes = await verifyNoSubmitRoute(
      proofPost(
        "/v1/private-account/connectors/verify-no-submit",
        proofBody,
        "connector_user_1",
        process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET,
        replayNonce,
      ),
    );
    expect(firstProofRes.status).toBe(400);
    const replayRes = await verifyNoSubmitRoute(
      proofPost(
        "/v1/private-account/connectors/verify-no-submit",
        proofBody,
        "connector_user_1",
        process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET,
        replayNonce,
      ),
    );
    expect(replayRes.status).toBe(403);
    await expect(replayRes.json()).resolves.toMatchObject({
      error: "request_proof_replayed",
    });

    delete process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_MODE;
    process.env.GHOLA_PRIVATE_ACCOUNT_LIVE_RATE_LIMIT_MAX = "1";
    process.env.GHOLA_PRIVATE_ACCOUNT_LIVE_RATE_LIMIT_WINDOW_MS = "60000";
    const rateUser = auth("connector_rate_limit_user");
    const firstLimited = await verifyNoSubmitRoute(
      post("/v1/private-account/connectors/verify-no-submit", {}, rateUser),
    );
    expect(firstLimited.status).toBe(400);
    const secondLimited = await verifyNoSubmitRoute(
      post("/v1/private-account/connectors/verify-no-submit", {}, rateUser),
    );
    expect(secondLimited.status).toBe(429);
    await expect(secondLimited.json()).resolves.toMatchObject({
      error: "private_account_rate_limited",
    });
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
        action_class: "trade_on_platform",
        platform_class: "hyperliquid_style_market",
        venue_id: "hyperliquid",
        product_bucket: "perps",
      }),
    );
    const intent = await intentRes.json();
    const forbiddenRes = await compileIntentRoute(
      post("/v1/private-account/actions/compile-intent", {
        intent_id: intent.intent_id,
        platform_class: "hyperliquid_style_market",
        safe_input: {
          venue_id: "hyperliquid",
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
        platform_class: "hyperliquid_style_market",
        requested_rail: "direct_public_fallback",
        safe_input: {
          venue_id: "hyperliquid",
          amount_bucket: "25",
          asset_bucket: "BTC",
          destination_class: "platform_subaccount",
          urgency: "fast_degraded",
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
        platform_class: "hyperliquid_style_market",
        venue_id: "hyperliquid",
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
          venue_id: "hyperliquid",
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

    const armRes = await armVenueAgent(
      post("/v1/private-account/venues/solana_perps_market/agent/session", {
        execution_mode: "user_stealth",
        market_allowlist: ["SOL-PERP"],
        max_notional_bucket: "5",
        max_order_count: 3,
      }),
      { params: Promise.resolve({ platform_class: "solana_perps_market" }) },
    );
    const armed = await armRes.json();
    expect(armRes.status).toBe(201);
    expect(armed).toMatchObject({
      status: "armed",
      venue_id: "phoenix",
      platform_class: "solana_perps_market",
      execution_mode: "user_stealth",
    });
    expect(armed.agent_session_commitment).toMatch(/^venue_agent_session_/);

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

    expect(verifyRes.status, JSON.stringify(verified)).toBe(200);
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

  it("verifies Jupiter no-submit connection without exposing raw fields", async () => {
    process.env.GHOLA_VENUE_JUPITER_PILOT_ENABLED = "true";
    process.env.GHOLA_JUPITER_LIVE_MODE = "full";

    const statusRes = await getVenueVault(
      get("/v1/private-account/venues/solana_swap_aggregator/vault"),
      { params: Promise.resolve({ platform_class: "solana_swap_aggregator" }) },
    );
    const status = await statusRes.json();
    const accountCommitment = status.account_commitment;
    expect(accountCommitment).toMatch(/^acct_/);

    const vaultAad = [
      "ghola/solana-swap-execution-vault-v1",
      `account:${accountCommitment}`,
      "recipient:mock_attested:dev",
      "mode:user_stealth",
      "network:mainnet",
      "venue:jupiter",
    ].join("|");
    const sealRes = await sealVenueVault(
      post("/v1/private-account/venues/solana_swap_aggregator/vault", {
        execution_mode: "user_stealth",
        encrypted_execution_vault: {
          alg: "sealed-provider-v1",
          ciphertext: "sealed-jupiter-vault",
          recipient: "mock_attested:dev",
          aad: vaultAad,
        },
      }),
      { params: Promise.resolve({ platform_class: "solana_swap_aggregator" }) },
    );
    expect(sealRes.status).toBe(201);

    const armRes = await armVenueAgent(
      post("/v1/private-account/venues/solana_swap_aggregator/agent/session", {
        execution_mode: "user_stealth",
        market_allowlist: ["SOL/USDC"],
        max_notional_bucket: "5",
        max_order_count: 3,
      }),
      { params: Promise.resolve({ platform_class: "solana_swap_aggregator" }) },
    );
    const armed = await armRes.json();
    expect(armRes.status).toBe(201);
    expect(armed).toMatchObject({
      status: "armed",
      venue_id: "jupiter",
      platform_class: "solana_swap_aggregator",
      execution_mode: "user_stealth",
    });
    expect(armed.agent_session_commitment).toMatch(/^venue_agent_session_/);

    const workOrderCommitment = "connector_work_order_jupiter_verify_test";
    const verifyRes = await verifyNoSubmitRoute(
      post("/v1/private-account/connectors/verify-no-submit", {
        platform_class: "solana_swap_aggregator",
        work_order_commitment: workOrderCommitment,
        encrypted_execution_instruction_bundle: {
          alg: "sealed-provider-v1",
          ciphertext: "sealed-jupiter-instruction",
          recipient: "mock_attested:dev",
          aad: [
            "ghola/private-execution-instruction-v1",
            `work_order:${workOrderCommitment}`,
            "venue:jupiter",
            "recipient:mock_attested:dev",
          ].join("|"),
        },
      }),
    );
    const verified = await verifyRes.json();

    expect(verifyRes.status).toBe(200);
    expect(verified.verification.status).toBe("verified_no_funds");
    expect(verified.verification.checks.transaction_broadcast).toBe(false);
    expect(verified.verification.checks.jupiter_api_reachable).toBe(true);
    expect(verified.verification.verification_commitment).toMatch(/^connector_no_submit_verification_/);
    expect(verified.verification.live_readiness_certificate.status).toBe("ready_to_attempt_broadcast");
    expect(verified.verification.live_readiness_certificate.venue_id).toBe("jupiter");
    expect(verified.verification.live_readiness_certificate.broadcast_performed).toBe(false);
    expect(verified.verification.live_readiness_certificate.final_fill_proven).toBe(false);
    expect(verified.verification.live_readiness_certificate.what_is_proven).toContain(
      "Jupiter swap transaction was built without broadcasting",
    );
    expect(JSON.stringify(verified)).not.toContain("sealed-jupiter-vault");
    expect(JSON.stringify(verified)).not.toContain("sealed-jupiter-instruction");
    expect(JSON.stringify(verified)).not.toContain(JUPITER_SOL_MINT);
    expect(JSON.stringify(verified)).not.toContain(JUPITER_USDC_MINT);
  });

  it("verifies Hyperliquid no-submit connection without exposing raw fields", async () => {
    process.env.GHOLA_V6_HYPERLIQUID_PILOT_ENABLED = "true";
    process.env.GHOLA_HYPERLIQUID_LIVE_MODE = "tiny_fill";
    const statusRes = await getHyperliquidVault(get("/v1/private-account/hyperliquid/vault"));
    const status = await statusRes.json();
    const accountCommitment = status.account_commitment;
    expect(accountCommitment).toMatch(/^acct_/);

    const vaultAad = [
      "ghola/hyperliquid-execution-vault-v1",
      `account:${accountCommitment}`,
      "recipient:mock_attested:dev",
      "network:mainnet",
    ].join("|");
    const sealRes = await sealHyperliquidVault(
      post("/v1/private-account/hyperliquid/vault", {
        encrypted_execution_vault: {
          alg: "sealed-provider-v1",
          ciphertext: "sealed-hyperliquid-vault",
          recipient: "mock_attested:dev",
          aad: vaultAad,
        },
        credential_binding: await signHyperliquidApiWalletBinding({
          privateKey: TEST_HYPERLIQUID_AGENT_KEY,
          accountCommitment,
          network: "mainnet",
          ownerAddress: TEST_HYPERLIQUID_OWNER,
        }),
      }),
    );
    expect(sealRes.status).toBe(201);

    const workOrderCommitment = "connector_work_order_hyperliquid_verify_test";
    const verifyRes = await verifyNoSubmitRoute(
      post("/v1/private-account/connectors/verify-no-submit", {
        platform_class: "hyperliquid_style_market",
        work_order_commitment: workOrderCommitment,
        encrypted_execution_instruction_bundle: {
          alg: "sealed-provider-v1",
          ciphertext: "sealed-hyperliquid-instruction",
          recipient: "mock_attested:dev",
          aad: [
            "ghola/private-execution-instruction-v1",
            `work_order:${workOrderCommitment}`,
            "venue:hyperliquid",
            "recipient:mock_attested:dev",
          ].join("|"),
        },
        hyperliquid_session: {
          execution_mode: "byo_api_key",
          market_allowlist: ["HYPE"],
          max_notional_bucket: "25",
          max_order_count: 10,
          kill_switch: false,
        },
      }),
    );
    const verified = await verifyRes.json();

    expect(verifyRes.status, JSON.stringify(verified)).toBe(200);
    expect(verified.verification.status).toBe("verified_no_funds");
    expect(verified.hyperliquid_agent_session).toMatchObject({
      status: "armed",
      execution_mode: "byo_api_key",
    });
    expect(verified.connection_proof_persisted).toBe(false);
    expect(verified.connection_proof_reason).toBe("local_test_proof_not_persisted");
    expect(verified.verification.checks.transaction_broadcast).toBe(false);
    expect(verified.verification.checks.order_request_built).toBe(true);
    expect(verified.verification.verification_commitment).toMatch(/^connector_no_submit_verification_/);
    expect(verified.verification.live_readiness_certificate.status).toBe("ready_to_attempt_broadcast");
    expect(verified.verification.live_readiness_certificate.venue_id).toBe("hyperliquid");
    expect(verified.verification.live_readiness_certificate.broadcast_performed).toBe(false);
    expect(verified.verification.live_readiness_certificate.final_fill_proven).toBe(false);
    expect(verified.verification.live_readiness_certificate.what_is_proven).toContain(
      "Hyperliquid order request was built without broadcasting",
    );
    expect(JSON.stringify(verified)).not.toContain("sealed-hyperliquid-vault");
    expect(JSON.stringify(verified)).not.toContain("sealed-hyperliquid-instruction");
  });

  it("persists Hyperliquid readiness only after every live proof check passes", async () => {
    process.env.GHOLA_CONNECTOR_MODE = "http";
    delete process.env.GHOLA_SHIELDED_POOL_MODE;
    process.env.GHOLA_V6_HYPERLIQUID_PILOT_ENABLED = "true";
    process.env.GHOLA_HYPERLIQUID_LIVE_MODE = "tiny_fill";
    process.env.GHOLA_PRIVATE_AGENT_PROVIDER = "mock_attested";
    process.env.GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL = "https://worker.ghola.test";
    process.env.GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_READINESS = "ready";
    process.env.PRIVATE_AGENT_WORKER_CAPABILITY_SECRET = "test-worker-capability-secret-32-bytes";
    let sealedAccessPolicy: string | null = null;
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "https://api.hyperliquid.xyz/info") {
        const body = JSON.parse(String(init?.body || "{}")) as { type?: string };
        if (body.type === "frontendOpenOrders") {
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify([{
          address: TEST_HYPERLIQUID_AGENT,
          name: "ghola-test",
          validUntil: null,
        }]), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "https://worker.ghola.test/hyperliquid/sessions") {
        const body = JSON.parse(String(init?.body || "{}"));
        expect(body.policy_commitment).toBe(sealedAccessPolicy);
        return new Response(JSON.stringify({
          status: "armed",
          hyperliquid_session_commitment: "hyperliquid_session_combined_test",
        }), { status: 201, headers: { "content-type": "application/json" } });
      }
      if (url === "https://worker.ghola.test/hyperliquid/verify") {
        const request = JSON.parse(String(init?.body || "{}"));
        return new Response(JSON.stringify({
          status: "verified_no_funds",
          venue_id: request.venue_id,
          platform_class: request.platform_class,
          work_order_commitment: request.work_order_commitment,
          verification_commitment: "connector_no_submit_verification_live_test",
          result_commitment: "connector_no_submit_result_live_test",
          provider_ref_commitment: "connector_no_submit_provider_live_test",
          checks: {
            sealed_vault_opened: true,
            sealed_instruction_opened: true,
            authority_derived: true,
            policy_enforced: true,
            live_gate_enforced: true,
            api_wallet_loaded: true,
            hyperliquid_api_reachable: true,
            hyperliquid_sdk_ready: true,
            account_read_checked: true,
            order_request_built: true,
            live_venue_checked: true,
            transaction_broadcast: false,
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "https://worker.ghola.test/hyperliquid/account-snapshot") {
        return new Response(JSON.stringify({
          status: "ready_to_trade",
          account_source: "sealed_byo",
          trading_enabled: true,
          equity_bucket: "ready",
          positions: [],
          open_orders: [],
          recent_fills: [],
          stream_status: "snapshot",
          last_checked_at: new Date().toISOString(),
          next_step: "Preview trade",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    });

    const statusRes = await getHyperliquidVault(get("/v1/private-account/hyperliquid/vault"));
    const status = await statusRes.json();
    const workOrderCommitment = "connector_work_order_hyperliquid_persist_test";
    const sealRes = await sealHyperliquidVault(
      post("/v1/private-account/hyperliquid/vault", {
        encrypted_execution_vault: {
          alg: "sealed-provider-v1",
          ciphertext: "sealed-hyperliquid-vault-persist",
          recipient: "mock_attested:dev",
          aad: [
            "ghola/hyperliquid-execution-vault-v1",
            `account:${status.account_commitment}`,
            "recipient:mock_attested:dev",
            "network:mainnet",
          ].join("|"),
        },
        credential_binding: await signHyperliquidApiWalletBinding({
          privateKey: TEST_HYPERLIQUID_AGENT_KEY,
          accountCommitment: status.account_commitment,
          network: "mainnet",
          ownerAddress: TEST_HYPERLIQUID_OWNER,
        }),
      }),
    );
    expect(sealRes.status).toBe(201);
    const sealed = await sealRes.json();
    sealedAccessPolicy = sealed.hyperliquid_execution_vault.policy_commitment;

    const verifyRes = await verifyNoSubmitRoute(
      post("/v1/private-account/connectors/verify-no-submit", {
        platform_class: "hyperliquid_style_market",
        work_order_commitment: workOrderCommitment,
        encrypted_execution_instruction_bundle: {
          alg: "sealed-provider-v1",
          ciphertext: "sealed-hyperliquid-instruction-persist",
          recipient: "mock_attested:dev",
          aad: [
            "ghola/private-execution-instruction-v1",
            `work_order:${workOrderCommitment}`,
            "venue:hyperliquid",
            "recipient:mock_attested:dev",
          ].join("|"),
        },
        hyperliquid_session: {
          execution_mode: "byo_api_key",
          market_allowlist: ["HYPE"],
          max_notional_bucket: "25",
          max_order_count: 10,
          kill_switch: false,
        },
      }),
    );
    const verified = await verifyRes.json();
    expect(verifyRes.status, JSON.stringify(verified)).toBe(200);
    expect(verified.hyperliquid_agent_session.agent_session_commitment)
      .toBe("hyperliquid_session_combined_test");
    expect(verified.connection_proof_persisted, JSON.stringify(verified)).toBe(true);
    expect(verified.connection_proof_reason).toBeNull();
    expect(verified.release_canary_persisted, JSON.stringify(verified)).toBe(true);
    expect(verified.release_canary_reason).toBeNull();

    const releaseCanary = await getLatestLiveTradingCanaryReport(
      "hyperliquid",
      "capital_free_no_submit",
    );
    expect(releaseCanary).toMatchObject({
      status: "green",
      live_mode: "no_submit",
      broadcast_performed: false,
      reconcile_status: "reconciled",
      position_count: 0,
      open_order_count: 0,
      receipt_commitment: "connector_no_submit_verification_live_test",
      result_commitment: "connector_no_submit_result_live_test",
    });

    const readyRes = await getHyperliquidVault(get("/v1/private-account/hyperliquid/vault"));
    const ready = await readyRes.json();
    expect(ready.ready).toBe(true);
    expect(ready.connection_proof).toMatchObject({
      status: "verified_no_funds",
      verification_commitment: "connector_no_submit_verification_live_test",
    });
  });

  it("verifies Coinbase readiness without submitting or exposing raw fields", async () => {
    process.env.GHOLA_V6_COINBASE_PILOT_ENABLED = "true";
    process.env.GHOLA_COINBASE_PARTNER_OMNIBUS_ENABLED = "true";
    process.env.GHOLA_COINBASE_PARTNER_OMNIBUS_POOL_READY = "true";

    const allocationRes = await allocateOmnibus(
      post("/v1/private-account/omnibus/allocate", {
        settlement_funding_commitment: "funding_import_commitment_test",
        utilization_bucket: "5",
      }),
    );
    expect(allocationRes.status).toBe(201);

    const workOrderCommitment = "connector_work_order_coinbase_verify_test";
    const verifyRes = await verifyNoSubmitRoute(
      post("/v1/private-account/connectors/verify-no-submit", {
        platform_class: "coinbase_style_provider",
        work_order_commitment: workOrderCommitment,
        encrypted_execution_instruction_bundle: {
          alg: "sealed-provider-v1",
          ciphertext: "sealed-coinbase-instruction",
          recipient: "mock_attested:dev",
          aad: [
            "ghola/private-execution-instruction-v1",
            `work_order:${workOrderCommitment}`,
            "venue:coinbase_advanced",
            "recipient:mock_attested:dev",
          ].join("|"),
        },
      }),
    );
    const verified = await verifyRes.json();

    expect(verifyRes.status).toBe(200);
    expect(verified.verification.status).toBe("verified_no_funds");
    expect(verified.verification.live_readiness_certificate.venue_id).toBe("coinbase_advanced");
    expect(verified.verification.live_readiness_certificate.broadcast_performed).toBe(false);
    expect(verified.verification.live_readiness_certificate.final_fill_proven).toBe(false);
    expect(verified.verification.live_readiness_certificate.what_is_proven).toContain(
      "Coinbase order request was built without submitting",
    );
    expect(verified.verification.checks.transaction_broadcast).toBe(false);
    expect(verified.verification.checks.coinbase_order_request_built).toBe(true);
    expect(JSON.stringify(verified)).not.toContain("sealed-coinbase-instruction");
    expect(JSON.stringify(verified).toLowerCase()).not.toContain("api_key");
    expect(JSON.stringify(verified).toLowerCase()).not.toContain("private_key");
  });

  it("rejects pooled venue allocation until venue eligibility is verified", async () => {
    const allocationRes = await allocatePooledVenue(
      post("/v1/private-account/venues/phoenix/pool/allocate", {
        utilization_bucket: "5",
      }),
      { params: Promise.resolve({ platform_class: "phoenix" }) },
    );
    const allocation = await allocationRes.json();

    expect(allocationRes.status).toBe(400);
    expect(allocation.error).toBe("venue_eligibility_required");
  });

  it("allocates Phoenix Vault Mode and verifies no-submit without a user venue key", async () => {
    const eligibilityRes = await verifyVenueEligibility(
      post("/v1/private-account/venues/phoenix/eligibility", {
        credential_type: "self_attested_eligible_user",
      }),
      { params: Promise.resolve({ platform_class: "phoenix" }) },
    );
    expect(eligibilityRes.status).toBe(201);

    const allocationRes = await allocatePooledVenue(
      post("/v1/private-account/venues/phoenix/pool/allocate", {
        utilization_bucket: "5",
      }),
      { params: Promise.resolve({ platform_class: "phoenix" }) },
    );
    const allocation = await allocationRes.json();
    expect(allocationRes.status).toBe(201);
    expect(allocation.pooled_allocation.status).toBe("allocated");
    expect(allocation.pooled_allocation.eligibility_commitment).toMatch(/^venue_eligibility_/);
    expect(allocation.readiness.status).toBe("ready");
    expect(allocation.readiness.eligibility_ready).toBe(true);

    const workOrderCommitment = "connector_work_order_phoenix_pooled_verify_test";
    const verifyRes = await verifyNoSubmitRoute(
      post("/v1/private-account/connectors/verify-no-submit", {
        platform_class: "solana_perps_market",
        work_order_commitment: workOrderCommitment,
        encrypted_execution_instruction_bundle: {
          alg: "sealed-provider-v1",
          ciphertext: "sealed-phoenix-pooled-instruction",
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
    expect(verified.readiness.reason_codes).not.toContain("solana_perps_execution_vault_not_ready");
    expect(verified.verification.live_readiness_certificate.broadcast_performed).toBe(false);
    expect(JSON.stringify(verified)).not.toContain("sealed-phoenix-pooled-instruction");
  });

  it("allocates Hyperliquid Vault Mode and verifies no-submit without a user API wallet", async () => {
    process.env.GHOLA_V6_HYPERLIQUID_PILOT_ENABLED = "true";
    process.env.GHOLA_HYPERLIQUID_LIVE_MODE = "tiny_fill";

    const eligibilityRes = await verifyVenueEligibility(
      post("/v1/private-account/venues/hyperliquid/eligibility", {
        credential_type: "self_attested_eligible_user",
        accepted_terms: true,
        accepted_risk: true,
        jurisdiction_assertion: "non_us",
        country_code: "CA",
      }),
      { params: Promise.resolve({ platform_class: "hyperliquid" }) },
    );
    expect(eligibilityRes.status).toBe(201);

    const blockedAllocationRes = await allocateHyperliquidManaged(
      post("/v1/private-account/hyperliquid/managed-allocation", {
        execution_mode: "ghola_pooled",
        network: "mainnet",
        market_allowlist: ["BTC", "ETH", "SOL"],
        max_notional_bucket: "5",
        max_order_count: 5,
      }),
    );
    const blockedAllocation = await blockedAllocationRes.json();
    expect(blockedAllocationRes.status).toBe(400);
    expect(blockedAllocation.error).toBe("ghola_balance_insufficient");

    const credited = await creditGholaBalance("connector_user_1", "5");
    expect(credited.balance.available_micro_usdc).toBe(5_000_000);
    expect(credited.balance_ledger_entry.entry_kind).toBe("deposit_credit");

    const allocationRes = await allocateHyperliquidManaged(
      post("/v1/private-account/hyperliquid/managed-allocation", {
        execution_mode: "ghola_pooled",
        network: "mainnet",
        market_allowlist: ["BTC", "ETH", "SOL"],
        max_notional_bucket: "5",
        max_order_count: 5,
      }),
    );
    const allocation = await allocationRes.json();
    expect(allocationRes.status).toBe(201);
    expect(allocation.managed_allocation.execution_mode).toBe("ghola_pooled");
    expect(allocation.managed_allocation.network).toBe("mainnet");
    expect(allocation.managed_allocation.eligibility_commitment).toMatch(/^venue_eligibility_/);
    expect(allocation.ghola_balance.available_micro_usdc).toBe(5_000_000);

    const balanceRes = await getGholaBalance(get("/v1/private-account/balance"));
    const balance = await balanceRes.json();
    expect(balanceRes.status).toBe(200);
    expect(balance.balance.available_usd).toBe("5.00");
    expect(balance.recent_ledger_entries[0].entry_kind).toBe("deposit_credit");

    const statusRes = await getHyperliquidVault(get("/v1/private-account/hyperliquid/vault"));
    const status = await statusRes.json();
    expect(status.hyperliquid_execution_vault).toBeNull();
    expect(status.managed_allocation.execution_mode).toBe("ghola_pooled");
    expect(status.venue_access.source).toBe("ghola_pooled_venue_account");

    const workOrderCommitment = "connector_work_order_hyperliquid_pooled_verify_test";
    const verifyRes = await verifyNoSubmitRoute(
      post("/v1/private-account/connectors/verify-no-submit", {
        platform_class: "hyperliquid_style_market",
        work_order_commitment: workOrderCommitment,
        encrypted_execution_instruction_bundle: {
          alg: "sealed-provider-v1",
          ciphertext: "sealed-hyperliquid-pooled-instruction",
          recipient: "mock_attested:dev",
          aad: [
            "ghola/private-execution-instruction-v1",
            `work_order:${workOrderCommitment}`,
            "venue:hyperliquid",
            "recipient:mock_attested:dev",
          ].join("|"),
        },
      }),
    );
    const verified = await verifyRes.json();

    expect(verifyRes.status).toBe(200);
    expect(verified.verification.status).toBe("verified_no_funds");
    expect(verified.readiness.reason_codes).not.toContain("hyperliquid_execution_vault_not_ready");
    expect(verified.readiness.reason_codes).not.toContain("hyperliquid_pooled_allocation_not_ready");
    expect(verified.verification.live_readiness_certificate.venue_id).toBe("hyperliquid");
    expect(verified.verification.live_readiness_certificate.broadcast_performed).toBe(false);
    expect(JSON.stringify(verified)).not.toContain("sealed-hyperliquid-pooled-instruction");
  });

  it("keeps generic Private Mode previews connector-free", async () => {
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
    expect(waiting.preview.connector_context).toBeNull();
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
    expect(refreshed.preview.connector_context).toBeNull();
    expect(refreshed.preview.claim_status).toBe("private_mode_available");
    expect(refreshed.preview.claim_levels_missing).toHaveLength(0);

    const opsRes = await operationsRoute(
      get("/v1/private-account/connectors/operations"),
    );
    const ops = await opsRes.json();
    expect(ops.work_order_depth).toBe(0);
    expect(ops.results).toHaveLength(0);
    expect(ops.linkability).toHaveLength(1);
    expect(ops.linkability[0].platform_class).toBe("solana_private_balance");
  });
});
