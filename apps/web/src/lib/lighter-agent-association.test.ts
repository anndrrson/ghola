import { describe, expect, it } from "vitest";
import { decodeFunctionData } from "viem";
import {
  LIGHTER_CHANGE_PUB_KEY_ABI,
  LIGHTER_MAINNET_PROXY_ADDRESS,
  assertLighterApiSlotVacant,
  assertLighterOwnerAccount,
  buildLighterChangePubKeyIntent,
  lighterPublicKey,
  selectLighterApiKeyIndex,
  selectLighterOwnerAccount,
} from "./lighter-agent-association";

const OWNER = "0x3333333333333333333333333333333333333333";
const PUBLIC_KEY = "22".repeat(40);

describe("Lighter owner association", () => {
  it("builds only the exact mainnet zero-value ChangePubKey intent", () => {
    const intent = buildLighterChangePubKeyIntent({
      ownerAddress: OWNER,
      accountIndex: 123,
      apiKeyIndex: 4,
      publicKey: PUBLIC_KEY,
    });
    expect(intent).toMatchObject({
      chain_id: 1,
      from: OWNER,
      to: LIGHTER_MAINNET_PROXY_ADDRESS,
      value: "0x0",
      function: "changePubKey(uint48,uint8,bytes)",
      transaction_signed: false,
      transaction_broadcast: false,
      simulation_required_before_signing: true,
    });
    expect(intent.data.slice(0, 10)).toBe("0x17010c68");
    expect(decodeFunctionData({ abi: LIGHTER_CHANGE_PUB_KEY_ABI, data: intent.data })).toEqual({
      functionName: "changePubKey",
      args: [123, 4, `0x${PUBLIC_KEY}`],
    });
  });

  it("requires the target account to belong to the exact Turnkey owner", () => {
    expect(assertLighterOwnerAccount({
      ownerAddress: OWNER,
      accountIndex: 123,
      response: {
        code: 200,
        l1_address: OWNER,
        sub_accounts: [{ index: 123, l1_address: OWNER }],
      },
    })).toEqual({ owner_address: OWNER, account_index: 123 });
    expect(() => assertLighterOwnerAccount({
      ownerAddress: OWNER,
      accountIndex: 124,
      response: {
        code: 200,
        l1_address: OWNER,
        sub_accounts: [{ index: 123, l1_address: OWNER }],
      },
    })).toThrow("not owned");
    expect(selectLighterOwnerAccount({
      ownerAddress: OWNER,
      response: {
        code: 200,
        l1_address: OWNER,
        sub_accounts: [
          { index: 200, account_type: 1, l1_address: OWNER },
          { index: 123, account_type: 0, l1_address: OWNER },
        ],
      },
    })).toEqual({ account_index: 123, account_type: 0 });
  });

  it("requires a vacant Ghola-owned slot and rejects reserved or occupied indexes", () => {
    expect(assertLighterApiSlotVacant({
      accountIndex: 123,
      apiKeyIndex: 4,
      response: { code: 200, api_keys: [] },
    })).toEqual({ account_index: 123, api_key_index: 4 });
    expect(() => assertLighterApiSlotVacant({
      accountIndex: 123,
      apiKeyIndex: 4,
      response: { code: 200, api_keys: [{ account_index: 123, api_key_index: 4, public_key: PUBLIC_KEY }] },
    })).toThrow("already occupied");
    expect(() => buildLighterChangePubKeyIntent({
      ownerAddress: OWNER,
      accountIndex: 123,
      apiKeyIndex: 1,
      publicKey: PUBLIC_KEY,
    })).toThrow("2 through 254");
    expect(selectLighterApiKeyIndex({
      accountIndex: 123,
      response: {
        code: 200,
        api_keys: [
          { account_index: 123, api_key_index: 2, public_key: PUBLIC_KEY },
          { account_index: 123, api_key_index: 3, public_key: PUBLIC_KEY },
        ],
      },
    })).toBe(4);
  });

  it("rejects malformed, zero, and noncanonical Goldilocks public keys", () => {
    expect(() => lighterPublicKey("22".repeat(32))).toThrow("40-byte");
    expect(() => lighterPublicKey("00".repeat(40))).toThrow("nonzero");
    expect(() => lighterPublicKey("01" + "00".repeat(3) + "ff".repeat(4) + "00".repeat(32))).toThrow("not canonical");
  });
});
