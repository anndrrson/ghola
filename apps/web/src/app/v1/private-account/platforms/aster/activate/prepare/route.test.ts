import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const binding = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("@/lib/lighter-turnkey-owner-binding.server", () => ({
  resolveLighterTurnkeyPerpsOwnerBinding: binding.resolve,
}));

import { resetPrivateAccountStoreForTests } from "@/lib/private-account-store";
import { POST } from "./route";

const OWNER = `0x${"42".repeat(20)}`;

describe("Aster owner activation preparation", () => {
  beforeEach(() => {
    process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
    binding.resolve.mockReset().mockResolvedValue({ owner_address: OWNER });
  });

  afterEach(async () => {
    delete process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS;
    vi.restoreAllMocks();
    await resetPrivateAccountStoreForTests();
  });

  it("requests one official LOGIN nonce for the exact Turnkey owner", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      code: "000000",
      success: true,
      data: { nonce: "501182" },
    }));

    const response = await POST(request({ version: 1, owner_address: OWNER }));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      venue_id: "aster",
      owner_address: OWNER,
      challenge: {
        message: "You are signing into Astherus 501182",
        nonce: "501182",
      },
      setup: {
        nonce_requested: true,
        login_submitted: false,
        may_deposit: false,
        may_trade: false,
        may_transfer: false,
        may_withdraw: false,
      },
    });
    expect(body.activation_id).toMatch(/^aster_owner_activation_[0-9a-f]{64}$/);
    expect(binding.resolve).toHaveBeenCalledWith({
      sessionEmail: "aster-activation@example.com",
      ownerAddress: OWNER,
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("https://www.asterdex.com/bapi/futures/v1/public/future/web3/get-nonce");
    expect(init?.headers).toMatchObject({ clientType: "web" });
    expect(JSON.parse(String(init?.body))).toEqual({ type: "LOGIN", sourceAddr: OWNER });
  });

  it("rejects a non-Turnkey owner before requesting a nonce", async () => {
    binding.resolve.mockRejectedValue(Object.assign(
      new Error("lighter_turnkey_owner_binding_mismatch"),
      { status: 403 },
    ));
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const response = await POST(request({ version: 1, owner_address: OWNER }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "aster_turnkey_owner_binding_mismatch" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns the same pending challenge without issuing another nonce", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      code: "000000",
      success: true,
      data: { nonce: "501182" },
    }));

    const first = await POST(request({ version: 1, owner_address: OWNER }));
    const firstBody = await first.json();
    const second = await POST(request({ version: 1, owner_address: OWNER }));
    const secondBody = await second.json();

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(secondBody.activation_id).toBe(firstBody.activation_id);
    expect(secondBody.challenge).toEqual(firstBody.challenge);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("serializes concurrent preparation before requesting a nonce", async () => {
    let resolveNonce!: (response: Response) => void;
    const nonce = new Promise<Response>((resolve) => { resolveNonce = resolve; });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => nonce);

    const first = POST(request({ version: 1, owner_address: OWNER }));
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
    const concurrent = await POST(request({ version: 1, owner_address: OWNER }));

    expect(concurrent.status).toBe(409);
    expect(await concurrent.json()).toEqual({
      error: "aster_owner_activation_preparation_in_progress",
      retry_allowed: false,
      new_preparation_allowed: false,
    });
    resolveNonce(Response.json({ code: "000000", success: true, data: { nonce: "501182" } }));
    expect((await first).status).toBe(201);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});

function request(body: unknown) {
  return new Request("https://ghola.test/v1/private-account/platforms/aster/activate/prepare", {
    method: "POST",
    headers: {
      authorization: auth(),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function auth() {
  return `Bearer ${[
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: "aster-activation", email: "aster-activation@example.com" })).toString("base64url"),
    "sig",
  ].join(".")}`;
}
