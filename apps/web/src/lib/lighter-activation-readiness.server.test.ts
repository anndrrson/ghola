import { describe, expect, it, vi } from "vitest";
import { readLighterActivationReadiness } from "./lighter-activation-readiness.server";

const OWNER = "0xa0582521e11effdf12ff00b50087802c3346e7ef";

describe("Lighter activation readiness", () => {
  it("separates Base collateral from Base and Ethereum gas blockers", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("accountsByL1Address")) return lighterAccountMissing();
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
      ethereum_association_gas_ready: false,
      lighter_owner_account_ready: false,
      ready: false,
      blockers: ["lighter_base_gas_required", "lighter_owner_account_required", "lighter_ethereum_association_gas_required"],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it("reports ready only when the exact owner account and association gas are present", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("accountsByL1Address")) return lighterAccount();
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
    expect(result.ethereum_association_gas_ready).toBe(true);
    expect(result.lighter_owner_account_ready).toBe(true);
    expect(result.lighter_account_index).toBe(123);
    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it("fails closed when gas is funded but Lighter has no owner account", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("accountsByL1Address")) return lighterAccountMissing();
      const request = JSON.parse(String(init?.body)) as { method: string };
      if (request.method === "eth_call") return rpc("0x2dc6c0");
      if (request.method === "eth_gasPrice") return rpc("0x1");
      return rpc("0xb71b0");
    }) as unknown as typeof fetch;
    const result = await readLighterActivationReadiness({
      ownerAddress: OWNER,
      fetchImpl,
      baseRpcUrl: "https://base.example",
      ethereumRpcUrl: "https://ethereum.example",
    });
    expect(result.ethereum_association_gas_ready).toBe(true);
    expect(result.lighter_owner_account_ready).toBe(false);
    expect(result.ready).toBe(false);
    expect(result.blockers).toContain("lighter_owner_account_required");
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

function lighterAccount() {
  return Response.json({
    code: 200,
    l1_address: OWNER,
    sub_accounts: [{ index: 123, account_type: 0, l1_address: OWNER }],
  });
}

function lighterAccountMissing() {
  return Response.json({ code: 21100, message: "account not found" }, { status: 400 });
}
