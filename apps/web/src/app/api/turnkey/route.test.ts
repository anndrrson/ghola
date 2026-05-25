import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as createWallet } from "./create-wallet/route";
import { POST as signMessage } from "./sign-message/route";

function jsonRequest(path: string, body: unknown) {
  return new Request(`https://ghola.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}

describe("Turnkey route privacy defaults", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.TURNKEY_SERVER_CONTROLLED_WALLETS_ENABLED;
    delete process.env.TURNKEY_DANGEROUS_SERVER_CONTROLLED_WALLETS_ALLOW_PRODUCTION;
    delete process.env.TURNKEY_SERVER_SIGNING_ENABLED;
    delete process.env.TURNKEY_DANGEROUS_SERVER_SIGNING_ALLOW_PRODUCTION;
  });

  it("fails closed for server-controlled wallet creation", async () => {
    delete process.env.TURNKEY_SERVER_CONTROLLED_WALLETS_ENABLED;

    const res = await createWallet(
      jsonRequest("/api/turnkey/create-wallet", {
        email: "alice@example.com",
      })
    );
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.code).toBe("turnkey_server_controlled_wallets_disabled");
  });

  it("fails closed for server-side Turnkey signing", async () => {
    delete process.env.TURNKEY_SERVER_SIGNING_ENABLED;

    const res = await signMessage(
      jsonRequest("/api/turnkey/sign-message", {
        message: "Sign in to Ghola\nNonce: abc\nIssued At: 1\nExpires At: 2\nURI: https://ghola.xyz\nVersion: 1",
        subOrgId: "sub-org",
        walletAddress: "wallet-address",
      })
    );
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.code).toBe("turnkey_server_signing_disabled");
  });

  it("keeps server-controlled wallet creation closed in production without the dangerous override", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TURNKEY_SERVER_CONTROLLED_WALLETS_ENABLED", "true");

    const res = await createWallet(
      jsonRequest("/api/turnkey/create-wallet", {
        email: "alice@example.com",
      })
    );
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.code).toBe("turnkey_server_controlled_wallets_disabled");
  });

  it("keeps server-side Turnkey signing closed in production without the dangerous override", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TURNKEY_SERVER_SIGNING_ENABLED", "true");

    const res = await signMessage(
      jsonRequest("/api/turnkey/sign-message", {
        message: "Sign in to Ghola",
        subOrgId: "sub-org",
        walletAddress: "wallet-address",
      })
    );
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.code).toBe("turnkey_server_signing_disabled");
  });
});
