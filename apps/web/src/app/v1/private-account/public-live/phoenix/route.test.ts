import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { POST as preparePhoenix } from "./prepare/route";
import { POST as submitPhoenix } from "./submit/route";
import { createOrGetStoredPrivateAccount } from "../../_lib";
import {
  listGholaBalanceLedgerEntries,
  putGholaBalanceLedgerEntry,
  resetPrivateAccountStoreForTests,
} from "@/lib/private-account-store";
import { gholaCommitment } from "@/lib/private-account";
import { buildPublicLivePhoenixChallenge } from "@/lib/private-account-public-live";

const USER_ID = "no_key_beta_user";
const USER_EMAIL = "no-key-beta@example.com";

describe("public Phoenix no-key live routes", () => {
  beforeEach(async () => {
    clearEnv();
    process.env.GHOLA_NO_KEY_LIVE_ENABLED = "true";
    process.env.GHOLA_PUBLIC_LIVE_REQUIRE_AUTH = "true";
    process.env.GHOLA_PUBLIC_LIVE_REQUIRE_BALANCE = "true";
    process.env.GHOLA_PUBLIC_LIVE_ALLOWED_USERS = `${USER_ID},${USER_EMAIL}`;
    process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL = "https://worker.example";
    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN = "worker-token";
    await resetPrivateAccountStoreForTests();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    clearEnv();
    await resetPrivateAccountStoreForTests();
  });

  it("requires a signed-in allowlisted account before preparing no-key live access", async () => {
    mockWorker({ submitStatus: 202 });

    const res = await preparePhoenix(request("/v1/private-account/public-live/phoenix/prepare", {
      ...(await signedWalletProof()),
      ...acknowledgements(),
    }, false));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("public_live_auth_required");
  });

  it("prepares Phoenix access but blocks submit when Ghola balance is insufficient", async () => {
    mockWorker({ submitStatus: 202 });

    const res = await preparePhoenix(request("/v1/private-account/public-live/phoenix/prepare", {
      ...(await signedWalletProof()),
      ...acknowledgements(),
    }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.status).toBe("live_ready");
    expect(body.can_submit_live).toBe(false);
    expect(body.blocking_reason_codes).toContain("ghola_balance_insufficient");
    expect(body.required_margin_micro_usdc).toBe(5_000_000);
  });

  it("reserves Ghola balance and records submitted state around a worker submit", async () => {
    const workerCalls = mockWorker({ submitStatus: 202 });
    const owner = await seedBalance(5_000_000);
    const workOrder = "public_live_phoenix_route_success";

    const res = await submitPhoenix(request("/v1/private-account/public-live/phoenix/submit", {
      ...(await signedWalletProof()),
      ...acknowledgements(),
      ack_live_order: true,
      work_order_commitment: workOrder,
      order_summary: orderSummary(workOrder),
      encrypted_execution_instruction_bundle: sealedInstruction(workOrder),
    }));
    const body = await res.json();
    const entries = await listGholaBalanceLedgerEntries(owner.account_commitment, 20);

    expect(res.status).toBe(202);
    expect(body.status).toBe("submitted");
    expect(body.balance_reservation_commitment).toMatch(/^ghola_balance_ledger_entry_/);
    expect(body.next_status).toBe("pending_reconciliation");
    expect(workerCalls[0]).toEqual(expect.objectContaining({
      venue_id: "phoenix",
      execution_mode: "ghola_pooled",
      order_summary: expect.objectContaining({
        market: "SOL-PERP",
        notional_bucket: "5",
      }),
    }));
    expect(entries.map((entry) => entry.entry_kind)).toEqual([
      "deposit_credit",
      "margin_reserved",
      "order_submitted",
    ]);
    expect(entries.find((entry) => entry.entry_kind === "margin_reserved")?.venue_id).toBe("phoenix");
  });

  it("releases reserved balance when the worker rejects submit", async () => {
    mockWorker({ submitStatus: 503 });
    const owner = await seedBalance(5_000_000);
    const workOrder = "public_live_phoenix_route_fail";

    const res = await submitPhoenix(request("/v1/private-account/public-live/phoenix/submit", {
      ...(await signedWalletProof()),
      ...acknowledgements(),
      ack_live_order: true,
      work_order_commitment: workOrder,
      order_summary: orderSummary(workOrder),
      encrypted_execution_instruction_bundle: sealedInstruction(workOrder),
    }));
    const body = await res.json();
    const entries = await listGholaBalanceLedgerEntries(owner.account_commitment, 20);

    expect(res.status).toBe(503);
    expect(body.error).toBe("worker_rejected");
    expect(entries.map((entry) => entry.entry_kind)).toEqual([
      "deposit_credit",
      "margin_reserved",
      "margin_released",
    ]);
  });
});

function request(path: string, body: unknown, includeAuth = true) {
  return new Request(`https://ghola.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(includeAuth ? { authorization: authHeader() } : {}),
    },
    body: JSON.stringify(body),
  });
}

function authHeader() {
  return `Bearer ${[
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: USER_ID, email: USER_EMAIL, name: "No Key Beta" })).toString("base64url"),
    "sig",
  ].join(".")}`;
}

async function signedWalletProof() {
  const secret = ed25519.utils.randomPrivateKey();
  const wallet = bs58.encode(ed25519.getPublicKey(secret));
  const challenge = buildPublicLivePhoenixChallenge({ wallet_pubkey: wallet });
  if ("error" in challenge) throw new Error(challenge.error);
  const signature = ed25519.sign(new TextEncoder().encode(challenge.message), secret);
  return {
    wallet_pubkey: wallet,
    message: challenge.message,
    signature_b64: Buffer.from(signature).toString("base64"),
  };
}

function acknowledgements() {
  return {
    accepted_terms: true,
    accepted_risk: true,
    not_prohibited_person: true,
    jurisdiction_assertion: "self_attested_eligible",
    utilization_bucket: "5",
  };
}

function orderSummary(workOrder: string) {
  return {
    venue_id: "phoenix",
    market: "SOL-PERP",
    notional_bucket: "5",
    side: "buy",
    work_order_commitment: workOrder,
  };
}

function sealedInstruction(workOrder: string) {
  return {
    alg: "sealed-provider-v1",
    ciphertext: "ciphertext-ciphertext-ciphertext",
    recipient: "phala:cvm:test",
    aad: [
      "ghola/private-execution-instruction-v1",
      `work_order:${workOrder}`,
      "venue:phoenix",
      "recipient:phala:cvm:test",
    ].join("|"),
  };
}

async function seedBalance(amountMicroUsdc: number) {
  const owner = {
    user: { id: USER_ID, email: USER_EMAIL, name: "No Key Beta" },
    owner_commitment: gholaCommitment("owner", USER_ID),
  };
  const account = await createOrGetStoredPrivateAccount(owner);
  await putGholaBalanceLedgerEntry({
    version: 1,
    ledger_entry_id: gholaCommitment("test_ghola_balance_entry", {
      account_commitment: account.account_commitment,
      amountMicroUsdc,
    }),
    owner_commitment: owner.owner_commitment,
    account_commitment: account.account_commitment,
    idempotency_key: "test_no_key_balance_seed",
    entry_kind: "deposit_credit",
    venue_id: "ghola",
    available_delta_micro_usdc: amountMicroUsdc,
    reserved_margin_delta_micro_usdc: 0,
    open_notional_delta_micro_usdc: 0,
    realized_pnl_delta_micro_usdc: 0,
    unrealized_pnl_delta_micro_usdc: 0,
    reference_commitment: "test_deposit",
    reason: "test_seed_balance",
    created_at: new Date().toISOString(),
  });
  return account;
}

function mockWorker({ submitStatus }: { submitStatus: number }) {
  const submitCalls: Record<string, unknown>[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    if (url.endsWith("/venues/pools/readiness")) {
      return new Response(JSON.stringify({
        version: 1,
        status: "blocked",
        ready: false,
        operation_class: "pooled_readiness",
        venues: [
          { venue_id: "hyperliquid", status: "blocked", ready: false, reason_codes: ["hyperliquid_pooled_account_pool_missing"] },
          { venue_id: "phoenix", status: "ready", ready: true, reason_codes: [] },
          { venue_id: "backpack", status: "blocked", ready: false, reason_codes: ["backpack_pooled_disabled"] },
          { venue_id: "jupiter", status: "blocked", ready: false, reason_codes: ["jupiter_api_key_missing"] },
          { venue_id: "coinbase", status: "blocked", ready: false, reason_codes: ["coinbase_omnibus_pool_not_ready"] },
        ],
        reason_codes: [],
        checked_at: new Date().toISOString(),
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/venues/solana-perps/orders")) {
      submitCalls.push(body);
      return new Response(JSON.stringify(submitStatus >= 400
        ? { error: "worker_rejected" }
        : {
            status: "submitted",
            result_commitment: "solana_perps_result_route",
            provider_ref_commitment: "solana_perps_provider_route",
          }), {
        status: submitStatus,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "unexpected_fetch" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  });
  return submitCalls;
}

function clearEnv() {
  for (const key of [
    "GHOLA_NO_KEY_LIVE_ENABLED",
    "GHOLA_PUBLIC_LIVE_REQUIRE_AUTH",
    "GHOLA_PUBLIC_LIVE_REQUIRE_BALANCE",
    "GHOLA_PUBLIC_LIVE_REQUIRE_ALLOWLIST",
    "GHOLA_PUBLIC_LIVE_ALLOWED_USERS",
    "GHOLA_PUBLIC_LIVE_ALLOWED_WALLETS",
    "GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS",
    "GHOLA_PRIVATE_AGENT_EXECUTION_URL",
    "GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN",
  ]) {
    delete process.env[key];
  }
}
