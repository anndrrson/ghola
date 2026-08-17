import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getHyperliquidExecutionVaultStatus: vi.fn(),
  getHyperliquidLiveAccess: vi.fn(),
  fetchPrivateAgentRuntimeStatus: vi.fn(),
}));

vi.mock("@/lib/private-account-client", () => ({
  bindPrivateMobileWallet: vi.fn(),
  getPrivateMobileWalletBindingChallenge: vi.fn(),
  getHyperliquidExecutionVaultStatus: mocks.getHyperliquidExecutionVaultStatus,
  getHyperliquidLiveAccess: mocks.getHyperliquidLiveAccess,
  revokeHyperliquidExecutionVault: vi.fn(),
  sealHyperliquidExecutionVault: vi.fn(),
}));
vi.mock("@/lib/hyperliquid-vault-seal", () => ({
  buildHyperliquidExecutionVaultBundle: vi.fn(),
  fetchPrivateAgentRuntimeStatus: mocks.fetchPrivateAgentRuntimeStatus,
  parseHyperliquidCredentialImport: vi.fn(() => ({ fields: [] })),
  validateHyperliquidExecutionCredentialDraft: vi.fn(() => []),
}));
vi.mock("@/lib/browser-ed25519-wallet", () => ({
  createBrowserEd25519Wallet: vi.fn(),
  signBrowserEd25519Bytes: vi.fn(),
}));
vi.mock("@/lib/private-agent-runtime", () => ({
  chooseConfidentialComputeProvider: (providers: unknown[]) => providers[0] ?? null,
}));
vi.mock("@/lib/wallet-request-proof", () => ({
  connectSolanaWallet: vi.fn(),
  privateAccountMobileProofHeaders: vi.fn(),
  requiredSolanaProvider: vi.fn(),
  walletSignBytes: vi.fn(),
}));

import { ConnectHyperliquidButton } from "./ConnectHyperliquidButton";

describe("ConnectHyperliquidButton eligibility gate", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    mocks.getHyperliquidExecutionVaultStatus.mockResolvedValue({
      account_commitment: "account_test",
      hyperliquid_execution_vault: null,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("does not request a runtime or expose a key field before current consent", async () => {
    mocks.getHyperliquidLiveAccess.mockResolvedValue({ eligibility_ready: false });

    await act(async () => {
      root.render(createElement(ConnectHyperliquidButton, { ready: true }));
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Review eligibility and terms");
    });

    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(mocks.fetchPrivateAgentRuntimeStatus).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLAnchorElement>('a[href*="eligibility-consent"]')).not.toBeNull();
  });

  it("shows the sealed credential form only after consent and an attested recipient exist", async () => {
    mocks.getHyperliquidLiveAccess.mockResolvedValue({ eligibility_ready: true });
    mocks.fetchPrivateAgentRuntimeStatus.mockResolvedValue({
      providers: [{ id: "phala", available: true, attested: true }],
      preferred_provider: "phala",
    });

    await act(async () => {
      root.render(createElement(ConnectHyperliquidButton, { ready: true }));
    });
    await vi.waitFor(() => {
      expect(container.querySelector('input[type="password"]')).not.toBeNull();
    });

    expect(container.textContent).toContain("Seal & connect account");
  });
});
