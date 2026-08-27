import { describe, expect, it, vi } from "vitest";
import { readLighterActivationReadiness } from "./lighter-activation-readiness.server";

const OWNER = "0xa0582521e11effdf12ff00b50087802c3346e7ef";

describe("Lighter activation readiness", () => {
  it("separates Base collateral from Base and Ethereum gas blockers", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const request = JSON.parse(String(init?.body)) as { method: string };
      if (request.method === "eth_call") return rpc("0x2dc6c0");
      if (request.method === "eth_gasPrice") return rpc(url.includes("base") ? "0x1" : "0x2");
      return rpc("0x0");
    }) as unknown as typeof fetch;
    const result = await readLighterActivationReadiness({
      ownerAddress: OWNER,
      fetchImpl,
      baseRpcUrl: "https://base.example",
      ethereumRpcUrl: "https://ethereum.example",
      now: () => new Date("2026-08-27T00:00:00.000Z"),
    });
    expect(result).toMatchObject({
      base_usdc_microunits: "3000000",
      base_eth_wei: "0",
      ethereum_eth_wei: "0",
      estimated_base_gas_wei: "500000",
      estimated_ethereum_association_gas_wei: "1500000",
      base_deposit_ready: false,
      ethereum_association_ready: false,
      ready: false,
      blockers: ["lighter_base_gas_required", "lighter_ethereum_association_gas_required"],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("reports ready only when collateral and both gas budgets are present", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const request = JSON.parse(String(init?.body)) as { method: string };
      if (request.method === "eth_call") return rpc("0x2dc6c0");
      if (request.method === "eth_gasPrice") return rpc("0x1");
      return rpc(url.includes("base") ? "0x7a120" : "0xb71b0");
    }) as unknown as typeof fetch;
    const result = await readLighterActivationReadiness({
      ownerAddress: OWNER,
      fetchImpl,
      baseRpcUrl: "https://base.example",
      ethereumRpcUrl: "https://ethereum.example",
    });
    expect(result.base_deposit_ready).toBe(true);
    expect(result.ethereum_association_ready).toBe(true);
    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it("rejects malformed owner addresses before any RPC call", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(readLighterActivationReadiness({ ownerAddress: "0x123", fetchImpl }))
      .rejects.toMatchObject({ code: "lighter_owner_address_invalid", status: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function rpc(result: string) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
