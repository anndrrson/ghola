import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as allocatePooledVenue } from "../allocate/route";
import { POST as withdrawPooledVenue } from "./route";
import { GET as auditPooledVenue } from "../audit/route";
import { POST as verifyVenueEligibility } from "../../eligibility/route";
import { POST as createBalanceFundingIntent } from "../../../../balance/funding-intent/route";
import { POST as importBalanceCredit } from "../../../../balance/import-credit/route";
import { GET as getGholaBalance } from "../../../../balance/route";
import { resetPrivateAccountStoreForTests } from "@/lib/private-account-store";

const INTERNAL_TOKEN = "test_internal_private_account_token";

function auth(userId: string) {
  return `Bearer ${[
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: userId, email: `${userId}@example.com` })).toString("base64url"),
    "sig",
  ].join(".")}`;
}

const AUTH = auth("pool_lifecycle_user_1");

function post(path: string, body: unknown, authorization = AUTH) {
  return new Request(`https://ghola.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization },
    body: JSON.stringify(body),
  });
}

function get(path: string, authorization = AUTH) {
  return new Request(`https://ghola.test${path}`, {
    method: "GET",
    headers: { authorization },
  });
}

const phoenixParams = { params: Promise.resolve({ platform_class: "phoenix" }) };

async function creditGholaBalance(userId: string, amountBucket = "100") {
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
      receipt_id: `custom_receipt_pool_${userId}_${amountBucket}_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    }, auth(userId)),
  );
  expect(importRes.status).toBe(201);
  return importRes.json();
}

async function verifyEligibility(userId: string) {
  const eligibilityRes = await verifyVenueEligibility(
    post("/v1/private-account/venues/phoenix/eligibility", {
      credential_type: "self_attested_eligible_user",
    }, auth(userId)),
    phoenixParams,
  );
  expect(eligibilityRes.status).toBe(201);
}

async function allocateFunded(userId: string, utilizationBucket = "50") {
  const allocationRes = await allocatePooledVenue(
    post("/v1/private-account/venues/phoenix/pool/allocate", {
      utilization_bucket: utilizationBucket,
      fund_from_ghola_balance: true,
    }, auth(userId)),
    phoenixParams,
  );
  const allocation = await allocationRes.json();
  expect(allocationRes.status).toBe(201);
  return allocation;
}

async function balanceOf(userId: string) {
  const res = await getGholaBalance(get("/v1/private-account/balance", auth(userId)));
  expect(res.status).toBe(200);
  return res.json();
}

describe("pooled venue allocate/withdraw lifecycle", () => {
  beforeEach(() => {
    process.env.GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN = INTERNAL_TOKEN;
    process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
    process.env.GHOLA_CONNECTOR_MODE = "local_test";
    process.env.GHOLA_CUSTOM_SHIELDED_VERIFIER_MODE = "local_test";
    process.env.GHOLA_SHIELDED_POOL_MODE = "local_test";
  });

  afterEach(async () => {
    await resetPrivateAccountStoreForTests();
    delete process.env.GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN;
    delete process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS;
    delete process.env.GHOLA_CONNECTOR_MODE;
    delete process.env.GHOLA_CUSTOM_SHIELDED_VERIFIER_MODE;
    delete process.env.GHOLA_SHIELDED_POOL_MODE;
  });

  it("funds a pooled allocation from the Ghola balance with a double entry", async () => {
    await creditGholaBalance("pool_lifecycle_user_1");
    await verifyEligibility("pool_lifecycle_user_1");
    const allocation = await allocateFunded("pool_lifecycle_user_1", "50");

    expect(allocation.pool_position.shares_micro).toBe(50_000_000);
    expect(allocation.pool_position.position_equity_micro_usdc).toBe(50_000_000);
    expect(allocation.pool_position.nav_per_share_micro_usdc).toBe(1_000_000);

    const balance = await balanceOf("pool_lifecycle_user_1");
    expect(balance.balance.available_micro_usdc).toBe(50_000_000);
  });

  it("rejects balance-backed allocation without sufficient Ghola balance", async () => {
    await creditGholaBalance("pool_lifecycle_user_1", "25");
    await verifyEligibility("pool_lifecycle_user_1");
    const allocationRes = await allocatePooledVenue(
      post("/v1/private-account/venues/phoenix/pool/allocate", {
        utilization_bucket: "50",
        fund_from_ghola_balance: true,
      }),
      phoenixParams,
    );
    const allocation = await allocationRes.json();
    expect(allocationRes.status).toBe(400);
    expect(allocation.error).toBe("insufficient_ghola_balance");
  });

  it("withdraws partially then fully and restores the Ghola balance", async () => {
    await creditGholaBalance("pool_lifecycle_user_1");
    await verifyEligibility("pool_lifecycle_user_1");
    await allocateFunded("pool_lifecycle_user_1", "50");

    const partialRes = await withdrawPooledVenue(
      post("/v1/private-account/venues/phoenix/pool/withdraw", {
        redemption_percent_bucket: "50",
      }),
      phoenixParams,
    );
    const partial = await partialRes.json();
    expect(partialRes.status).toBe(201);
    expect(partial.pooled_redemption.redeemed_micro_usdc).toBe(25_000_000);
    expect(partial.pooled_redemption.full_redemption).toBe(false);
    expect(partial.pool_position.shares_micro).toBe(25_000_000);
    expect(partial.balance.available_micro_usdc).toBe(75_000_000);

    const fullRes = await withdrawPooledVenue(
      post("/v1/private-account/venues/phoenix/pool/withdraw", {
        redemption_percent_bucket: "100",
      }),
      phoenixParams,
    );
    const full = await fullRes.json();
    expect(fullRes.status).toBe(201);
    expect(full.pooled_redemption.redeemed_micro_usdc).toBe(25_000_000);
    expect(full.pooled_redemption.full_redemption).toBe(true);
    expect(full.pool_position.shares_micro).toBe(0);
    expect(full.balance.available_micro_usdc).toBe(100_000_000);
  });

  it("replays a withdrawal with a client_redemption_id exactly once", async () => {
    await creditGholaBalance("pool_lifecycle_user_1");
    await verifyEligibility("pool_lifecycle_user_1");
    await allocateFunded("pool_lifecycle_user_1", "50");

    const body = {
      redemption_percent_bucket: "50",
      client_redemption_id: "client_redemption_replay_test",
    };
    const firstRes = await withdrawPooledVenue(
      post("/v1/private-account/venues/phoenix/pool/withdraw", body),
      phoenixParams,
    );
    const first = await firstRes.json();
    expect(firstRes.status).toBe(201);
    expect(first.pooled_redemption.redeemed_micro_usdc).toBe(25_000_000);

    const replayRes = await withdrawPooledVenue(
      post("/v1/private-account/venues/phoenix/pool/withdraw", body),
      phoenixParams,
    );
    const replay = await replayRes.json();
    expect(replayRes.status).toBe(201);
    expect(replay.pooled_redemption.redeemed_micro_usdc).toBe(25_000_000);
    expect(replay.balance.available_micro_usdc).toBe(75_000_000);
    expect(replay.pool_position.shares_micro).toBe(25_000_000);
  });

  it("rejects withdrawal without an allocation or with an empty position", async () => {
    const missingRes = await withdrawPooledVenue(
      post("/v1/private-account/venues/phoenix/pool/withdraw", {}),
      phoenixParams,
    );
    expect(missingRes.status).toBe(400);
    expect((await missingRes.json()).error).toBe("pooled_allocation_not_found");

    await creditGholaBalance("pool_lifecycle_user_1");
    await verifyEligibility("pool_lifecycle_user_1");
    const allocationRes = await allocatePooledVenue(
      post("/v1/private-account/venues/phoenix/pool/allocate", {
        utilization_bucket: "5",
      }),
      phoenixParams,
    );
    expect(allocationRes.status).toBe(201);

    const emptyRes = await withdrawPooledVenue(
      post("/v1/private-account/venues/phoenix/pool/withdraw", {}),
      phoenixParams,
    );
    expect(emptyRes.status).toBe(400);
    expect((await emptyRes.json()).error).toBe("pooled_position_empty");
  });

  it("attributes pool equity pro-rata across two holders", async () => {
    await creditGholaBalance("pool_lifecycle_user_1");
    await creditGholaBalance("pool_lifecycle_user_2");
    await verifyEligibility("pool_lifecycle_user_1");
    await verifyEligibility("pool_lifecycle_user_2");
    const first = await allocateFunded("pool_lifecycle_user_1", "50");
    const second = await allocateFunded("pool_lifecycle_user_2", "25");

    expect(first.pool_position.pool_commitment).toBe(second.pool_position.pool_commitment);
    expect(second.pool_position.pool_equity_micro_usdc).toBe(75_000_000);
    expect(second.pool_position.shares_micro).toBe(25_000_000);
    expect(second.pool_position.position_equity_micro_usdc).toBe(25_000_000);

    const withdrawal = await withdrawPooledVenue(
      post("/v1/private-account/venues/phoenix/pool/withdraw", {
        redemption_percent_bucket: "100",
      }, auth("pool_lifecycle_user_2")),
      phoenixParams,
    );
    const withdrawn = await withdrawal.json();
    expect(withdrawal.status).toBe(201);
    expect(withdrawn.pooled_redemption.redeemed_micro_usdc).toBe(25_000_000);
    expect(withdrawn.pool_position.pool_equity_micro_usdc).toBe(50_000_000);

    const remaining = await balanceOf("pool_lifecycle_user_1");
    expect(remaining.balance.available_micro_usdc).toBe(50_000_000);
  });

  it("audits the pool as balanced across the full lifecycle", async () => {
    await creditGholaBalance("pool_lifecycle_user_1");
    await verifyEligibility("pool_lifecycle_user_1");
    await allocateFunded("pool_lifecycle_user_1", "50");
    await withdrawPooledVenue(
      post("/v1/private-account/venues/phoenix/pool/withdraw", {
        redemption_percent_bucket: "50",
      }),
      phoenixParams,
    );

    const auditRes = await auditPooledVenue(
      get("/v1/private-account/venues/phoenix/pool/audit"),
      phoenixParams,
    );
    const audit = await auditRes.json();
    expect(auditRes.status).toBe(200);
    expect(["balanced", "balanced_internal"]).toContain(audit.status);
    expect(audit.checks.double_entry_balanced).toBe(true);
    expect(audit.checks.shares_match_subledgers).toBe(true);
    expect(audit.unbalanced_entry_count).toBe(0);
    expect(audit.pool_equity_micro_usdc).toBe(25_000_000);
    expect(audit.pool_shares_micro).toBe(25_000_000);
    expect(audit.subledger_count).toBe(1);
    expect(audit.audit_commitment).toMatch(/^pool_audit_/);
  });
});
