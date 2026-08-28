import { describe, expect, it, vi } from "vitest";

import { sessionOwnsTurnkeyWallet } from "./_ownership";

function client({
  organizationIds = ["sub-alice"],
  walletAddress = "wallet-alice",
}: {
  organizationIds?: string[];
  walletAddress?: string;
} = {}) {
  return {
    getSubOrgIds: vi.fn(async () => ({ organizationIds })),
    getWallets: vi.fn(async () => ({ wallets: [{ walletId: "wallet-1" }] })),
    getWalletAccounts: vi.fn(async () => ({
      accounts: [{ address: walletAddress }],
    })),
  };
}

describe("Turnkey session ownership", () => {
  it("accepts only the session email's exact sub-organization and wallet", async () => {
    const api = client();
    await expect(sessionOwnsTurnkeyWallet({
      client: api as never,
      parentOrganizationId: "parent",
      sessionEmail: " Alice@Example.com ",
      subOrganizationId: "sub-alice",
      walletAddress: "wallet-alice",
    })).resolves.toBe(true);
    expect(api.getSubOrgIds).toHaveBeenCalledWith({
      organizationId: "parent",
      filterType: "EMAIL",
      filterValue: "alice@example.com",
    });
  });

  it("rejects a different user's sub-organization before enumerating wallets", async () => {
    const api = client({ organizationIds: ["sub-alice"] });
    await expect(sessionOwnsTurnkeyWallet({
      client: api as never,
      parentOrganizationId: "parent",
      sessionEmail: "alice@example.com",
      subOrganizationId: "sub-victim",
      walletAddress: "wallet-victim",
    })).resolves.toBe(false);
    expect(api.getWallets).not.toHaveBeenCalled();
  });

  it("rejects an address outside the session-owned sub-organization", async () => {
    const api = client({ walletAddress: "wallet-alice" });
    await expect(sessionOwnsTurnkeyWallet({
      client: api as never,
      parentOrganizationId: "parent",
      sessionEmail: "alice@example.com",
      subOrganizationId: "sub-alice",
      walletAddress: "wallet-victim",
    })).resolves.toBe(false);
  });

  it("fails closed when Turnkey cannot prove ownership", async () => {
    const api = client();
    api.getSubOrgIds.mockRejectedValueOnce(new Error("unavailable"));
    await expect(sessionOwnsTurnkeyWallet({
      client: api as never,
      parentOrganizationId: "parent",
      sessionEmail: "alice@example.com",
      subOrganizationId: "sub-alice",
      walletAddress: "wallet-alice",
    })).rejects.toThrow("unavailable");
  });
});
