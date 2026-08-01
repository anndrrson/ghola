import { describe, expect, it, vi } from "vitest";
import { inspectHyperliquidFundingPreflight } from "./hyperliquid-funding-preflight";

const master = "0x1111111111111111111111111111111111111111";
const agent = "0x2222222222222222222222222222222222222222";

describe("Hyperliquid funding preflight", () => {
  it("proves mainnet identity and unified collateral without calling an order endpoint", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(new URL(String(url)).pathname).toBe("/info");
      const body = JSON.parse(String(init?.body));
      return response(body.type, {}, body.user);
    }) as unknown as typeof fetch;
    const result = await inspectHyperliquidFundingPreflight({
      network: "mainnet",
      masterAccountAddress: master,
      connectedWalletAddress: master.toUpperCase().replace("0X", "0x"),
      apiWalletAddress: agent,
      fetchImpl,
    });
    expect(result.status).toBe("ready_to_trade");
    expect(result.ready_to_trade).toBe(true);
    expect(result.deposit_route.api_wallet_receives_funds).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(fetchImpl.mock.calls.every(([url]) => new URL(String(url)).pathname === "/info")).toBe(true);
  });

  it("blocks trading but preserves deposit identity when signer and USDC are missing", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return response(body.type, { missingAgent: true, collateral: "0" }, body.user);
    }) as unknown as typeof fetch;
    const result = await inspectHyperliquidFundingPreflight({
      network: "mainnet",
      masterAccountAddress: master,
      connectedWalletAddress: master,
      apiWalletAddress: agent,
      fetchImpl,
    });
    expect(result.status).toBe("identity_ready_for_official_deposit");
    expect(result.identity_ready_for_official_deposit).toBe(true);
    expect(result.ready_for_no_submit_verification).toBe(false);
    expect(result.ready_to_trade).toBe(false);
    expect(result.checks.find((check) => check.id === "api_wallet")?.status).toBe("blocked");
    expect(result.checks.find((check) => check.id === "collateral")?.status).toBe("blocked");
  });

  it("blocks the official deposit identity when wallet and master differ", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return response(body.type, {}, body.user);
    }) as unknown as typeof fetch;
    const result = await inspectHyperliquidFundingPreflight({
      network: "mainnet",
      masterAccountAddress: master,
      connectedWalletAddress: "0x3333333333333333333333333333333333333333",
      apiWalletAddress: agent,
      fetchImpl,
    });
    expect(result.status).toBe("blocked");
    expect(result.identity_ready_for_official_deposit).toBe(false);
    expect(result.checks.find((check) => check.id === "wallet_match")?.detail).toContain("Do not deposit");
  });
});

function response(type: string, options: { missingAgent?: boolean; collateral?: string } = {}, user?: string) {
  if (type === "userRole") {
    if (String(user).toLowerCase() === master) return json({ role: "user" });
    if (options.missingAgent) return json({ role: "missing" });
    return json({ role: "agent", data: { user: master } });
  }
  if (type === "userAbstraction") return json("unifiedAccount");
  if (type === "spotClearinghouseState") return json({ tokenToAvailableAfterMaintenance: [[0, options.collateral ?? "30"]] });
  if (type === "clearinghouseState") return json({ marginSummary: { accountValue: "0" } });
  if (type === "meta") return json({ universe: ["BTC", "ETH", "SOL"].map((name) => ({ name })) });
  throw new Error(`unexpected ${type}`);
}

function json(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}
