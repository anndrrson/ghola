import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { privateKeyToAccount } from "viem/accounts";
import { POST } from "./route";
import { LIGHTER_FUNDING_ELIGIBILITY_ATTESTATION } from "@/lib/lighter-funding-eligibility";

const bindingMocks = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("@/lib/lighter-turnkey-owner-binding.server", () => ({
  resolveLighterTurnkeyPerpsOwnerBinding: bindingMocks.resolve,
}));

const SECRET = "secure-lighter-uda-authorization-secret-2026";
const OWNER = privateKeyToAccount(`0x${"11".repeat(32)}`).address;
const OLD_SECRET = process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET;

vi.mock("server-only", () => ({}));

describe("POST /api/carry/lighter-deposit-authorization", () => {
  beforeEach(() => {
    process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET = SECRET;
    bindingMocks.resolve.mockReset().mockResolvedValue({});
  });

  afterEach(() => {
    if (OLD_SECRET === undefined) delete process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET;
    else process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET = OLD_SECRET;
    vi.restoreAllMocks();
  });

  it("issues a no-store, session-bound address-generation challenge", async () => {
    const fetchSpy = profileFetch();
    const response = await POST(request({ version: 1, owner_address: OWNER }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(body).toMatchObject({
      version: 1,
      owner_address: OWNER,
      authorization: {
        action: "create_lighter_uda",
        source_chain_id: 8453,
        source_chain: "base",
        source_asset: "USDC",
        destination_market: "perps",
        eligibility: {
          version: 1,
          terms_version: "2025-12-29",
          accepts_lighter_terms: true,
          attests_not_prohibited_person: true,
          country_code: "DE",
          country_source: "vercel_request_header",
          eligible: true,
        },
        transfer_authorized: false,
        withdrawal_authorized: false,
        trade_authorized: false,
      },
    });
    expect(body.challenge_token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(body.message).toContain("Ghola Lighter deposit address authorization");
    expect(body.message).toContain("Source chain: Base (8453)");
    expect(body.message).toContain("This authorizes address generation only.");
    expect(body.message).toContain("Server-verified country: DE");
    expect(body.message).toContain("It does not authorize a transfer, withdrawal, or trade.");
    expect(body.message).not.toContain(SECRET);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("uses crypto-secure unique nonces for separate challenges", async () => {
    profileFetch();
    const one = await (await POST(request({ version: 1, owner_address: OWNER }))).json();
    const two = await (await POST(request({ version: 1, owner_address: OWNER }))).json();
    expect(one.challenge_token).not.toBe(two.challenge_token);
    expect(one.message).not.toBe(two.message);
  });

  it("rejects cross-site requests before session lookup", async () => {
    const fetchSpy = profileFetch();
    const response = await POST(request({ version: 1, owner_address: OWNER }, {
      origin: "https://attacker.example",
    }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "lighter_uda_cross_site_rejected" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("requires JSON and an exact request schema", async () => {
    const fetchSpy = profileFetch();
    const notJson = await POST(request({ version: 1, owner_address: OWNER }, { contentType: "text/plain" }));
    expect(notJson.status).toBe(415);
    const smuggled = await POST(request({ version: 1, owner_address: OWNER, amount: "5000000" }));
    expect(smuggled.status).toBe(400);
    const malformed = await POST(request({ version: 2, owner_address: OWNER }));
    expect(malformed.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(["US", "CA", "GB", "CN", "KP", "RU", "UA", "CU", "IR", "VE", "SD", "BY", "MM", "SY"])(
    "blocks restricted country %s before session lookup",
    async (country) => {
      const fetchSpy = profileFetch();
      const response = await POST(request({ version: 1, owner_address: OWNER }, { country }));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "lighter_uda_eligibility_country_restricted" });
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it("blocks missing or unknown country and an invalid attestation", async () => {
    const fetchSpy = profileFetch();
    const missing = await POST(request({ version: 1, owner_address: OWNER }, { country: null }));
    expect(missing.status).toBe(403);
    expect((await missing.json()).error).toBe("lighter_uda_eligibility_country_unavailable");
    const unknown = await POST(request({ version: 1, owner_address: OWNER }, { country: "XX" }));
    expect(unknown.status).toBe(403);
    const invalid = await POST(request({
      version: 1,
      owner_address: OWNER,
      eligibility_attestation: {
        ...LIGHTER_FUNDING_ELIGIBILITY_ATTESTATION,
        accepts_lighter_terms: false,
      },
    }));
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error).toBe("lighter_uda_eligibility_attestation_invalid");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never returns the raw client IP", async () => {
    profileFetch();
    const response = await POST(request({ version: 1, owner_address: OWNER }, { forwardedFor: "203.0.113.7" }));
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("203.0.113.7");
  });

  it("requires a live session cookie", async () => {
    const fetchSpy = profileFetch();
    const response = await POST(request({ version: 1, owner_address: OWNER }, { cookie: "" }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "lighter_uda_session_required" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    [401, 401, "lighter_uda_session_invalid"],
    [403, 401, "lighter_uda_session_invalid"],
    [500, 503, "lighter_uda_session_unavailable"],
  ])("fails closed for session status %i", async (upstreamStatus, status, error) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}, { status: upstreamStatus }));
    const response = await POST(request({ version: 1, owner_address: OWNER }));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
  });

  it("fails closed when session verification is unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network detail must not leak"));
    const response = await POST(request({ version: 1, owner_address: OWNER }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "lighter_uda_session_unavailable" });
  });

  it("fails closed when the server-only HMAC secret is absent", async () => {
    delete process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET;
    profileFetch();
    const response = await POST(request({ version: 1, owner_address: OWNER }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "lighter_uda_authorization_unconfigured" });
  });

  it("rejects an invalid owner without exposing the session or secret", async () => {
    profileFetch();
    const response = await POST(request({ version: 1, owner_address: "0x123" }));
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "lighter_uda_owner_address_invalid" });
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("user-1");
  });

  it("rejects an EOA that is not the exact server-verified Turnkey perps owner", async () => {
    profileFetch();
    bindingMocks.resolve.mockRejectedValueOnce(Object.assign(
      new Error("lighter_turnkey_owner_binding_mismatch"),
      { code: "lighter_turnkey_owner_binding_mismatch", status: 403 },
    ));
    const response = await POST(request({ version: 1, owner_address: OWNER }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "lighter_uda_authorization_failed" });
  });
});

function profileFetch(userId = "user-1") {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
    id: userId,
    email: "user@example.com",
    display_name: "User",
  }));
}

function request(body: Record<string, unknown>, overrides: {
  origin?: string;
  contentType?: string;
  cookie?: string;
  country?: string | null;
  forwardedFor?: string;
} = {}) {
  const headers = new Headers({
    origin: overrides.origin ?? "https://ghola.example",
    "content-type": overrides.contentType ?? "application/json",
  });
  if (overrides.country !== null) headers.set("x-vercel-ip-country", overrides.country ?? "DE");
  if (overrides.forwardedFor) headers.set("x-forwarded-for", overrides.forwardedFor);
  const cookie = overrides.cookie === undefined ? "ghola_thumper_session=session-token" : overrides.cookie;
  if (cookie) headers.set("cookie", cookie);
  const requestBody = Object.hasOwn(body, "eligibility_attestation")
    ? body
    : { ...body, eligibility_attestation: LIGHTER_FUNDING_ELIGIBILITY_ATTESTATION };
  return new NextRequest("https://ghola.example/api/carry/lighter-deposit-authorization", {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
  });
}
