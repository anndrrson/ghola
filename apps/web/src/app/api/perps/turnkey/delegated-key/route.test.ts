import { afterEach, describe, expect, it } from "vitest";
import { GET } from "./route";

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("Turnkey delegated-key config", () => {
  it("fails closed and defaults to testnet/no-submit", async () => {
    delete process.env.GHOLA_TURNKEY_AGENT_API_PUBLIC_KEY;
    delete process.env.GHOLA_PERPS_MAINNET_ENABLED;
    delete process.env.GHOLA_PERPS_LIVE_SUBMIT;
    const body = await GET().then((response) => response.json());
    expect(body.configured).toBe(false);
    expect(body.network).toBe("testnet");
    expect(body.no_submit_default).toBe(true);
    expect(body.public_key).toBeNull();
  });

  it("exposes only a valid public key reference", async () => {
    process.env.GHOLA_TURNKEY_AGENT_API_PUBLIC_KEY = `04${"ab".repeat(64)}`;
    process.env.GHOLA_TURNKEY_AGENT_KEY_REF = "worker-test";
    const body = await GET().then((response) => response.json());
    expect(body.configured).toBe(true);
    expect(body.public_key).toBe(`04${"ab".repeat(64)}`);
    expect(JSON.stringify(body)).not.toContain("private_key");
    expect(body.key_ref).toBe("worker-test");
  });
});
