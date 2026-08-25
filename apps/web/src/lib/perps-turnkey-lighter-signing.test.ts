import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseTransaction } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const mocks = vi.hoisted(() => ({ createAccountWithAddress: vi.fn() }));

vi.mock("@turnkey/viem", () => ({
  createAccountWithAddress: mocks.createAccountWithAddress,
}));

import {
  LIGHTER_MAINNET_PROXY_ADDRESS,
  buildLighterChangePubKeyIntent,
  type LighterChangePubKeyTransactionPlan,
} from "./lighter-agent-association";
import { TURNKEY_PERPS_OWNER_PATH } from "./perps-turnkey-aster-signing";
import { signLighterChangePubKeyWithTurnkey } from "./perps-turnkey-lighter-signing";

const OWNER = privateKeyToAccount(`0x${"42".repeat(32)}`);
const WRONG = privateKeyToAccount(`0x${"43".repeat(32)}`);
const CLIENT = {} as never;
const PUBLIC_KEY = "22".repeat(40);

function plan(): LighterChangePubKeyTransactionPlan {
  return {
    ...buildLighterChangePubKeyIntent({
      ownerAddress: OWNER.address,
      accountIndex: 123,
      apiKeyIndex: 4,
      publicKey: PUBLIC_KEY,
    }),
    nonce: "0x7",
    gas: "0x3a980",
    max_fee_per_gas: "0xdf8475800",
    max_priority_fee_per_gas: "0x3b9aca00",
    simulation: {
      performed: true,
      succeeded: true,
      chain_id_verified: true,
      exact_sender_verified: true,
      exact_contract_verified: true,
    },
  };
}

describe("Turnkey Lighter owner association", () => {
  beforeEach(() => mocks.createAccountWithAddress.mockReset());

  it("signs only the exact simulated zero-value mainnet transaction", async () => {
    let forwarded: unknown;
    mocks.createAccountWithAddress.mockImplementation(() => ({
      signTransaction: async (transaction: Parameters<typeof OWNER.signTransaction>[0]) => {
        forwarded = transaction;
        return OWNER.signTransaction(transaction);
      },
    }));
    const result = await signLighterChangePubKeyWithTurnkey({
      client: CLIENT,
      organizationId: "turnkey-org-owner",
      owner: { address: OWNER.address, path: TURNKEY_PERPS_OWNER_PATH },
      transactionPlan: plan(),
    });
    expect(mocks.createAccountWithAddress).toHaveBeenCalledWith({
      client: CLIENT,
      organizationId: "turnkey-org-owner",
      signWith: OWNER.address.toLowerCase(),
      ethereumAddress: OWNER.address.toLowerCase(),
    });
    expect(forwarded).toMatchObject({
      type: "eip1559",
      chainId: 1,
      nonce: 7,
      gas: BigInt(240_000),
      to: LIGHTER_MAINNET_PROXY_ADDRESS,
      value: BigInt(0),
    });
    expect(result.raw_transaction).toMatch(/^0x02[0-9a-f]+$/);
    expect(result.transaction_hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect((parseTransaction(result.raw_transaction).data ?? "0x").slice(0, 10)).toBe("0x17010c68");
  });

  it("rejects altered plans before asking Turnkey to sign", async () => {
    const altered = { ...plan(), to: OWNER.address } as LighterChangePubKeyTransactionPlan;
    await expect(signLighterChangePubKeyWithTurnkey({
      client: CLIENT,
      organizationId: "turnkey-org-owner",
      owner: { address: OWNER.address, path: TURNKEY_PERPS_OWNER_PATH },
      transactionPlan: altered,
    })).rejects.toThrow("not approved");
    expect(mocks.createAccountWithAddress).not.toHaveBeenCalled();

    const excessiveFee = {
      ...plan(),
      max_fee_per_gas: "0x746a528801",
    } as LighterChangePubKeyTransactionPlan;
    await expect(signLighterChangePubKeyWithTurnkey({
      client: CLIENT,
      organizationId: "turnkey-org-owner",
      owner: { address: OWNER.address, path: TURNKEY_PERPS_OWNER_PATH },
      transactionPlan: excessiveFee,
    })).rejects.toThrow("fee bounds are invalid");
    expect(mocks.createAccountWithAddress).not.toHaveBeenCalled();
  });

  it("rejects a transaction signed by any wallet other than the exact owner", async () => {
    mocks.createAccountWithAddress.mockImplementation(() => ({
      signTransaction: (transaction: Parameters<typeof WRONG.signTransaction>[0]) => WRONG.signTransaction(transaction),
    }));
    await expect(signLighterChangePubKeyWithTurnkey({
      client: CLIENT,
      organizationId: "turnkey-org-owner",
      owner: { address: OWNER.address, path: TURNKEY_PERPS_OWNER_PATH },
      transactionPlan: plan(),
    })).rejects.toThrow("signed by the wrong wallet");
  });

  it("rejects wrong owner paths and malformed Turnkey transactions", async () => {
    await expect(signLighterChangePubKeyWithTurnkey({
      client: CLIENT,
      organizationId: "turnkey-org-owner",
      owner: { address: OWNER.address, path: "m/44'/60'/0'/0/1" },
      transactionPlan: plan(),
    })).rejects.toThrow("requires the Ghola perps owner account");
    mocks.createAccountWithAddress.mockImplementation(() => ({ signTransaction: async () => "0xdeadbeef" }));
    await expect(signLighterChangePubKeyWithTurnkey({
      client: CLIENT,
      organizationId: "turnkey-org-owner",
      owner: { address: OWNER.address, path: TURNKEY_PERPS_OWNER_PATH },
      transactionPlan: plan(),
    })).rejects.toThrow("invalid Lighter transaction");
  });
});
