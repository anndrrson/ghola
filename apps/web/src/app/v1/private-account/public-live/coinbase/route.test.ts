import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as prepareCoinbase } from "./prepare/route";
import { POST as submitCoinbase } from "./submit/route";
import { createOrGetStoredPrivateAccount } from "../../_lib";
import {
  listGholaBalanceLedgerEntries,
  putGholaBalanceLedgerEntry,
  resetPrivateAccountStoreForTests,
} from "@/lib/private-account-store";
import { gholaCommitment } from "@/lib/private-account";

const USER_ID = "coinbase_public_user";
const USER_EMAIL = "coinbase-public@example.com";

describe("public Coinbase no-key live routes", () => {
  beforeEach(async () => {
    clearEnv();
    process.env.GHOLA_NO_KEY_LIVE_ENABLED = "true";
    process.env.GHOLA_PUBLIC_LIVE_PRIMARY_VENUE = "coinbase";
    process.env.GHOLA_PUBLIC_LIVE_REQUIRE_AUTH = "true";
    process.env.GHOLA_PUBLIC_LIVE_REQUIRE_BALANCE = "true";
    process.env.GHOLA_PUBLIC_LIVE_ALLOWED_USERS = `${USER_ID},${USER_EMAIL}`;
    process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL = "https://worker.example";
    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN = "worker-token";
    process.env.GHOLA_V6_COINBASE_PILOT_ENABLED = "true";
    process.env.GHOLA_COINBASE_PARTNER_OMNIBUS_ENABLED = "true";
    process.env.GHOLA_COINBASE_PARTNER_OMNIBUS_POOL_READY = "true";
    process.env.GHOLA_COINBASE_LIVE_MODE = "full";
    process.env.PRIVATE_AGENT_COINBASE_LIVE_MODE = "full";
    process.env.PRIVATE_AGENT_COINBASE_ALLOWED_PRODUCTS = "SOL-USD,BTC-USD,ETH-USD";
    process.env.PRIVATE_AGENT_COINBASE_LIVE_MAX_NOTIONAL_USD = "5";
    await resetPrivateAccountStoreForTests();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    clearEnv();
    await resetPrivateAccountStoreForTests();
  });

  it("requires a signed-in allowlisted account before preparing Coinbase public live access", async () => {
    const res = await prepareCoinbase(request("/v1/private-account/public-live/coinbase/prepare", acknowledgements(), false));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("public_live_auth_required");
  });

  it("prepares Coinbase access but blocks submit when Ghola balance is insufficient", async () => {
    const res = await prepareCoinbase(request("/v1/private-account/public-live/coinbase/prepare", acknowledgements()));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.status).toBe("live_ready");
    expect(body.venue_id).toBe("coinbase_advanced");
    expect(body.execution_mode).toBe("partner_omnibus");
    expect(body.can_submit_live).toBe(false);
    expect(body.blocking_reason_codes).toContain("ghola_balance_insufficient");
    expect(body.required_margin_micro_usdc).toBe(5_000_000);
    expect(body.live_limits).toMatchObject({
      max_notional_bucket: "5",
      operation_class: "spot_market_order",
    });
  });

  it("uses a user-selected amount bucket within the configured live cap", async () => {
    process.env.PRIVATE_AGENT_COINBASE_LIVE_MAX_NOTIONAL_USD = "100";
    await seedBalance(25_000_000);
    const res = await prepareCoinbase(request(
      "/v1/private-account/public-live/coinbase/prepare",
      { ...acknowledgements(), utilization_bucket: "25" },
    ));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.can_submit_live).toBe(true);
    expect(body.required_margin_micro_usdc).toBe(25_000_000);
    expect(body.live_limits.max_notional_bucket).toBe("25");
  });

  it("reserves Ghola balance and records submitted state around a Coinbase worker submit", async () => {
    const workerCalls = mockWorker({ submitStatus: 202 });
    const owner = await seedBalance(5_000_000);
    const workOrder = "public_live_coinbase_route_success";

    const res = await submitCoinbase(request("/v1/private-account/public-live/coinbase/submit", {
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
    expect(body.venue_id).toBe("coinbase_advanced");
    expect(body.balance_reservation_commitment).toMatch(/^ghola_balance_ledger_entry_/);
    expect(body.next_status).toBe("pending_reconciliation");
    expect(workerCalls[0]).toEqual(expect.objectContaining({
      venue_id: "coinbase_advanced",
      execution_mode: "partner_omnibus",
      operation_class: "spot_market_order",
      order_summary: expect.objectContaining({
        market: "SOL-USD",
        notional_bucket: "5",
      }),
      omnibus_allocation: expect.objectContaining({
        venue_id: "coinbase_advanced",
        status: "allocated",
      }),
    }));
    expect(entries.map((entry) => entry.entry_kind)).toEqual([
      "deposit_credit",
      "margin_reserved",
      "order_submitted",
    ]);
    expect(entries.find((entry) => entry.entry_kind === "margin_reserved")?.venue_id).toBe("coinbase_advanced");
  });

  it("releases reserved balance when the Coinbase worker rejects submit", async () => {
    mockWorker({ submitStatus: 503 });
    const owner = await seedBalance(5_000_000);
    const workOrder = "public_live_coinbase_route_fail";

    const res = await submitCoinbase(request("/v1/private-account/public-live/coinbase/submit", {
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
    expect(entries.find((entry) => entry.entry_kind === "margin_released")?.venue_id).toBe("coinbase_advanced");
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
    Buffer.from(JSON.stringify({ sub: USER_ID, email: USER_EMAIL, name: "Coinbase Public" })).toString("base64url"),
    "sig",
  ].join(".")}`;
}

function acknowledgements() {
  return {
    accepted_terms: true,
    accepted_risk: true,
    not_prohibited_person: true,
    jurisdiction_assertion: "self_attested_eligible",
    country_code: "US",
    utilization_bucket: "5",
  };
}

function orderSummary(workOrder: string) {
  return {
    venue_id: "coinbase_advanced",
    market: "SOL-USD",
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
      "venue:coinbase_advanced",
      "recipient:phala:cvm:test",
    ].join("|"),
  };
}

async function seedBalance(amountMicroUsdc: number) {
  const owner = {
    user: { id: USER_ID, email: USER_EMAIL, name: "Coinbase Public" },
    owner_commitment: gholaCommitment("owner", USER_ID),
  };
  const account = await createOrGetStoredPrivateAccount(owner);
  await putGholaBalanceLedgerEntry({
    version: 1,
    ledger_entry_id: gholaCommitment("test_ghola_coinbase_balance_entry", {
      account_commitment: account.account_commitment,
      amountMicroUsdc,
    }),
    owner_commitment: owner.owner_commitment,
    account_commitment: account.account_commitment,
    idempotency_key: "test_coinbase_public_balance_seed",
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
    if (url.endsWith("/venues/coinbase/orders")) {
      submitCalls.push(body);
      return new Response(JSON.stringify(submitStatus >= 400
        ? { error: "worker_rejected" }
        : {
            status: "submitted",
            result_commitment: "coinbase_result_route",
            provider_ref_commitment: "coinbase_provider_route",
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
    "GHOLA_PUBLIC_LIVE_PRIMARY_VENUE",
    "GHOLA_PUBLIC_LIVE_REQUIRE_AUTH",
    "GHOLA_PUBLIC_LIVE_REQUIRE_BALANCE",
    "GHOLA_PUBLIC_LIVE_REQUIRE_ALLOWLIST",
    "GHOLA_PUBLIC_LIVE_ALLOWED_USERS",
    "GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS",
    "GHOLA_PRIVATE_AGENT_EXECUTION_URL",
    "GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN",
    "GHOLA_V6_COINBASE_PILOT_ENABLED",
    "GHOLA_COINBASE_PARTNER_OMNIBUS_ENABLED",
    "GHOLA_COINBASE_PARTNER_OMNIBUS_POOL_READY",
    "GHOLA_COINBASE_LIVE_MODE",
    "PRIVATE_AGENT_COINBASE_LIVE_MODE",
    "PRIVATE_AGENT_COINBASE_ALLOWED_PRODUCTS",
    "PRIVATE_AGENT_COINBASE_LIVE_MAX_NOTIONAL_USD",
  ]) {
    delete process.env[key];
  }
}
