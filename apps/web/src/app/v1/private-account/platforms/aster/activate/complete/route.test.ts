import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";

vi.mock("server-only", () => ({}));
const binding = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("@/lib/lighter-turnkey-owner-binding.server", () => ({
  resolveLighterTurnkeyPerpsOwnerBinding: binding.resolve,
}));

import { resetPrivateAccountStoreForTests } from "@/lib/private-account-store";
import { POST as PREPARE } from "../prepare/route";
import { POST as COMPLETE } from "./route";

const OWNER = privateKeyToAccount(`0x${"42".repeat(32)}`);
const WRONG = privateKeyToAccount(`0x${"43".repeat(32)}`);

describe("Aster owner activation completion", () => {
  beforeEach(() => {
    process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
    binding.resolve.mockReset().mockResolvedValue({ owner_address: OWNER.address });
  });

  afterEach(async () => {
    delete process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS;
    vi.restoreAllMocks();
    await resetPrivateAccountStoreForTests();
  });

  it("submits one official login and returns no session token", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(nonceResponse())
      .mockResolvedValueOnce(Response.json({
        code: "000000",
        success: true,
        data: { token: "must-not-leave-server", uid: 12345678 },
      }));
    const preparation = await prepare();
    const signature = await OWNER.signMessage({ message: preparation.challenge.message });

    const response = await COMPLETE(request("complete", completionBody(preparation, signature)));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      status: "owner_login_accepted",
      owner_address: OWNER.address.toLowerCase(),
      setup: {
        owner_login_accepted: true,
        may_deposit: false,
        may_trade: false,
        may_transfer: false,
        may_withdraw: false,
      },
    });
    expect(body.setup).not.toHaveProperty("account_activated");
    expect(JSON.stringify(body)).not.toContain("must-not-leave-server");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [url, init] = fetchSpy.mock.calls[1];
    expect(String(url)).toBe("https://www.asterdex.com/bapi/futures/v1/public/future/web3/ae/login");
    expect(init?.headers).toMatchObject({ clientType: "web" });
    expect(JSON.parse(String(init?.body))).toEqual({
      signature,
      sourceAddr: OWNER.address.toLowerCase(),
      chainId: 56,
    });
  });

  it("blocks the wrong signer before the login endpoint", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(nonceResponse());
    const preparation = await prepare();
    const signature = await WRONG.signMessage({ message: preparation.challenge.message });

    const response = await COMPLETE(request("complete", completionBody(preparation, signature)));

    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("aster_owner_activation_wrong_wallet");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("locks an uncertain login outcome against retry", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(nonceResponse())
      .mockRejectedValueOnce(new TypeError("connection reset"));
    const preparation = await prepare();
    const signature = await OWNER.signMessage({ message: preparation.challenge.message });
    const body = completionBody(preparation, signature);

    const response = await COMPLETE(request("complete", body));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "aster_owner_activation_outcome_ambiguous",
      retry_allowed: false,
      new_preparation_allowed: false,
    });
    const retry = await COMPLETE(request("complete", body));
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ status: "ambiguous", retry_allowed: false });
    const reprepare = await PREPARE(request("prepare", { version: 1, owner_address: OWNER.address }));
    expect(reprepare.status).toBe(409);
    expect(await reprepare.json()).toMatchObject({ status: "ambiguous", new_preparation_allowed: false });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("returns an accepted attempt idempotently without a second login", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(nonceResponse())
      .mockResolvedValueOnce(Response.json({
        code: "000000",
        success: true,
        data: { token: "server-only", uid: 12345678 },
      }));
    const preparation = await prepare();
    const signature = await OWNER.signMessage({ message: preparation.challenge.message });
    const body = completionBody(preparation, signature);

    expect((await COMPLETE(request("complete", body))).status).toBe(201);
    const duplicate = await COMPLETE(request("complete", body));

    expect(duplicate.status).toBe(201);
    expect(await duplicate.json()).toMatchObject({ status: "owner_login_accepted" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("atomically rejects a concurrent duplicate while one login is in flight", async () => {
    let resolveLogin!: (response: Response) => void;
    const login = new Promise<Response>((resolve) => { resolveLogin = resolve; });
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(nonceResponse())
      .mockImplementationOnce(() => login);
    const preparation = await prepare();
    const signature = await OWNER.signMessage({ message: preparation.challenge.message });
    const body = completionBody(preparation, signature);

    const first = COMPLETE(request("complete", body));
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    const duplicate = await COMPLETE(request("complete", body));
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ status: "submitted", retry_allowed: false });
    resolveLogin(Response.json({
      code: "000000",
      success: true,
      data: { token: "server-only", uid: 12345678 },
    }));
    expect((await first).status).toBe(201);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("freezes a malformed 4xx response as ambiguous", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(nonceResponse())
      .mockResolvedValueOnce(Response.json({ error: "gateway changed shape" }, { status: 400 }));
    const preparation = await prepare();
    const signature = await OWNER.signMessage({ message: preparation.challenge.message });

    const response = await COMPLETE(request("complete", completionBody(preparation, signature)));

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: "aster_owner_activation_outcome_ambiguous",
      new_preparation_allowed: false,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("freezes a timeout response even when its body resembles a rejection", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(nonceResponse())
      .mockResolvedValueOnce(Response.json({ success: false, code: "100001" }, { status: 408 }));
    const preparation = await prepare();
    const signature = await OWNER.signMessage({ message: preparation.challenge.message });

    const response = await COMPLETE(request("complete", completionBody(preparation, signature)));

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: "aster_owner_activation_outcome_ambiguous",
      new_preparation_allowed: false,
    });
  });

  it("allows one fresh preparation only after a validated explicit rejection", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(nonceResponse())
      .mockResolvedValueOnce(Response.json({ success: false, code: "100001" }, { status: 400 }))
      .mockResolvedValueOnce(Response.json({
        code: "000000",
        success: true,
        data: { nonce: "501183" },
      }));
    const preparation = await prepare();
    const signature = await OWNER.signMessage({ message: preparation.challenge.message });
    const rejection = await COMPLETE(request("complete", completionBody(preparation, signature)));

    expect(rejection.status).toBe(409);
    expect(await rejection.json()).toMatchObject({
      error: "aster_owner_activation_rejected",
      new_preparation_allowed: true,
    });
    const replacement = await PREPARE(request("prepare", { version: 1, owner_address: OWNER.address }));
    expect(replacement.status).toBe(201);
    expect((await replacement.json()).activation_id).not.toBe(preparation.activation_id);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});

interface Preparation {
  activation_id: string;
  owner_address: string;
  challenge: { nonce: string; message: string };
}

async function prepare(): Promise<Preparation> {
  const response = await PREPARE(request("prepare", { version: 1, owner_address: OWNER.address }));
  expect(response.status).toBe(201);
  return response.json();
}

function completionBody(preparation: Preparation, signature: string) {
  return {
    version: 1,
    activation_id: preparation.activation_id,
    owner_address: preparation.owner_address,
    nonce: preparation.challenge.nonce,
    message: preparation.challenge.message,
    signature,
  };
}

function nonceResponse() {
  return Response.json({ code: "000000", success: true, data: { nonce: "501182" } });
}

function request(kind: "prepare" | "complete", body: unknown) {
  return new Request(`https://ghola.test/v1/private-account/platforms/aster/activate/${kind}`, {
    method: "POST",
    headers: { authorization: auth(), "content-type": "application/json" },
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
