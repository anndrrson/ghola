import { afterEach, describe, expect, it } from "vitest";
import { hyperliquidMainnetProofUiEnabled } from "../../_lib";
import { POST } from "./route";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("Hyperliquid mainnet proof route", () => {
  it("is unavailable unless the local loopback execution gate is exact", async () => {
    delete process.env.GHOLA_HYPERLIQUID_MAINNET_PROOF_UI_ENABLED;
    const response = await POST(new Request(
      "http://localhost:3000/v1/private-account/hyperliquid/mainnet-roundtrip",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    ));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "hyperliquid_mainnet_roundtrip_unavailable" });
  });

  it("requires explicit spend gates and a loopback worker", () => {
    const env = {
      NODE_ENV: "development",
      GHOLA_HYPERLIQUID_MAINNET_PROOF_UI_ENABLED: "true",
      GHOLA_PRIVATE_AGENT_SPEND_ARMED: "true",
      GHOLA_PRIVATE_AGENT_REMOTE_EXECUTION_DISABLED: "false",
      GHOLA_PRIVATE_AGENT_SPEND_LOCKDOWN: "false",
      GHOLA_PRIVATE_AGENT_EXECUTION_URL: "http://127.0.0.1:8787",
    };
    expect(hyperliquidMainnetProofUiEnabled(env)).toBe(true);
    expect(hyperliquidMainnetProofUiEnabled({ ...env, GHOLA_PRIVATE_AGENT_SPEND_ARMED: "false" })).toBe(false);
    expect(hyperliquidMainnetProofUiEnabled({ ...env, GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example" })).toBe(false);
    expect(hyperliquidMainnetProofUiEnabled({ ...env, NODE_ENV: "production" })).toBe(false);
  });
});
