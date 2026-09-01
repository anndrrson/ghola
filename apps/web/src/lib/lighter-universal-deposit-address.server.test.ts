import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";
import {
  assertLighterUdaCreateConfigured,
  createLighterUniversalDepositAddress,
  LIGHTER_UDA_BASE_URL,
  readLighterUniversalDepositStatus,
} from "./lighter-universal-deposit-address.server";

const OWNER = "0xa0582521e11effdf12ff00b50087802c3346e7ef";
const DEPOSIT = "0x2222222222222222222222222222222222222222";
const OLD_KEY = process.env.GHOLA_LIGHTER_BUILDER_KEY;

vi.mock("server-only", () => ({}));

describe("Lighter Universal Deposit Address server boundary", () => {
  beforeEach(() => {
    process.env.GHOLA_LIGHTER_BUILDER_KEY = "server-only-builder-key";
  });

  afterEach(() => {
    if (OLD_KEY === undefined) delete process.env.GHOLA_LIGHTER_BUILDER_KEY;
    else process.env.GHOLA_LIGHTER_BUILDER_KEY = OLD_KEY;
    vi.restoreAllMocks();
  });

  it("creates an exact owner-bound USDC perps UDA with the builder key only in the header", async () => {
    const fetchMock = vi.fn(async () => createResponse());
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const result = await createLighterUniversalDepositAddress({ ownerAddress: OWNER, fetchImpl });
    expect(result).toEqual({
      owner_address: getAddress(OWNER),
      deposit_address: DEPOSIT,
      market: "perps",
      asset: "USDC",
      blocked: false,
      action_type: "LIGHTER_PERPS",
      to_chain_id: "3586256",
      to_token_address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      recipient_address: getAddress(OWNER),
      resolved_user_id: getAddress(OWNER),
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${LIGHTER_UDA_BASE_URL}/v1/uda`);
    expect(init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "server-only-builder-key" },
      cache: "no-store",
      redirect: "error",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      walletAddress: getAddress(OWNER),
      market: "perps",
      asset: "USDC",
    });
    expect(String(init.body)).not.toContain("server-only-builder-key");
  });

  it("requires the server-only builder key before making a request", async () => {
    delete process.env.GHOLA_LIGHTER_BUILDER_KEY;
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(() => assertLighterUdaCreateConfigured())
      .toThrowError(expect.objectContaining({ code: "lighter_uda_builder_key_unconfigured", status: 503 }));
    await expect(createLighterUniversalDepositAddress({ ownerAddress: OWNER, fetchImpl }))
      .rejects.toMatchObject({ code: "lighter_uda_builder_key_unconfigured", status: 503 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid owner", "0x123", "lighter_uda_owner_address_invalid", {}, {}],
    ["owner mismatch", OWNER, "lighter_uda_create_response_invalid", { userId: "0x1111111111111111111111111111111111111111" }, {}],
    ["blocked address", OWNER, "lighter_uda_create_response_invalid", {}, { blocked: true }],
    ["wrong action", OWNER, "lighter_uda_create_response_invalid", { actionType: "LIGHTER_SPOT" }, {}],
    ["wrong chain", OWNER, "lighter_uda_create_response_invalid", { toChainId: "1" }, {}],
    ["wrong token", OWNER, "lighter_uda_create_response_invalid", { toTokenAddress: "0x1111111111111111111111111111111111111111" }, {}],
    ["mismatched address recipient", OWNER, "lighter_uda_create_response_invalid", { recipientAddr: "0x1111111111111111111111111111111111111111" }, {}],
    ["numeric recipient", OWNER, "lighter_uda_create_response_invalid", { recipientAddr: 123 }, {}],
    ["malformed deposit", OWNER, "lighter_uda_response_address_invalid", {}, { depositAddr: "not-an-address" }],
    ["owner used as deposit", OWNER, "lighter_uda_create_response_invalid", {}, { depositAddr: OWNER }],
    ["zero deposit", OWNER, "lighter_uda_create_response_invalid", {}, { depositAddr: "0x0000000000000000000000000000000000000000" }],
  ] as [string, string, string, Record<string, unknown>, Record<string, unknown>][])("fails closed for %s", async (_name, ownerAddress, code, resolved, root) => {
    const fetchImpl = vi.fn(async () => createResponse(root, resolved)) as unknown as typeof fetch;
    await expect(createLighterUniversalDepositAddress({ ownerAddress, fetchImpl }))
      .rejects.toMatchObject({ code });
    if (ownerAddress === "0x123") expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [400, "lighter_uda_create_rejected", 502],
    [403, "lighter_uda_create_permission_denied", 502],
    [502, "lighter_uda_create_dependency_unavailable", 503],
  ])("fails closed on create HTTP %i", async (upstreamStatus, code, status) => {
    const fetchImpl = vi.fn(async () => Response.json({ errorCode: "redacted" }, { status: upstreamStatus })) as unknown as typeof fetch;
    await expect(createLighterUniversalDepositAddress({ ownerAddress: OWNER, fetchImpl }))
      .rejects.toMatchObject({ code, status });
  });

  it("fails closed on create transport and malformed JSON responses", async () => {
    const unavailable = vi.fn(async () => { throw new Error("network"); }) as unknown as typeof fetch;
    await expect(createLighterUniversalDepositAddress({ ownerAddress: OWNER, fetchImpl: unavailable }))
      .rejects.toMatchObject({ code: "lighter_uda_create_unavailable", status: 503 });
    const malformed = vi.fn(async () => new Response("bad", { status: 200 })) as unknown as typeof fetch;
    await expect(createLighterUniversalDepositAddress({ ownerAddress: OWNER, fetchImpl: malformed }))
      .rejects.toMatchObject({ code: "lighter_uda_create_response_invalid", status: 502 });
  });

  it("reads and validates processing and completed deposits for the exact owner and UDA", async () => {
    const fetchImpl = vi.fn(async () => statusResponse([
      transaction({ status: "PROCESSING", txHash: "processing" }),
      transaction({ status: "COMPLETED", txHash: "completed" }),
    ])) as unknown as typeof fetch;
    const result = await readLighterUniversalDepositStatus({
      ownerAddress: OWNER,
      depositAddress: DEPOSIT,
      fetchImpl,
    });
    expect(result.owner_address).toBe(getAddress(OWNER));
    expect(result.deposit_address).toBe(DEPOSIT);
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions.map((item) => item.status)).toEqual(["PROCESSING", "COMPLETED"]);
    expect(result.completed).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      `${LIGHTER_UDA_BASE_URL}/v1/uda/status/${getAddress(OWNER)}`,
      expect.objectContaining({
        method: "GET",
        headers: { "x-api-key": "server-only-builder-key" },
        cache: "no-store",
        redirect: "error",
      }),
    );
  });

  it("accepts an empty status without claiming completion", async () => {
    const fetchImpl = vi.fn(async () => statusResponse([])) as unknown as typeof fetch;
    const result = await readLighterUniversalDepositStatus({ ownerAddress: OWNER, depositAddress: DEPOSIT, fetchImpl });
    expect(result.transactions).toEqual([]);
    expect(result.completed).toBe(false);
  });

  it.each([
    ["wrong deposit", transaction({ depositAddr: "0x3333333333333333333333333333333333333333" })],
    ["wrong source chain", transaction({ fromChainId: "1" })],
    ["wrong source token", transaction({ fromTokenAddress: "0x1111111111111111111111111111111111111111" })],
    ["wrong destination chain", transaction({ toChainId: "1" })],
    ["wrong destination token", transaction({ toTokenAddress: "0x1111111111111111111111111111111111111111" })],
    ["unknown state", transaction({ status: "FAILED" })],
    ["zero amount", transaction({ fromAmountBaseUnit: "0" })],
    ["below-minimum amount", transaction({ fromAmountBaseUnit: "4999999" })],
    ["unsafe timestamp", transaction({ createdTimeMs: Number.MAX_VALUE })],
    ["missing hash", transaction({ txHash: "" })],
  ])("fails closed on malformed status transaction: %s", async (_name, value) => {
    const fetchImpl = vi.fn(async () => statusResponse([value])) as unknown as typeof fetch;
    await expect(readLighterUniversalDepositStatus({ ownerAddress: OWNER, depositAddress: DEPOSIT, fetchImpl }))
      .rejects.toMatchObject({ code: "lighter_uda_status_response_invalid", status: 502 });
  });

  it("rejects malformed status roots and invalid or owner deposit addresses", async () => {
    const malformed = vi.fn(async () => Response.json({ transactions: {} })) as unknown as typeof fetch;
    await expect(readLighterUniversalDepositStatus({ ownerAddress: OWNER, depositAddress: DEPOSIT, fetchImpl: malformed }))
      .rejects.toMatchObject({ code: "lighter_uda_status_response_invalid", status: 502 });
    await expect(readLighterUniversalDepositStatus({ ownerAddress: OWNER, depositAddress: OWNER, fetchImpl: malformed }))
      .rejects.toMatchObject({ code: "lighter_uda_deposit_address_invalid", status: 400 });
    expect(malformed).toHaveBeenCalledOnce();
  });

  it.each([
    [400, "lighter_uda_status_rejected", 502],
    [403, "lighter_uda_status_permission_denied", 502],
    [502, "lighter_uda_status_dependency_unavailable", 503],
  ])("fails closed on status HTTP %i", async (upstreamStatus, code, status) => {
    const fetchImpl = vi.fn(async () => Response.json({ errorCode: "redacted" }, { status: upstreamStatus })) as unknown as typeof fetch;
    await expect(readLighterUniversalDepositStatus({ ownerAddress: OWNER, depositAddress: DEPOSIT, fetchImpl }))
      .rejects.toMatchObject({ code, status });
  });
});

function createResponse(root: Record<string, unknown> = {}, resolved: Record<string, unknown> = {}) {
  return Response.json({
    depositAddr: DEPOSIT,
    blocked: false,
    resolved: {
      toChainId: "3586256",
      toTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      actionType: "LIGHTER_PERPS",
      recipientAddr: OWNER,
      userId: OWNER,
      ...resolved,
    },
    ...root,
  });
}

function statusResponse(transactions: unknown[]) {
  return Response.json({ transactions });
}

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    fromChainId: "8453",
    fromTokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    fromAmountBaseUnit: "5500000",
    toChainId: "3586256",
    toTokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    txHash: "0xabc123",
    createdTimeMs: 1787068237169,
    status: "PROCESSING",
    depositAddr: DEPOSIT,
    ...overrides,
  };
}
