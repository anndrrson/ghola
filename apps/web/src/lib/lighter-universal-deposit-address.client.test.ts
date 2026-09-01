import { describe, expect, it, vi } from "vitest";
import {
  fetchVerifiedLighterDepositDestination,
  isLighterDepositRetryForbidden,
  validateVerifiedLighterDepositDestination,
} from "./lighter-universal-deposit-address.client";

const NOW = Date.parse("2026-08-31T14:00:00.000Z");
const OWNER = "0x1111111111111111111111111111111111111111";
const DEPOSIT = "0x2222222222222222222222222222222222222222";

describe("verified Lighter deposit destination client", () => {
  it("accepts only a fresh owner-bound Base USDC destination", () => {
    expect(validateVerifiedLighterDepositDestination(validDestination(), OWNER, NOW))
      .toMatchObject({
        owner_address: OWNER,
        source: { chain_id: 8453, chain: "base", asset: "USDC", minimum_microunits: "5000000" },
        destination: {
          deposit_address: DEPOSIT,
          blocked: false,
          resolved: { action_type: "LIGHTER_PERPS", to_chain_id: "3586256", user_id: OWNER },
        },
        deposit_destination_verified: true,
        funding_action_enabled: true,
      });
  });

  it.each([
    ["owner", { owner_address: "0x3333333333333333333333333333333333333333" }],
    ["source chain", { source: { ...validDestination().source, chain_id: 1 } }],
    ["source token", { source: { ...validDestination().source, token_address: OWNER } }],
    ["minimum", { source: { ...validDestination().source, minimum_microunits: "3000000" } }],
    ["recommended minimum", { source: { ...validDestination().source, recommended_microunits: "5000000" } }],
    ["deposit owner collision", { destination: { ...validDestination().destination, deposit_address: OWNER } }],
    ["provider", { destination: { ...validDestination().destination, provider: "unknown" } }],
    ["blocked", { destination: { ...validDestination().destination, blocked: true } }],
    ["action", { destination: { ...validDestination().destination, resolved: { ...validDestination().destination.resolved, action_type: "OTHER" } } }],
    ["destination chain", { destination: { ...validDestination().destination, resolved: { ...validDestination().destination.resolved, to_chain_id: "1" } } }],
    ["destination token", { destination: { ...validDestination().destination, resolved: { ...validDestination().destination.resolved, to_token_address: OWNER } } }],
    ["recipient", { destination: { ...validDestination().destination, resolved: { ...validDestination().destination.resolved, recipient_address: DEPOSIT } } }],
    ["user binding", { destination: { ...validDestination().destination, resolved: { ...validDestination().destination.resolved, user_id: DEPOSIT } } }],
    ["verification flag", { deposit_destination_verified: false }],
    ["funding flag", { funding_action_enabled: false }],
    ["safety", { safety: { ...validDestination().safety, transfer_performed: true } }],
    ["stale", { checked_at: new Date(NOW - 60_001).toISOString() }],
  ])("rejects a mismatched %s", (_label, mutation) => {
    expect(() => validateVerifiedLighterDepositDestination({ ...validDestination(), ...mutation }, OWNER, NOW))
      .toThrow("invalid or stale");
  });

  it("signs a short-lived challenge with the exact owner before requesting a destination", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(validChallenge()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(validDestination()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    const signature = `0x${"11".repeat(65)}` as `0x${string}`;
    const signLighterDepositAuthorization = vi.fn(async () => signature);
    await expect(fetchVerifiedLighterDepositDestination({
      ownerAddress: OWNER,
      signLighterDepositAuthorization,
    }, fetchImpl, NOW)).resolves.toMatchObject({ owner_address: OWNER });
    expect(fetchImpl).toHaveBeenNthCalledWith(1, "/api/carry/lighter-deposit-authorization", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify({
        version: 1,
        owner_address: OWNER,
      }),
    }));
    expect(signLighterDepositAuthorization).toHaveBeenCalledWith(validChallenge().message, OWNER);
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "/api/carry/lighter-deposit-destination", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        version: 1,
        challenge_token: validChallenge().challenge_token,
        signature,
      }),
    }));
  });

  it("fails closed when the authenticated endpoint is unavailable", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "lighter_uda_builder_key_unconfigured" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    }));
    await expect(fetchVerifiedLighterDepositDestination({
      ownerAddress: OWNER,
      signLighterDepositAuthorization: async () => `0x${"11".repeat(65)}` as `0x${string}`,
    }, fetchImpl, NOW)).rejects.toThrow("lighter_uda_builder_key_unconfigured");
  });

  it("preserves a provider ambiguity as retry-forbidden", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(validChallenge()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: "lighter_uda_create_ambiguous",
        ambiguity: true,
        retry_forbidden: true,
        funding_action_enabled: false,
      }), {
        status: 502,
        headers: { "content-type": "application/json" },
      }));
    let caught: unknown;
    try {
      await fetchVerifiedLighterDepositDestination({
        ownerAddress: OWNER,
        signLighterDepositAuthorization: async () => `0x${"11".repeat(65)}` as `0x${string}`,
      }, fetchImpl, NOW);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(isLighterDepositRetryForbidden(caught)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["transport loss", () => Promise.reject(new TypeError("connection lost"))],
    ["malformed success", () => Promise.resolve(new Response("truncated", { status: 200 }))],
    ["unrecognized failure", () => Promise.resolve(new Response(JSON.stringify({ error: "unknown_failure" }), {
      status: 502,
      headers: { "content-type": "application/json" },
    }))],
  ])("locks another generation after destination %s", async (_label, destinationResult) => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(validChallenge()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockImplementationOnce(destinationResult);
    let caught: unknown;
    try {
      await fetchVerifiedLighterDepositDestination({
        ownerAddress: OWNER,
        signLighterDepositAuthorization: async () => `0x${"11".repeat(65)}` as `0x${string}`,
      }, fetchImpl, NOW);
    } catch (error) {
      caught = error;
    }
    expect(isLighterDepositRetryForbidden(caught)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("allows retry after an explicit server-side pre-dispatch rejection", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(validChallenge()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: "lighter_uda_builder_key_unconfigured",
        retry_forbidden: false,
      }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }));
    let caught: unknown;
    try {
      await fetchVerifiedLighterDepositDestination({
        ownerAddress: OWNER,
        signLighterDepositAuthorization: async () => `0x${"11".repeat(65)}` as `0x${string}`,
      }, fetchImpl, NOW);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(isLighterDepositRetryForbidden(caught)).toBe(false);
  });

  it("uses fresh validation time after a slow owner signature", async () => {
    let clock = NOW;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(validChallenge()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockImplementationOnce(async () => new Response(JSON.stringify({
        ...validDestination(),
        checked_at: new Date(clock).toISOString(),
      }), { status: 200, headers: { "content-type": "application/json" } }));
    try {
      await expect(fetchVerifiedLighterDepositDestination({
        ownerAddress: OWNER,
        signLighterDepositAuthorization: async () => {
          clock += 10_000;
          return `0x${"11".repeat(65)}` as `0x${string}`;
        },
      }, fetchImpl)).resolves.toMatchObject({ checked_at: new Date(NOW + 10_000).toISOString() });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("does not sign a challenge that omits the expected owner", async () => {
    const signLighterDepositAuthorization = vi.fn(async () => `0x${"11".repeat(65)}` as `0x${string}`);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      ...validChallenge(),
      message: "Authorize a different Lighter owner address",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(fetchVerifiedLighterDepositDestination({ ownerAddress: OWNER, signLighterDepositAuthorization }, fetchImpl, NOW))
      .rejects.toThrow("authorization message is invalid");
    expect(signLighterDepositAuthorization).not.toHaveBeenCalled();
  });

  it.each([
    ["source chain", "Source chain: Base (8453)", "Source chain: Ethereum (1)"],
    ["asset", "Source asset: USDC", "Source asset: USDT"],
    ["market", "Destination: Lighter perps", "Destination: Lighter spot"],
    ["scope", "This authorizes address generation only.", "This authorizes funding."],
    ["trade prohibition", "It does not authorize a transfer, withdrawal, or trade.", "It authorizes a transfer."],
  ])("does not sign a challenge with a changed %s disclosure", async (_label, expected, replacement) => {
    const signLighterDepositAuthorization = vi.fn(async () => `0x${"11".repeat(65)}` as `0x${string}`);
    const challenge = validChallenge();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      ...challenge,
      message: challenge.message.replace(expected, replacement),
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(fetchVerifiedLighterDepositDestination({ ownerAddress: OWNER, signLighterDepositAuthorization }, fetchImpl, NOW))
      .rejects.toThrow("authorization message is invalid");
    expect(signLighterDepositAuthorization).not.toHaveBeenCalled();
  });
});

function validChallenge() {
  const issuedAt = new Date(NOW).toISOString();
  const expiresAt = new Date(NOW + 2 * 60_000).toISOString();
  return {
    version: 1,
    challenge_token: `${"a".repeat(80)}.${"b".repeat(43)}`,
    message: [
      "Ghola Lighter deposit address authorization",
      "Version: 1",
      "Action: create_lighter_uda",
      `Ghola owner: owner_${"ab".repeat(24)}`,
      `Owner wallet: ${OWNER}`,
      "Network: mainnet",
      "Source chain: Base (8453)",
      "Source asset: USDC",
      "Destination: Lighter perps",
      `Nonce: ${"cd".repeat(32)}`,
      `Issued at: ${issuedAt}`,
      `Expires at: ${expiresAt}`,
      "This authorizes address generation only.",
      "It does not authorize a transfer, withdrawal, or trade.",
    ].join("\n"),
    owner_address: OWNER,
    expires_at: expiresAt,
    authorization: {
      action: "create_lighter_uda",
      source_chain_id: 8453,
      source_chain: "base",
      source_asset: "USDC",
      destination_market: "perps",
      transfer_authorized: false,
      withdrawal_authorized: false,
      trade_authorized: false,
    },
  };
}

function validDestination() {
  return {
    version: 1,
    venue_id: "lighter",
    network: "mainnet",
    owner_address: OWNER,
    source: {
      chain_id: 8453,
      chain: "base",
      asset: "USDC",
      token_address: "0x833589fcd6edb6e08f4c7c32d4f71b54bdA02913",
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
        recipient_address: OWNER,
        user_id: OWNER,
      },
    },
    deposit_destination_verified: true,
    funding_action_enabled: true,
    checked_at: new Date(NOW).toISOString(),
    safety: {
      address_generation_only: true,
      transfer_performed: false,
      withdrawal_performed: false,
      trade_performed: false,
      bounded_replay: "returns_only_the_original_owner_bound_destination",
    },
  };
}
