import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  authorizeHyperliquidAgentWithInjectedOwner,
  connectInjectedHyperliquidOwner,
  injectedWalletErrorMessage,
  resolveInjectedEvmProvider,
} from "./hyperliquid-owner-authorization";

const approveAgent = vi.hoisted(() => vi.fn());

vi.mock("@nktkas/hyperliquid", () => ({
  HttpTransport: class HttpTransport {},
  ExchangeClient: class ExchangeClient {
    approveAgent = approveAgent;
  },
}));

const OWNER = "0x1111111111111111111111111111111111111111" as const;
const AGENT = "0x2222222222222222222222222222222222222222" as const;

describe("injected Hyperliquid owner authorization", () => {
  beforeEach(() => approveAgent.mockReset());

  it("prefers Phantom over a colliding window.ethereum provider", () => {
    const phantom = { isPhantom: true, request: vi.fn() };
    const other = { request: vi.fn() };
    expect(resolveInjectedEvmProvider({ phantom: { ethereum: phantom }, ethereum: other } as never))
      .toBe(phantom);
  });

  it("connects the owner and approves the deterministic Ghola agent name", async () => {
    const provider = { request: vi.fn().mockResolvedValue([OWNER]) };
    expect(await connectInjectedHyperliquidOwner(provider)).toBe(OWNER);
    await authorizeHyperliquidAgentWithInjectedOwner({
      provider,
      ownerAddress: OWNER,
      agentAddress: AGENT,
      network: "mainnet",
    });
    expect(approveAgent).toHaveBeenCalledWith({ agentAddress: AGENT, agentName: "ghola" });
  });

  it("turns duplicate approval prompts into a precise recovery message", () => {
    expect(injectedWalletErrorMessage({ code: -32002 })).toContain("already open");
    expect(injectedWalletErrorMessage({ code: 4001 })).toContain("canceled");
  });
});
