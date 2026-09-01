import { describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";

vi.mock("server-only", () => ({}));

import { resolveLighterTurnkeyPerpsOwnerBinding } from "./lighter-turnkey-owner-binding.server";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const ENV = {
  NEXT_PUBLIC_TURNKEY_PERPS_ORGANIZATION_ID: "parent-org",
};

describe("server-side Lighter Turnkey owner binding", () => {
  it("resolves one exact non-exported Ghola perps owner account", async () => {
    const client = clientFor([account()]);
    await expect(resolveLighterTurnkeyPerpsOwnerBinding({
      sessionEmail: "User@Example.com",
      ownerAddress: OWNER,
      env: ENV,
      client: client as never,
    })).resolves.toEqual({
      organization_id: "sub-org",
      wallet_id: "wallet-perps",
      wallet_account_id: "account-owner",
      path: "m/44'/60'/0'/0/0",
      owner_address: OWNER.toLowerCase(),
    });
    expect(client.getSubOrgIds).toHaveBeenCalledWith({
      organizationId: "parent-org",
      filterType: "EMAIL",
      filterValue: "user@example.com",
    });
  });

  it("rejects an otherwise valid EOA at the wrong Turnkey path", async () => {
    const client = clientFor([account({ path: "m/44'/60'/0'/0/1" })]);
    await expect(resolveLighterTurnkeyPerpsOwnerBinding({
      sessionEmail: "user@example.com",
      ownerAddress: OWNER,
      env: ENV,
      client: client as never,
    })).rejects.toMatchObject({ code: "lighter_turnkey_owner_binding_mismatch", status: 403 });
  });

  it("rejects ambiguous perps owner accounts instead of choosing one", async () => {
    const client = clientFor([
      account(),
      account({ walletAccountId: "account-owner-2" }),
    ]);
    await expect(resolveLighterTurnkeyPerpsOwnerBinding({
      sessionEmail: "user@example.com",
      ownerAddress: OWNER,
      env: ENV,
      client: client as never,
    })).rejects.toMatchObject({ code: "lighter_turnkey_owner_binding_ambiguous", status: 409 });
  });

  it("fails closed when query credentials target a different parent organization", async () => {
    const client = clientFor([account()]);
    await expect(resolveLighterTurnkeyPerpsOwnerBinding({
      sessionEmail: "user@example.com",
      ownerAddress: OWNER,
      env: { ...ENV, GHOLA_TURNKEY_QUERY_ORGANIZATION_ID: "other-parent" },
      client: client as never,
    })).rejects.toMatchObject({ code: "lighter_turnkey_owner_binding_unconfigured", status: 503 });
    expect(client.getSubOrgIds).not.toHaveBeenCalled();
  });

  it("does not fall back to generic create/sign credentials", async () => {
    await expect(resolveLighterTurnkeyPerpsOwnerBinding({
      sessionEmail: "user@example.com",
      ownerAddress: OWNER,
      env: {
        ...ENV,
        TURNKEY_ORG_ID: "parent-org",
        TURNKEY_API_PUBLIC_KEY: "generic-public-key",
        TURNKEY_API_PRIVATE_KEY: "generic-private-key",
      },
    })).rejects.toMatchObject({ code: "lighter_turnkey_owner_binding_unconfigured", status: 503 });
  });
});

function clientFor(accounts: Array<ReturnType<typeof account>>) {
  return {
    getSubOrgIds: vi.fn(async () => ({ organizationIds: ["sub-org"] })),
    getWallets: vi.fn(async () => ({ wallets: [{
      walletId: "wallet-perps",
      walletName: "Ghola Perps",
      exported: false,
      imported: false,
    }] })),
    getWalletAccounts: vi.fn(async () => ({ accounts })),
  };
}

function account(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: "sub-org",
    walletId: "wallet-perps",
    walletAccountId: "account-owner",
    curve: "CURVE_SECP256K1",
    pathFormat: "PATH_FORMAT_BIP32",
    path: "m/44'/60'/0'/0/0",
    addressFormat: "ADDRESS_FORMAT_ETHEREUM",
    address: OWNER,
    ...overrides,
  };
}
