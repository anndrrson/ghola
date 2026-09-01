import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { getAddress } from "viem";
import { gholaCommitment } from "@/lib/private-account";
import { LIGHTER_FUNDING_ELIGIBILITY_ATTESTATION } from "@/lib/lighter-funding-eligibility";
import { resolveLighterTurnkeyPerpsOwnerBinding } from "@/lib/lighter-turnkey-owner-binding.server";
import {
  claimPrivateLighterUdaAttempt,
  getPrivateLighterUdaAttempt,
  reconcilePrivateLighterUdaAttempt,
  resetPrivateAccountStoreForTests,
  settlePrivateLighterUdaAttempt,
} from "@/lib/private-account-store";
import { POST } from "./route";

const OWNER = getAddress("0xa0582521e11effdf12ff00b50087802c3346e7ef");
const DEPOSIT = getAddress("0x2222222222222222222222222222222222222222");
const OTHER_DEPOSIT = getAddress("0x3333333333333333333333333333333333333333");
const BUILDER_KEY = "server-only-builder-key";
const OLD_BUILDER_KEY = process.env.GHOLA_LIGHTER_BUILDER_KEY;

vi.mock("server-only", () => ({}));
vi.mock("@/lib/lighter-turnkey-owner-binding.server", () => ({
  resolveLighterTurnkeyPerpsOwnerBinding: vi.fn(),
}));

describe("POST /api/carry/lighter-uda-attempt-reconciliation", () => {
  beforeEach(() => {
    process.env.GHOLA_LIGHTER_BUILDER_KEY = BUILDER_KEY;
    vi.mocked(resolveLighterTurnkeyPerpsOwnerBinding).mockResolvedValue({} as never);
  });

  afterEach(async () => {
    await resetPrivateAccountStoreForTests();
    restoreEnv("GHOLA_LIGHTER_BUILDER_KEY", OLD_BUILDER_KEY);
    vi.restoreAllMocks();
  });

  it.each(["pending", "ambiguous"] as const)("keeps exact %s provider history read-only and funding-locked", async (status) => {
    await seed(status);
    const fetchSpy = mockProfileAndStatus([providerTransaction()]);
    const response = await POST(request());
    const body = await response.json();
    expect(response.status).toBe(202);
    expect(body).toMatchObject({
      owner_address: OWNER,
      error: "lighter_uda_reconciliation_history_observed_locked",
      historical_activity_observed: true,
      historical_destination_count: 1,
      current_funding_destination_proven: false,
      reconciliation_complete: false,
      deposit_destination_verified: false,
      funding_action_enabled: false,
      safety: { provider_status_read_only: true, creation_retry_performed: false },
    });
    const providerCalls = statusCalls(fetchSpy);
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]?.[1]).toMatchObject({ method: "GET" });
    expect(fetchSpy.mock.calls.some(([input, init]) =>
      String(input) === "https://bridge.lighter.xyz/v1/uda" && (init as RequestInit | undefined)?.method === "POST"
    )).toBe(false);
    expect(await attempt()).toMatchObject({ status, destination: null });
  });

  it("keeps an inconclusive attempt locked and unchanged", async () => {
    await seed("ambiguous");
    mockProfileAndStatus([]);
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      attempt_status: "ambiguous",
      retry_forbidden: true,
      reconciliation_complete: false,
      deposit_destination_verified: false,
      funding_action_enabled: false,
    });
    expect(await attempt()).toMatchObject({
      status: "ambiguous",
      destination: null,
      failure_code: "lighter_uda_create_unavailable",
    });
  });

  it("reports multiple historical provider destinations without blessing one", async () => {
    await seed("ambiguous");
    mockProfileAndStatus([
      providerTransaction(),
      providerTransaction({ depositAddr: OTHER_DEPOSIT, txHash: `0x${"cd".repeat(32)}` }),
    ]);
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      error: "lighter_uda_reconciliation_history_observed_locked",
      historical_destination_count: 2,
      current_funding_destination_proven: false,
      retry_forbidden: true,
      funding_action_enabled: false,
    });
    expect(await attempt()).toMatchObject({ status: "ambiguous", destination: null });
  });

  it("does not use historic-only evidence", async () => {
    await seed("pending");
    mockProfileAndStatus([providerTransaction({ createdTimeMs: Date.now() - 60 * 60_000 })]);
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect((await response.json()).qualifying_transaction_count).toBe(0);
    expect(await attempt()).toMatchObject({ status: "pending", destination: null });
  });

  it("does not query the provider for another session, malformed input, or a verified attempt", async () => {
    const seeded = await seed("pending");
    const verified = await reconcilePrivateLighterUdaAttempt({
      attempt_id: seeded.attempt_id,
      owner_commitment: seeded.owner_commitment,
      wallet_commitment: seeded.wallet_commitment,
      owner_address: seeded.owner_address,
      claim_token: seeded.claim_token,
      destination: destination(),
      now: new Date(),
    });
    expect(verified.status).toBe("verified");
    const fetchSpy = mockProfileAndStatus([], "user-1");
    expect((await POST(request())).status).toBe(200);
    expect(resolveLighterTurnkeyPerpsOwnerBinding).toHaveBeenCalledWith({
      sessionEmail: "user@example.com",
      ownerAddress: OWNER,
    });
    expect((await POST(request({}, { country: "US" }))).status).toBe(403);
    vi.mocked(resolveLighterTurnkeyPerpsOwnerBinding).mockRejectedValueOnce(
      Object.assign(new Error("lighter_turnkey_owner_binding_mismatch"), {
        code: "lighter_turnkey_owner_binding_mismatch",
        status: 403,
      }),
    );
    expect((await POST(request())).status).toBe(403);
    expect(statusCalls(fetchSpy)).toHaveLength(0);

    vi.restoreAllMocks();
    const otherSession = mockProfileAndStatus([], "user-2");
    expect((await POST(request())).status).toBe(404);
    expect(statusCalls(otherSession)).toHaveLength(0);

    vi.restoreAllMocks();
    const malformed = mockProfileAndStatus([]);
    expect((await POST(request({ extra: true }))).status).toBe(400);
    expect(statusCalls(malformed)).toHaveLength(0);
  });

  it("requires same-origin authenticated requests before provider access", async () => {
    const fetchSpy = mockProfileAndStatus([]);
    expect((await POST(request({}, { origin: "https://attacker.example" }))).status).toBe(403);
    expect((await POST(request({}, { cookie: "" }))).status).toBe(401);
    expect(statusCalls(fetchSpy)).toHaveLength(0);
  });

  it("rechecks current jurisdiction and Turnkey ownership before provider access", async () => {
    await seed("ambiguous");
    const fetchSpy = mockProfileAndStatus([]);
    expect((await POST(request({}, { country: "US" }))).status).toBe(403);
    expect(statusCalls(fetchSpy)).toHaveLength(0);

    vi.mocked(resolveLighterTurnkeyPerpsOwnerBinding).mockRejectedValueOnce(
      Object.assign(new Error("lighter_turnkey_owner_binding_mismatch"), {
        code: "lighter_turnkey_owner_binding_mismatch",
        status: 403,
      }),
    );
    expect((await POST(request())).status).toBe(403);
    expect(statusCalls(fetchSpy)).toHaveLength(0);
  });
});

async function seed(status: "pending" | "ambiguous") {
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
    now: new Date(Date.now() - 5_000),
  });
  if (!claim.acquired) throw new Error("seed claim failed");
  if (status === "ambiguous") {
    return settlePrivateLighterUdaAttempt({
      owner_commitment: ownerCommitment,
      wallet_commitment: walletCommitment,
      owner_address: OWNER,
      claim_token: claim.record.claim_token,
      status: "ambiguous",
      destination: null,
      failure_code: "lighter_uda_create_unavailable",
      now: new Date(Date.now() - 4_000),
    });
  }
  return claim.record;
}

async function attempt() {
  return getPrivateLighterUdaAttempt({
    owner_commitment: gholaCommitment("owner", "user-1"),
    wallet_commitment: gholaCommitment("wallet", OWNER.toLowerCase()),
  });
}

function request(
  body: Record<string, unknown> = {},
  overrides: { origin?: string; cookie?: string; country?: string } = {},
) {
  const headers = new Headers({
    origin: overrides.origin ?? "https://ghola.example",
    "content-type": "application/json",
    "x-vercel-ip-country": overrides.country ?? "DE",
  });
  const cookie = overrides.cookie === undefined ? "ghola_thumper_session=session-token" : overrides.cookie;
  if (cookie) headers.set("cookie", cookie);
  return new NextRequest("https://ghola.example/api/carry/lighter-uda-attempt-reconciliation", {
    method: "POST",
    headers,
    body: JSON.stringify({
      version: 1,
      owner_address: OWNER,
      eligibility_attestation: LIGHTER_FUNDING_ELIGIBILITY_ATTESTATION,
      ...body,
    }),
  });
}

function mockProfileAndStatus(transactions: unknown[], userId = "user-1") {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/api/user/profile")) {
      return Response.json({ id: userId, email: "user@example.com", display_name: "User" });
    }
    if (url.includes("/v1/uda/status/")) return Response.json({ walletAddress: OWNER, transactions });
    throw new Error(`unexpected request: ${url}`);
  });
}

function statusCalls(fetchSpy: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } }) {
  return fetchSpy.mock.calls.filter(([input]) => String(input).includes("/v1/uda/status/"));
}

function providerTransaction(overrides: Record<string, unknown> = {}) {
  return {
    fromChainId: "8453",
    fromTokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    fromAmountBaseUnit: "5500000",
    toChainId: "3586256",
    toTokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    txHash: `0x${"ab".repeat(32)}`,
    depositAddr: DEPOSIT,
    createdTimeMs: Date.now(),
    status: "PROCESSING",
    ...overrides,
  };
}

function destination() {
  return {
    owner_address: OWNER,
    deposit_address: DEPOSIT,
    market: "perps" as const,
    asset: "USDC" as const,
    blocked: false as const,
    action_type: "LIGHTER_PERPS" as const,
    to_chain_id: "3586256" as const,
    to_token_address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const,
    recipient_address: OWNER,
    recipient_binding: "owner_address" as const,
    owner_account_index: null,
    resolved_user_id: OWNER,
  };
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
