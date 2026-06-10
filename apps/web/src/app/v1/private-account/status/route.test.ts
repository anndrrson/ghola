import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as createAccount } from "../create/route";
import { POST } from "./route";
import { POST as updateVault } from "../vault/readiness/route";
import { resetPrivateAccountStoreForTests } from "@/lib/private-account-store";

const SESSION_TOKEN = "valid-test-session-token";
const AUTH = `Bearer ${SESSION_TOKEN}`;
const FORGED_AUTH = `Bearer ${[
  Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
  Buffer.from(JSON.stringify({ sub: "user_1", email: "user@example.com" })).toString("base64url"),
  "sig",
].join(".")}`;
const INTERNAL_TOKEN = "test_internal_private_account_token";

function request(path: string, body: unknown = {}, auth = AUTH) {
  return new Request(`https://ghola.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: auth } : {}),
    },
    body: JSON.stringify(body),
  });
}

function internalRequest(path: string, body: unknown = {}, token = INTERNAL_TOKEN) {
  return new Request(`https://ghola.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

describe("private account status routes", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const auth = new Headers(init?.headers).get("authorization");
      if (auth === `Bearer ${SESSION_TOKEN}`) {
        return new Response(
          JSON.stringify({
            id: "user_1",
            email: "user@example.com",
            display_name: "Test User",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await resetPrivateAccountStoreForTests();
    delete process.env.GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN;
  });

  it("creates an owner-bound private-mode account and returns stable status", async () => {
    const createRes = await createAccount(request("/v1/private-account/create"));
    const created = await createRes.json();
    const statusRes = await POST(request("/v1/private-account/status"));
    const status = await statusRes.json();

    expect(createRes.status).toBe(201);
    expect(created.account.privacy_mode).toBe("private_mode");
    expect(status.account.account_commitment).toBe(created.account.account_commitment);
    expect(status.account.vault_ready).toBe(false);
  });

  it("only updates vault readiness through internal auth", async () => {
    process.env.GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN = INTERNAL_TOKEN;
    const createRes = await createAccount(request("/v1/private-account/create"));
    const created = await createRes.json();
    const userRes = await updateVault(
      request("/v1/private-account/vault/readiness", {
        account_commitment: created.account.account_commitment,
        vault_ready: true,
        ready_rails: ["shielded_pool"],
      }),
    );
    const userBody = await userRes.json();
    expect(userRes.status).toBe(401);
    expect(userBody.error).toBe("internal_auth_required");

    const res = await updateVault(
      internalRequest("/v1/private-account/vault/readiness", {
        account_commitment: created.account.account_commitment,
        vault_ready: true,
        ready_rails: ["shielded_pool"],
        balance_bucket_summary: ["stablecoin_25"],
        last_import_commitment: "import_commitment_1",
      }),
    );
    const body = await res.json();

    expect(body.account.vault_ready).toBe(true);
    expect(body.vault.ready_rails).toEqual(["shielded_pool"]);
    expect(JSON.stringify(body)).not.toContain("exact_balance");
  });

  it("rejects unauthenticated status requests", async () => {
    const res = await POST(request("/v1/private-account/status", {}, ""));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("private_account_auth_required");
  });

  it("rejects unsigned forged bearer JWTs", async () => {
    const res = await POST(request("/v1/private-account/status", {}, FORGED_AUTH));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("private_account_auth_required");
  });
});
