import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRailgunX402 } from "./railgun-x402-client";

function paymentRequired(requirements: unknown): Response {
  return new Response("", {
    status: 402,
    headers: {
      "payment-required": btoa(JSON.stringify(requirements)),
    },
  });
}

describe("fetchWithRailgunX402", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.NEXT_PUBLIC_OHTTP_RELAY_URL;
  });

  it("refuses Railgun settlement without request_hash binding", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        paymentRequired({
          accepts: [
            {
              scheme: "railgun_evm_shielded",
              network: "arbitrum",
              amount: "1000",
              asset: "USDC",
              destination: "0zkrecipient000000000000000000000",
              extra: { payment_rail: "railgun_evm_shielded" },
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const provider = { createPayment: vi.fn() };

    await expect(
      fetchWithRailgunX402("https://example.test/v1/chat/completions", {
        method: "POST",
        body: "{}",
        provider,
      }),
    ).rejects.toThrow(/request_hash/);
    expect(provider.createPayment).not.toHaveBeenCalled();
  });

  it("retries with a request-bound Railgun payment header", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        paymentRequired({
          accepts: [
            {
              scheme: "railgun_evm_shielded",
              network: "arbitrum",
              amount: "1000",
              asset: "USDC",
              destination: "0zkrecipient000000000000000000000",
              extra: {
                payment_rail: "railgun_evm_shielded",
                request_hash: "1".repeat(64),
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = {
      createPayment: vi.fn().mockResolvedValue({ paymentHeader: "paid" }),
    };

    const res = await fetchWithRailgunX402("https://example.test/v1/chat/completions", {
      method: "POST",
      body: "{}",
      provider,
    });

    expect(res.status).toBe(200);
    expect(provider.createPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        extra: expect.objectContaining({ request_hash: "1".repeat(64) }),
      }),
    );
    const retryInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const retryHeaders = new Headers(retryInit.headers);
    expect(retryHeaders.get("x-ghola-payment-rail")).toBe("railgun_evm_shielded");
    expect(retryHeaders.get("x402-payment")).toBe("paid");
    expect(retryHeaders.get("payment-signature")).toBe("paid");
  });

  it("does not allow OHTTP x402 tunneling to arbitrary paths", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchWithRailgunX402("https://example.test/v1/models", {
        method: "POST",
        body: "{}",
        ohttpRelay: "https://ohttp.example/relay",
        provider: { createPayment: vi.fn() },
      }),
    ).rejects.toThrow(/only supports \/v1\/chat\/completions/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses configured OHTTP relay automatically and still path-allowlists", async () => {
    process.env.NEXT_PUBLIC_OHTTP_RELAY_URL = "https://ohttp.example/relay";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchWithRailgunX402("https://example.test/v1/models", {
        method: "POST",
        body: "{}",
        provider: { createPayment: vi.fn() },
      }),
    ).rejects.toThrow(/only supports \/v1\/chat\/completions/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-POST x402 chat requests before payment", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const provider = { createPayment: vi.fn() };

    await expect(
      fetchWithRailgunX402("https://example.test/v1/chat/completions", {
        method: "GET",
        provider,
      }),
    ).rejects.toThrow(/only supports POST/);
    expect(provider.createPayment).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
