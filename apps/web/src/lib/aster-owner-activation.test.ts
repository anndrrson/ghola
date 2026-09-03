import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  ASTER_OWNER_ACTIVATION_SCHEMA,
  asterOwnerActivationNonce,
  buildAsterOwnerActivationChallenge,
  validateAsterOwnerActivationLogin,
  verifyAsterOwnerActivationSignature,
} from "./aster-owner-activation";

const OWNER = privateKeyToAccount(`0x${"42".repeat(32)}`);
const WRONG = privateKeyToAccount(`0x${"43".repeat(32)}`);

describe("Aster owner activation", () => {
  it("builds the exact pinned no-funds Aster login challenge", () => {
    const challenge = buildAsterOwnerActivationChallenge({
      ownerAddress: OWNER.address,
      nonce: "501182",
    });
    expect(challenge).toEqual({
      version: 1,
      venue: "aster",
      ownerAddress: OWNER.address.toLowerCase(),
      nonce: "501182",
      message: "You are signing into Astherus 501182",
      chainId: 56,
      setup: {
        mayDeposit: false,
        mayTrade: false,
        mayTransfer: false,
        mayWithdraw: false,
      },
    });
    expect(ASTER_OWNER_ACTIVATION_SCHEMA.nonceType).toBe("LOGIN");
    expect(ASTER_OWNER_ACTIVATION_SCHEMA.clientType).toBe("web");
  });

  it("accepts only the exact owner personal-signature", async () => {
    const challenge = buildAsterOwnerActivationChallenge({
      ownerAddress: OWNER.address,
      nonce: "501182",
    });
    const signature = await OWNER.signMessage({ message: challenge.message });
    await expect(verifyAsterOwnerActivationSignature({ challenge, signature }))
      .resolves.toBe(signature);

    await expect(verifyAsterOwnerActivationSignature({
      challenge,
      signature: await WRONG.signMessage({ message: challenge.message }),
    })).rejects.toMatchObject({ code: "aster_owner_activation_wrong_wallet" });
  });

  it("rejects challenge tampering before accepting a valid signature", async () => {
    const challenge = buildAsterOwnerActivationChallenge({
      ownerAddress: OWNER.address,
      nonce: "501182",
    });
    const signature = await OWNER.signMessage({ message: challenge.message });
    await expect(verifyAsterOwnerActivationSignature({
      challenge: { ...challenge, message: `${challenge.message}0` },
      signature,
    })).rejects.toMatchObject({ code: "aster_owner_activation_challenge_invalid" });
  });

  it("strictly validates Aster nonce and login envelopes", () => {
    expect(asterOwnerActivationNonce({
      code: "000000",
      success: true,
      data: { nonce: "501182" },
    })).toBe("501182");
    expect(() => asterOwnerActivationNonce({
      code: "000001",
      success: false,
      data: { nonce: "501182" },
    })).toThrow("rejected");

    expect(validateAsterOwnerActivationLogin({
      code: "000000",
      success: true,
      data: { token: "session-token", uid: 12345678 },
    })).toEqual({ providerUid: "12345678" });
    expect(() => validateAsterOwnerActivationLogin({
      code: "000000",
      success: true,
      data: { uid: 12345678 },
    })).toThrow("valid owner activation receipt");
  });
});
