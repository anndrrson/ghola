import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { getAddress } from "viem";
import { gholaCommitment } from "@/lib/private-account";
import {
  claimPrivateLighterUdaAttempt,
  getPrivateLighterDepositExpectation,
  resetPrivateAccountStoreForTests,
  settlePrivateLighterUdaAttempt,
} from "@/lib/private-account-store";
import { POST } from "./route";

const OWNER = getAddress("0xa0582521e11effdf12ff00b50087802c3346e7ef");
const DEPOSIT = getAddress("0x2222222222222222222222222222222222222222");
const HASH = `0x${"ab".repeat(32)}` as const;
const HISTORIC_HASH = `0x${"cd".repeat(32)}` as const;
const WRONG_HASH = `0x${"ef".repeat(32)}` as const;
const BUILDER_KEY = "server-only-builder-key";
const OLD_BUILDER_KEY = process.env.GHOLA_LIGHTER_BUILDER_KEY;

vi.mock("server-only", () => ({}));

describe("POST /api/carry/lighter-deposit-reconciliation", () => {
  beforeEach(async () => {
    process.env.GHOLA_LIGHTER_BUILDER_KEY = BUILDER_KEY;
    await seedVerifiedDestination();
  });

  afterEach(async () => {
    await resetPrivateAccountStoreForTests();
    if (OLD_BUILDER_KEY === undefined) delete process.env.GHOLA_LIGHTER_BUILDER_KEY;
    else process.env.GHOLA_LIGHTER_BUILDER_KEY = OLD_BUILDER_KEY;
    vi.restoreAllMocks();
  });

  it.each(["PROCESSING", "COMPLETED"] as const)("reports %s only for the exact bound transaction", async (providerStatus) => {
    const fetchSpy = mockProfileAndStatus([
      providerTransaction({ txHash: HISTORIC_HASH, status: "COMPLETED", fromAmountBaseUnit: "9000000" }),
      providerTransaction({ txHash: HASH, status: providerStatus }),
    ]);
    const response = await POST(request());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(body).toMatchObject({
      observed: true,
      status: providerStatus,
      reconciliation_complete: providerStatus === "COMPLETED",
      owner_address: OWNER,
      deposit_address: DEPOSIT,
      transaction_hash: HASH,
      expected_amount_microunits: "5500000",
      source: {
        chain_id: 8453,
        token_address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      },
      destination: {
        to_chain_id: "3586256",
        to_token_address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      },
    });
    expect(JSON.stringify(body)).not.toContain(BUILDER_KEY);
    const statusCalls = fetchSpy.mock.calls.filter(([input]) => String(input).includes("/v1/uda/status/"));
    expect(statusCalls).toHaveLength(1);
    expect((statusCalls[0]?.[1] as RequestInit).headers).toEqual({ "x-api-key": BUILDER_KEY });
    const persisted = await getPrivateLighterDepositExpectation({
      owner_commitment: gholaCommitment("owner", "user-1"),
      transaction_hash: HASH,
    });
    expect(persisted).toMatchObject({
      status: providerStatus.toLowerCase(),
      provider_created_time_ms: expect.any(Number),
    });
  });

  it("does not report a historic completed deposit as success", async () => {
    mockProfileAndStatus([
      providerTransaction({ txHash: HISTORIC_HASH, status: "COMPLETED" }),
    ]);
    const response = await POST(request());
    const body = await response.json();
    expect(response.status).toBe(202);
    expect(body).toMatchObject({ observed: false, reconciliation_complete: false });
    expect(body).not.toHaveProperty("status");
    expect(await getPrivateLighterDepositExpectation({
      owner_commitment: gholaCommitment("owner", "user-1"),
      transaction_hash: HASH,
    })).toBeNull();
  });

  it("accepts a first exact provider observation after fifteen minutes", async () => {
    mockProfileAndStatus([providerTransaction({
      txHash: HASH,
      status: "COMPLETED",
      createdTimeMs: Date.now() - 60 * 60 * 1_000,
    })]);
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      observed: true,
      status: "COMPLETED",
      transaction_hash: HASH,
      expected_amount_microunits: "5500000",
    });
  });

  it("rejects an exact provider observation older than the bounded first-observation window", async () => {
    mockProfileAndStatus([providerTransaction({
      txHash: HASH,
      status: "COMPLETED",
      createdTimeMs: Date.now() - 25 * 60 * 60 * 1_000,
    })]);
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "lighter_uda_deposit_historic_transaction_rejected" });
  });

  it.each([
    ["amount", { fromAmountBaseUnit: "5500001" }],
    ["destination", { depositAddr: "0x3333333333333333333333333333333333333333" }],
    ["source chain", { fromChainId: "1" }],
    ["source token", { fromTokenAddress: "0x1111111111111111111111111111111111111111" }],
    ["to chain", { toChainId: "1" }],
    ["to token", { toTokenAddress: "0x1111111111111111111111111111111111111111" }],
  ])("fails closed on exact transaction %s mismatch", async (_name, overrides) => {
    mockProfileAndStatus([providerTransaction({ txHash: HASH, ...overrides })]);
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect((await response.json()).error).toMatch(/^lighter_uda_status_/);
  });

  it("rejects malformed or under-minimum expectations before provider polling", async () => {
    const fetchSpy = mockProfileAndStatus([]);
    const malformed = await POST(request({ transaction_hash: "0x123" }));
    expect(malformed.status).toBe(400);
    const tooSmall = await POST(request({ expected_amount_microunits: "4999999" }));
    expect(tooSmall.status).toBe(400);
    expect(fetchSpy.mock.calls.filter(([input]) => String(input).includes("/v1/uda/status/"))).toHaveLength(0);
  });

  it("requires the exact verified owner-bound destination", async () => {
    const fetchSpy = mockProfileAndStatus([]);
    const response = await POST(request({
      deposit_address: "0x3333333333333333333333333333333333333333",
    }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "lighter_uda_deposit_destination_not_verified" });
    expect(fetchSpy.mock.calls.filter(([input]) => String(input).includes("/v1/uda/status/"))).toHaveLength(0);
  });

  it("keeps an observed amount immutable for a transaction hash", async () => {
    const fetchSpy = mockProfileAndStatus([providerTransaction()]);
    expect((await POST(request())).status).toBe(200);
    const conflict = await POST(request({ expected_amount_microunits: "6000000" }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "lighter_uda_deposit_expectation_conflict" });
    expect(fetchSpy.mock.calls.filter(([input]) => String(input).includes("/v1/uda/status/"))).toHaveLength(1);
  });

  it("allows correcting a wrong hash after an unseen check", async () => {
    mockProfileAndStatusSequence([[], [providerTransaction()]]);
    expect((await POST(request({ transaction_hash: WRONG_HASH }))).status).toBe(202);
    expect(await getPrivateLighterDepositExpectation({
      owner_commitment: gholaCommitment("owner", "user-1"),
      transaction_hash: WRONG_HASH,
    })).toBeNull();

    const corrected = await POST(request());
    expect(corrected.status).toBe(200);
    expect(await corrected.json()).toMatchObject({ transaction_hash: HASH, observed: true });
  });

  it("allows correcting a wrong amount after an unseen check", async () => {
    mockProfileAndStatusSequence([[], [providerTransaction()]]);
    expect((await POST(request({ expected_amount_microunits: "6000000" }))).status).toBe(202);
    expect(await getPrivateLighterDepositExpectation({
      owner_commitment: gholaCommitment("owner", "user-1"),
      transaction_hash: HASH,
    })).toBeNull();

    const corrected = await POST(request());
    expect(corrected.status).toBe(200);
    expect(await corrected.json()).toMatchObject({ expected_amount_microunits: "5500000", observed: true });
  });

  it("never regresses a completed exact deposit to processing", async () => {
    const createdTimeMs = Date.now() - 60 * 60 * 1_000;
    let providerStatus: "PROCESSING" | "COMPLETED" = "COMPLETED";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/user/profile")) return profileResponse();
      if (url.includes("/v1/uda/status/")) {
        return Response.json({ transactions: [providerTransaction({ status: providerStatus, createdTimeMs })] });
      }
      throw new Error("unexpected request");
    });
    const completed = await POST(request());
    expect((await completed.json()).status).toBe("COMPLETED");
    providerStatus = "PROCESSING";
    const repeated = await POST(request());
    expect((await repeated.json()).status).toBe("COMPLETED");
  });

  it("rejects cross-site, smuggled, unauthenticated, and unconfigured requests", async () => {
    const fetchSpy = mockProfileAndStatus([]);
    expect((await POST(request({}, { origin: "https://attacker.example" }))).status).toBe(403);
    expect((await POST(request({ extra: true }))).status).toBe(400);
    expect((await POST(request({}, { cookie: "" }))).status).toBe(401);
    delete process.env.GHOLA_LIGHTER_BUILDER_KEY;
    expect((await POST(request())).status).toBe(503);
    expect(fetchSpy.mock.calls.filter(([input]) => String(input).includes("/v1/uda/status/"))).toHaveLength(0);
  });

  it.each([400, 403, 502])("fails closed on provider HTTP %i", async (status) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/user/profile")) return profileResponse();
      if (url.includes("/v1/uda/status/")) return Response.json({ private: "redacted" }, { status });
      throw new Error("unexpected request");
    });
    const response = await POST(request());
    expect(response.status).toBeGreaterThanOrEqual(502);
    expect((await response.json()).error).toMatch(/^lighter_uda_status_/);
  });
});

async function seedVerifiedDestination() {
  const ownerCommitment = gholaCommitment("owner", "user-1");
  const walletCommitment = gholaCommitment("wallet", OWNER.toLowerCase());
  const claim = await claimPrivateLighterUdaAttempt({
    attempt_id: gholaCommitment("lighter_uda_attempt", {
      owner_commitment: ownerCommitment,
      wallet_commitment: walletCommitment,
    }),
    owner_commitment: ownerCommitment,
    wallet_commitment: walletCommitment,
    owner_address: OWNER,
    claim_token: "ab".repeat(32),
    now: new Date("2026-08-31T00:00:00.000Z"),
  });
  if (!claim.acquired) throw new Error("seed claim failed");
  await settlePrivateLighterUdaAttempt({
    owner_commitment: ownerCommitment,
    wallet_commitment: walletCommitment,
    owner_address: OWNER,
    claim_token: claim.record.claim_token,
    status: "verified",
    destination: {
      owner_address: OWNER,
      deposit_address: DEPOSIT,
      market: "perps",
      asset: "USDC",
      blocked: false,
      action_type: "LIGHTER_PERPS",
      to_chain_id: "3586256",
      to_token_address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      recipient_address: OWNER,
      recipient_binding: "owner_address",
      owner_account_index: null,
      resolved_user_id: OWNER,
    },
    failure_code: null,
    now: new Date("2026-08-31T00:00:01.000Z"),
  });
}

function request(body: Record<string, unknown> = {}, overrides: { origin?: string; cookie?: string } = {}) {
  const headers = new Headers({
    origin: overrides.origin ?? "https://ghola.example",
    "content-type": "application/json",
  });
  const cookie = overrides.cookie === undefined ? "ghola_thumper_session=session-token" : overrides.cookie;
  if (cookie) headers.set("cookie", cookie);
  return new NextRequest("https://ghola.example/api/carry/lighter-deposit-reconciliation", {
    method: "POST",
    headers,
    body: JSON.stringify({
      version: 1,
      owner_address: OWNER,
      deposit_address: DEPOSIT,
      transaction_hash: HASH,
      expected_amount_microunits: "5500000",
      ...body,
    }),
  });
}

function mockProfileAndStatus(transactions: unknown[]) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/api/user/profile")) return profileResponse();
    if (url.includes("/v1/uda/status/")) return Response.json({ transactions });
    throw new Error(`unexpected request: ${url}`);
  });
}

function mockProfileAndStatusSequence(transactionSets: unknown[][]) {
  let index = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/api/user/profile")) return profileResponse();
    if (url.includes("/v1/uda/status/")) {
      const transactions = transactionSets[Math.min(index, transactionSets.length - 1)] || [];
      index += 1;
      return Response.json({ transactions });
    }
    throw new Error(`unexpected request: ${url}`);
  });
}

function profileResponse() {
  return Response.json({ id: "user-1", email: "user@example.com", display_name: "User" });
}

function providerTransaction(overrides: Record<string, unknown> = {}) {
  return {
    fromChainId: "8453",
    fromTokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    fromAmountBaseUnit: "5500000",
    toChainId: "3586256",
    toTokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    txHash: HASH,
    createdTimeMs: Date.now(),
    status: "PROCESSING",
    depositAddr: DEPOSIT,
    ...overrides,
  };
}
