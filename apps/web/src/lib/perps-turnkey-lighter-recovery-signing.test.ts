import { beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";

const mocks = vi.hoisted(() => ({ createAccountWithAddress: vi.fn() }));
vi.mock("@turnkey/viem", () => ({ createAccountWithAddress: mocks.createAccountWithAddress }));

import { lighterOwnerRecoveryReadinessMessage } from "./lighter-owner-recovery";
import { TURNKEY_PERPS_OWNER_PATH } from "./perps-turnkey-aster-signing";
import { signLighterRecoveryReadinessWithTurnkey } from "./perps-turnkey-lighter-recovery-signing";

const OWNER = privateKeyToAccount(`0x${"42".repeat(32)}`);
const WRONG = privateKeyToAccount(`0x${"43".repeat(32)}`);
const CLIENT = {} as never;
const payload = {
  version: 1 as const,
  audience: "ghola_lighter_owner_recovery_readiness" as const,
  owner_commitment: `owner_${"1".repeat(48)}`,
  owner_address: OWNER.address.toLowerCase() as `0x${string}`,
  account_index: 123,
  plan_commitment: `0x${"ab".repeat(32)}` as `0x${string}`,
  nonce: "cd".repeat(32),
  issued_at_ms: 1_788_000_000_000,
  expires_at_ms: 1_788_000_120_000,
};

describe("Turnkey Lighter recovery readiness", () => {
  beforeEach(() => mocks.createAccountWithAddress.mockReset());

  it("proves exact owner message signing without signing a transaction", async () => {
    const signTransaction = vi.fn();
    mocks.createAccountWithAddress.mockReturnValue({
      signMessage: ({ message }: { message: string }) => OWNER.signMessage({ message }),
      signTransaction,
    });
    const message = lighterOwnerRecoveryReadinessMessage(payload);
    const result = await signLighterRecoveryReadinessWithTurnkey({
      client: CLIENT,
      organizationId: "session-org",
      owner: { address: OWNER.address, path: TURNKEY_PERPS_OWNER_PATH, organizationId: "resource-org" },
      authorization: { message, payload },
    });
    expect(result).toMatchObject({
      owner_address: OWNER.address.toLowerCase(),
      signing_method: "turnkey_eip191_owner_proof",
      transaction_signed: false,
      transaction_broadcast: false,
    });
    expect(signTransaction).not.toHaveBeenCalled();
  });

  it("rejects altered messages, owner paths, and wrong signers", async () => {
    await expect(signLighterRecoveryReadinessWithTurnkey({
      client: CLIENT,
      organizationId: "org",
      owner: { address: OWNER.address, path: "m/44'/60'/0'/0/1" },
      authorization: { message: lighterOwnerRecoveryReadinessMessage(payload), payload },
    })).rejects.toThrow("requires the Ghola perps owner account");
    expect(mocks.createAccountWithAddress).not.toHaveBeenCalled();

    await expect(signLighterRecoveryReadinessWithTurnkey({
      client: CLIENT,
      organizationId: "org",
      owner: { address: OWNER.address, path: TURNKEY_PERPS_OWNER_PATH },
      authorization: { message: `${lighterOwnerRecoveryReadinessMessage(payload)}\nBroadcast: yes`, payload },
    })).rejects.toThrow("challenge is invalid");
    expect(mocks.createAccountWithAddress).not.toHaveBeenCalled();

    mocks.createAccountWithAddress.mockReturnValue({
      signMessage: ({ message }: { message: string }) => WRONG.signMessage({ message }),
    });
    await expect(signLighterRecoveryReadinessWithTurnkey({
      client: CLIENT,
      organizationId: "org",
      owner: { address: OWNER.address, path: TURNKEY_PERPS_OWNER_PATH },
      authorization: { message: lighterOwnerRecoveryReadinessMessage(payload), payload },
    })).rejects.toThrow("wrong wallet");
  });
});
