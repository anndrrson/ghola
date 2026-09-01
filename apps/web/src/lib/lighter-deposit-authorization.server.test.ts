import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  issueLighterDepositAuthorization,
  LIGHTER_DEPOSIT_AUTHORIZATION_TTL_MS,
  verifyLighterDepositAuthorizationSignature,
  verifyLighterDepositAuthorizationToken,
} from "./lighter-deposit-authorization.server";

const SECRET = "secure-lighter-uda-authorization-secret-2026";
const OTHER_SECRET = "different-secure-lighter-uda-secret-2026";
const NOW = 1_787_990_400_000;
const NONCE = "ab".repeat(32);
const COMMITMENT = `owner_${"1".repeat(48)}`;
const OTHER_COMMITMENT = `owner_${"2".repeat(48)}`;
const ACCOUNT = privateKeyToAccount(`0x${"11".repeat(32)}`);
const OTHER_ACCOUNT = privateKeyToAccount(`0x${"22".repeat(32)}`);

vi.mock("server-only", () => ({}));

describe("Lighter deposit authorization", () => {
  it("issues a deterministic owner/session-bound two-minute challenge", () => {
    const authorization = issue();
    expect(authorization.payload).toMatchObject({
      version: 1,
      audience: "ghola_lighter_uda_create",
      owner_commitment: COMMITMENT,
      owner_address: ACCOUNT.address,
      nonce: NONCE,
      issued_at_ms: NOW,
      expires_at_ms: NOW + 120_000,
      source_chain_id: 8453,
      source_asset: "USDC",
      destination_market: "perps",
    });
    expect(authorization.message).toBe([
      "Ghola Lighter deposit address authorization",
      "Version: 1",
      "Action: create_lighter_uda",
      `Ghola owner: ${COMMITMENT}`,
      `Owner wallet: ${ACCOUNT.address}`,
      "Network: mainnet",
      "Source chain: Base (8453)",
      "Source asset: USDC",
      "Destination: Lighter perps",
      `Nonce: ${NONCE}`,
      `Issued at: ${new Date(NOW).toISOString()}`,
      `Expires at: ${new Date(NOW + LIGHTER_DEPOSIT_AUTHORIZATION_TTL_MS).toISOString()}`,
      "This authorizes address generation only.",
      "It does not authorize a transfer, withdrawal, or trade.",
    ].join("\n"));
    expect(authorization.challenge_token).not.toContain(SECRET);
    expect(authorization.message).not.toContain(SECRET);
  });

  it("verifies the exact EIP-191 owner signature", async () => {
    const issued = issue();
    const verified = verifyLighterDepositAuthorizationToken({
      challengeToken: issued.challenge_token,
      ownerCommitment: COMMITMENT,
      secret: SECRET,
      nowMs: NOW + 1,
    });
    const signature = await ACCOUNT.signMessage({ message: verified.message });
    await expect(verifyLighterDepositAuthorizationSignature({ authorization: verified, signature }))
      .resolves.toBe(ACCOUNT.address);
  });

  it("rejects a signature from a different owner", async () => {
    const issued = issue();
    const signature = await OTHER_ACCOUNT.signMessage({ message: issued.message });
    await expect(verifyLighterDepositAuthorizationSignature({ authorization: issued, signature }))
      .rejects.toMatchObject({ code: "lighter_uda_owner_signature_mismatch", status: 403 });
  });

  it.each(["", "0x1234", `0x${"g".repeat(130)}`])("rejects malformed signature %j", async (signature) => {
    await expect(verifyLighterDepositAuthorizationSignature({ authorization: issue(), signature }))
      .rejects.toMatchObject({ code: "lighter_uda_owner_signature_invalid", status: 403 });
  });

  it("rejects token tampering and a different HMAC secret", () => {
    const issued = issue();
    const [payload, mac] = issued.challenge_token.split(".");
    const tampered = `${payload.slice(0, -1)}${payload.endsWith("A") ? "B" : "A"}.${mac}`;
    expect(() => verify(tampered)).toThrowError(expect.objectContaining({
      code: "lighter_uda_authorization_invalid",
      status: 403,
    }));
    expect(() => verifyLighterDepositAuthorizationToken({
      challengeToken: issued.challenge_token,
      ownerCommitment: COMMITMENT,
      secret: OTHER_SECRET,
      nowMs: NOW + 1,
    })).toThrowError(expect.objectContaining({ code: "lighter_uda_authorization_invalid" }));
  });

  it("rejects a token replayed by a different signed-in session", () => {
    expect(() => verifyLighterDepositAuthorizationToken({
      challengeToken: issue().challenge_token,
      ownerCommitment: OTHER_COMMITMENT,
      secret: SECRET,
      nowMs: NOW + 1,
    })).toThrowError(expect.objectContaining({
      code: "lighter_uda_authorization_session_mismatch",
      status: 403,
    }));
  });

  it("rejects expiration and challenges issued too far in the future", () => {
    expect(() => verify(issue().challenge_token, NOW + LIGHTER_DEPOSIT_AUTHORIZATION_TTL_MS))
      .toThrowError(expect.objectContaining({ code: "lighter_uda_authorization_expired" }));
    expect(() => verify(issue().challenge_token, NOW - 5_001))
      .toThrowError(expect.objectContaining({ code: "lighter_uda_authorization_invalid" }));
  });

  it("rejects unknown signed fields and a modified TTL even with a valid HMAC", () => {
    const issued = issue();
    const payload = tokenPayload(issued.challenge_token);
    expect(() => verify(signPayload({ ...payload, extra: true })))
      .toThrowError(expect.objectContaining({ code: "lighter_uda_authorization_invalid" }));
    expect(() => verify(signPayload({ ...payload, expires_at_ms: NOW + 120_001 })))
      .toThrowError(expect.objectContaining({ code: "lighter_uda_authorization_invalid" }));
  });

  it.each([
    ["short secret", { secret: "too-short" }, "lighter_uda_authorization_unconfigured"],
    ["placeholder secret", { secret: "placeholder-secret-that-is-long-enough-123" }, "lighter_uda_authorization_unconfigured"],
    ["invalid owner", { ownerAddress: "0x123" }, "lighter_uda_owner_address_invalid"],
    ["invalid commitment", { ownerCommitment: "owner_bad" }, "lighter_uda_owner_commitment_invalid"],
    ["invalid nonce", { nonceHex: "abcd" }, "lighter_uda_authorization_nonce_invalid"],
    ["invalid time", { nowMs: 0 }, "lighter_uda_authorization_time_invalid"],
  ])("fails closed for %s", (_name, overrides, code) => {
    expect(() => issue(overrides)).toThrowError(expect.objectContaining({ code }));
  });
});

function issue(overrides: Partial<Parameters<typeof issueLighterDepositAuthorization>[0]> = {}) {
  return issueLighterDepositAuthorization({
    ownerAddress: ACCOUNT.address,
    ownerCommitment: COMMITMENT,
    secret: SECRET,
    nowMs: NOW,
    nonceHex: NONCE,
    ...overrides,
  });
}

function verify(token: string, nowMs = NOW + 1) {
  return verifyLighterDepositAuthorizationToken({
    challengeToken: token,
    ownerCommitment: COMMITMENT,
    secret: SECRET,
    nowMs,
  });
}

function tokenPayload(token: string) {
  return JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8")) as Record<string, unknown>;
}

function signPayload(payload: Record<string, unknown>) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", SECRET)
    .update(`ghola-lighter-uda-authorization-v1\n${encoded}`)
    .digest("base64url");
  return `${encoded}.${mac}`;
}
