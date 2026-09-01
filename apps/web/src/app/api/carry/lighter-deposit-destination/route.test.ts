import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { privateKeyToAccount } from "viem/accounts";
import { gholaCommitment } from "@/lib/private-account";
import {
  issueLighterDepositAuthorization,
  LIGHTER_DEPOSIT_AUTHORIZATION_TTL_MS,
} from "@/lib/lighter-deposit-authorization.server";
import { resetPrivateLighterUdaAttemptsForTests } from "@/lib/private-account-store";
import { POST } from "./route";

const SECRET = "secure-lighter-uda-authorization-secret-2026";
const BUILDER_KEY = "server-only-lighter-builder-key";
const ACCOUNT = privateKeyToAccount(`0x${"11".repeat(32)}`);
const OTHER_ACCOUNT = privateKeyToAccount(`0x${"22".repeat(32)}`);
const DEPOSIT = "0x3333333333333333333333333333333333333333";
const OLD_SECRET = process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET;
const OLD_BUILDER_KEY = process.env.GHOLA_LIGHTER_BUILDER_KEY;

vi.mock("server-only", () => ({}));

describe("POST /api/carry/lighter-deposit-destination", () => {
  beforeEach(() => {
    process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET = SECRET;
    process.env.GHOLA_LIGHTER_BUILDER_KEY = BUILDER_KEY;
  });

  afterEach(() => {
    resetPrivateLighterUdaAttemptsForTests();
    restoreEnv("GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET", OLD_SECRET);
    restoreEnv("GHOLA_LIGHTER_BUILDER_KEY", OLD_BUILDER_KEY);
    vi.restoreAllMocks();
  });

  it("verifies session and owner signature before making exactly one UDA call", async () => {
    const fetchSpy = mockProfileAndUda();
    const { request, challengeToken, signature } = await signedRequest();
    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(body).toMatchObject({
      version: 1,
      venue_id: "lighter",
      network: "mainnet",
      owner_address: ACCOUNT.address,
      source: {
        chain_id: 8453,
        chain: "base",
        asset: "USDC",
        minimum_microunits: "5000000",
        recommended_microunits: "5500000",
      },
      destination: {
        deposit_address: DEPOSIT,
        provider: "lighter_fun_uda",
        market: "perps",
        asset: "USDC",
        blocked: false,
        resolved: {
          to_chain_id: "3586256",
          to_token_address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          action_type: "LIGHTER_PERPS",
          recipient_address: ACCOUNT.address,
          user_id: ACCOUNT.address,
        },
      },
      deposit_destination_verified: true,
      funding_action_enabled: true,
      safety: {
        address_generation_only: true,
        transfer_performed: false,
        withdrawal_performed: false,
        trade_performed: false,
        bounded_replay: "returns_only_the_original_owner_bound_destination",
      },
    });
    expect(body.source.token_address.toLowerCase()).toBe("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
    expect(udaCalls(fetchSpy)).toHaveLength(1);
    const [, init] = udaCalls(fetchSpy)[0] as [string, RequestInit];
    expect(init.headers).toEqual({ "content-type": "application/json", "x-api-key": BUILDER_KEY });
    expect(JSON.parse(String(init.body))).toEqual({
      walletAddress: ACCOUNT.address,
      market: "perps",
      asset: "USDC",
    });
    const text = JSON.stringify(body);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(BUILDER_KEY);
    expect(text).not.toContain(challengeToken);
    expect(text).not.toContain(signature);
  });

  it("rejects a session mismatch before calling Lighter", async () => {
    const fetchSpy = mockProfileAndUda("other-session-user");
    const response = await POST((await signedRequest()).request);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "lighter_uda_authorization_session_mismatch" });
    expect(udaCalls(fetchSpy)).toHaveLength(0);
  });

  it("rejects a different wallet signature before calling Lighter", async () => {
    const fetchSpy = mockProfileAndUda();
    const issued = authorization();
    const signature = await OTHER_ACCOUNT.signMessage({ message: issued.message });
    const response = await POST(destinationRequest({
      version: 1,
      challenge_token: issued.challenge_token,
      signature,
    }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "lighter_uda_owner_signature_mismatch" });
    expect(udaCalls(fetchSpy)).toHaveLength(0);
  });

  it("rejects expired and tampered challenges before calling Lighter", async () => {
    const fetchSpy = mockProfileAndUda();
    const expired = authorization(Date.now() - LIGHTER_DEPOSIT_AUTHORIZATION_TTL_MS - 1);
    const expiredSignature = await ACCOUNT.signMessage({ message: expired.message });
    const expiredResponse = await POST(destinationRequest({
      version: 1,
      challenge_token: expired.challenge_token,
      signature: expiredSignature,
    }));
    expect(expiredResponse.status).toBe(403);
    expect((await expiredResponse.json()).error).toBe("lighter_uda_authorization_expired");

    const current = authorization();
    const currentSignature = await ACCOUNT.signMessage({ message: current.message });
    const [payload, mac] = current.challenge_token.split(".");
    const tamperedResponse = await POST(destinationRequest({
      version: 1,
      challenge_token: `${payload.slice(0, -1)}A.${mac}`,
      signature: currentSignature,
    }));
    expect(tamperedResponse.status).toBe(403);
    expect((await tamperedResponse.json()).error).toBe("lighter_uda_authorization_invalid");
    expect(udaCalls(fetchSpy)).toHaveLength(0);
  });

  it("rejects cross-site and schema-smuggling requests before session lookup", async () => {
    const fetchSpy = mockProfileAndUda();
    const signed = await signedBody();
    const crossSite = await POST(destinationRequest(signed, { origin: "https://attacker.example" }));
    expect(crossSite.status).toBe(403);
    const smuggled = await POST(destinationRequest({ ...signed, owner_address: ACCOUNT.address }));
    expect(smuggled.status).toBe(400);
    const amount = await POST(destinationRequest({ ...signed, amount: "5500000" }));
    expect(amount.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("requires JSON and a live session", async () => {
    const fetchSpy = mockProfileAndUda();
    const signed = await signedBody();
    const notJson = await POST(destinationRequest(signed, { contentType: "text/plain" }));
    expect(notJson.status).toBe(415);
    const noCookie = await POST(destinationRequest(signed, { cookie: "" }));
    expect(noCookie.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never retries an ambiguous UDA request and disables funding", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/user/profile")) return profileResponse("user-1");
      if (url === "https://bridge.lighter.xyz/v1/uda") throw new TypeError("ambiguous transport detail");
      throw new Error("unexpected request");
    });
    const response = await POST((await signedRequest()).request);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "lighter_uda_create_unavailable",
      ambiguity: true,
      retry_forbidden: true,
      manual_reconciliation_required: true,
      deposit_destination_verified: false,
      funding_action_enabled: false,
    });
    expect(udaCalls(fetchSpy)).toHaveLength(1);
  });

  it("sanitizes an invalid provider response and leaves funding disabled", async () => {
    const fetchSpy = mockProfileAndUda("user-1", {
      resolved: { userId: OTHER_ACCOUNT.address },
      private_provider_detail: SECRET,
    });
    const response = await POST((await signedRequest()).request);
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      error: "lighter_uda_create_response_invalid",
      ambiguity: true,
      retry_forbidden: true,
      manual_reconciliation_required: true,
      deposit_destination_verified: false,
      funding_action_enabled: false,
    });
    expect(text).not.toContain(SECRET);
    expect(udaCalls(fetchSpy)).toHaveLength(1);
  });

  it("fails closed before Lighter when the server secret is absent", async () => {
    delete process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET;
    const fetchSpy = mockProfileAndUda();
    const response = await POST((await signedRequest()).request);
    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe("lighter_uda_authorization_unconfigured");
    expect(udaCalls(fetchSpy)).toHaveLength(0);
  });

  it("returns the durable verified destination without replaying the provider request", async () => {
    const fetchSpy = mockProfileAndUda();
    const first = await POST((await signedRequest()).request);
    expect(first.status).toBe(200);
    const firstBody = await first.json();

    const second = await POST((await signedRequest()).request);
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.destination).toEqual(firstBody.destination);
    expect(udaCalls(fetchSpy)).toHaveLength(1);
  });

  it("allows only one in-flight provider request for the same Ghola owner", async () => {
    let releaseUda!: () => void;
    const udaPending = new Promise<void>((resolve) => { releaseUda = resolve; });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/user/profile")) return profileResponse("user-1");
      if (url === "https://bridge.lighter.xyz/v1/uda") {
        await udaPending;
        return udaResponse();
      }
      throw new Error("unexpected request");
    });
    const firstPromise = POST((await signedRequest()).request);
    await vi.waitFor(() => expect(udaCalls(fetchSpy)).toHaveLength(1));

    const second = await POST((await signedRequest()).request);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({
      error: "lighter_uda_attempt_pending",
      ambiguity: true,
      retry_forbidden: true,
      manual_reconciliation_required: true,
      deposit_destination_verified: false,
      funding_action_enabled: false,
    });
    expect(udaCalls(fetchSpy)).toHaveLength(1);

    releaseUda();
    expect((await firstPromise).status).toBe(200);
  });

  it("durably blocks every retry after a post-dispatch failure", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/user/profile")) return profileResponse("user-1");
      if (url === "https://bridge.lighter.xyz/v1/uda") {
        return Response.json({ unavailable: true }, { status: 500 });
      }
      throw new Error("unexpected request");
    });
    const first = await POST((await signedRequest()).request);
    expect(first.status).toBe(503);
    expect((await first.json()).retry_forbidden).toBe(true);

    const second = await POST((await signedRequest()).request);
    expect(second.status).toBe(409);
    expect((await second.json()).error).toBe("lighter_uda_attempt_ambiguous");
    expect(udaCalls(fetchSpy)).toHaveLength(1);
  });

  it("does not consume the claim when the builder key is missing", async () => {
    delete process.env.GHOLA_LIGHTER_BUILDER_KEY;
    const fetchSpy = mockProfileAndUda();
    const first = await POST((await signedRequest()).request);
    expect(first.status).toBe(503);
    expect((await first.json()).error).toBe("lighter_uda_builder_key_unconfigured");
    expect(udaCalls(fetchSpy)).toHaveLength(0);

    process.env.GHOLA_LIGHTER_BUILDER_KEY = BUILDER_KEY;
    const second = await POST((await signedRequest()).request);
    expect(second.status).toBe(200);
    expect(udaCalls(fetchSpy)).toHaveLength(1);
  });

  it("blocks wallet rotation for the same authenticated Ghola owner", async () => {
    const fetchSpy = mockProfileAndUda();
    expect((await POST((await signedRequest()).request)).status).toBe(200);

    const issued = authorizationFor(OTHER_ACCOUNT.address, "cd".repeat(32));
    const response = await POST(destinationRequest({
      version: 1,
      challenge_token: issued.challenge_token,
      signature: await OTHER_ACCOUNT.signMessage({ message: issued.message }),
    }));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("lighter_uda_attempt_binding_mismatch");
    expect(udaCalls(fetchSpy)).toHaveLength(1);
  });

  it("blocks the same signed wallet under another Ghola session without leaking its destination", async () => {
    let profileUser = "user-1";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/user/profile")) return profileResponse(profileUser);
      if (url === "https://bridge.lighter.xyz/v1/uda") return udaResponse();
      throw new Error("unexpected request");
    });
    expect((await POST((await signedRequest()).request)).status).toBe(200);

    profileUser = "user-2";
    const issued = authorizationFor(ACCOUNT.address, "ef".repeat(32), Date.now(), "user-2");
    const response = await POST(destinationRequest({
      version: 1,
      challenge_token: issued.challenge_token,
      signature: await ACCOUNT.signMessage({ message: issued.message }),
    }));
    expect(response.status).toBe(409);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({
      error: "lighter_uda_attempt_binding_mismatch",
      retry_forbidden: true,
      deposit_destination_verified: false,
      funding_action_enabled: false,
    });
    expect(text).not.toContain(DEPOSIT);
    expect(udaCalls(fetchSpy)).toHaveLength(1);
  });
});

function authorization(nowMs = Date.now()) {
  return authorizationFor(ACCOUNT.address, "ab".repeat(32), nowMs);
}

function authorizationFor(
  ownerAddress: string,
  nonceHex: string,
  nowMs = Date.now(),
  sessionUserId = "user-1",
) {
  return issueLighterDepositAuthorization({
    ownerAddress,
    ownerCommitment: gholaCommitment("owner", sessionUserId),
    secret: SECRET,
    nowMs,
    nonceHex,
  });
}

async function signedBody() {
  const issued = authorization();
  return {
    version: 1,
    challenge_token: issued.challenge_token,
    signature: await ACCOUNT.signMessage({ message: issued.message }),
  };
}

async function signedRequest() {
  const body = await signedBody();
  return {
    request: destinationRequest(body),
    challengeToken: body.challenge_token,
    signature: body.signature,
  };
}

function destinationRequest(body: Record<string, unknown>, overrides: {
  origin?: string;
  contentType?: string;
  cookie?: string;
} = {}) {
  const headers = new Headers({
    origin: overrides.origin ?? "https://ghola.example",
    "content-type": overrides.contentType ?? "application/json",
  });
  const cookie = overrides.cookie === undefined ? "ghola_thumper_session=session-token" : overrides.cookie;
  if (cookie) headers.set("cookie", cookie);
  return new NextRequest("https://ghola.example/api/carry/lighter-deposit-destination", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function mockProfileAndUda(userId = "user-1", overrides: Record<string, unknown> = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/api/user/profile")) return profileResponse(userId);
    if (url === "https://bridge.lighter.xyz/v1/uda") return udaResponse(overrides);
    throw new Error("unexpected request");
  });
}

function profileResponse(userId: string) {
  return Response.json({ id: userId, email: "user@example.com", display_name: "User" });
}

function udaResponse(overrides: Record<string, unknown> = {}) {
  const resolvedOverrides = overrides.resolved && typeof overrides.resolved === "object"
    ? overrides.resolved as Record<string, unknown>
    : {};
  const rootOverrides = { ...overrides };
  delete rootOverrides.resolved;
  return Response.json({
    depositAddr: DEPOSIT,
    blocked: false,
    ...rootOverrides,
    resolved: {
      toChainId: "3586256",
      toTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      actionType: "LIGHTER_PERPS",
      recipientAddr: ACCOUNT.address,
      userId: ACCOUNT.address,
      ...resolvedOverrides,
    },
  });
}

function udaCalls(fetchSpy: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } }) {
  return fetchSpy.mock.calls.filter(([input]) => String(input) === "https://bridge.lighter.xyz/v1/uda");
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
