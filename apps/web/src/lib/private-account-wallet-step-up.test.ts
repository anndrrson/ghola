import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bindPrivateMobileWallet: vi.fn(),
  connectSolanaWallet: vi.fn(),
  getPrivateMobileWalletBindingChallenge: vi.fn(),
  privateAccountMobileProofHeaders: vi.fn(),
  requiredSolanaProvider: vi.fn(),
  walletSignBytes: vi.fn(),
}));

vi.mock("./private-account-client", () => ({
  bindPrivateMobileWallet: mocks.bindPrivateMobileWallet,
  getPrivateMobileWalletBindingChallenge: mocks.getPrivateMobileWalletBindingChallenge,
}));

vi.mock("./wallet-request-proof", () => ({
  connectSolanaWallet: mocks.connectSolanaWallet,
  privateAccountMobileProofHeaders: mocks.privateAccountMobileProofHeaders,
  requiredSolanaProvider: mocks.requiredSolanaProvider,
  walletSignBytes: mocks.walletSignBytes,
}));

import { authorizePrivateAccountWalletRequest } from "./private-account-wallet-step-up";

describe("private-account wallet step-up", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("binds both signatures to the connected wallet", async () => {
    const provider = { signMessage: vi.fn() };
    const bindingBytes = new Uint8Array(64).fill(1);
    const requestBytes = new Uint8Array([2, 3, 4]);
    mocks.connectSolanaWallet.mockResolvedValue("wallet-a");
    mocks.requiredSolanaProvider.mockReturnValue(provider);
    mocks.getPrivateMobileWalletBindingChallenge.mockResolvedValue({ message: "bind wallet-a" });
    mocks.walletSignBytes.mockResolvedValue(bindingBytes);
    mocks.privateAccountMobileProofHeaders.mockImplementation(async (input) => {
      await input.signBytes(requestBytes);
      return { "x-proof": "signed" };
    });

    await expect(authorizePrivateAccountWalletRequest({
      path: "/v1/private-account/test",
      body: { confirmation: true },
    })).resolves.toEqual({ "x-proof": "signed" });

    expect(mocks.walletSignBytes).toHaveBeenNthCalledWith(
      1,
      provider,
      new TextEncoder().encode("bind wallet-a"),
      "wallet-a",
    );
    expect(mocks.walletSignBytes).toHaveBeenNthCalledWith(
      2,
      provider,
      requestBytes,
      "wallet-a",
    );
    expect(mocks.bindPrivateMobileWallet).toHaveBeenCalledWith(expect.objectContaining({
      wallet_pubkey: "wallet-a",
    }));
  });
});
