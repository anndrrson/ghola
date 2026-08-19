import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getVaultStatus: vi.fn(),
  getLiveAccess: vi.fn(),
  fetchRuntime: vi.fn(),
  prepareAuthorization: vi.fn(),
  prepareDisable: vi.fn(),
  submitAuthorization: vi.fn(),
  submitDisable: vi.fn(),
  removeLegacy: vi.fn(),
}));

vi.mock("@/lib/private-account-client", () => ({
  getHyperliquidExecutionVaultStatus: mocks.getVaultStatus,
  getHyperliquidLiveAccess: mocks.getLiveAccess,
  removeRevokedLegacyHyperliquidAgentVault: mocks.removeLegacy,
}));
vi.mock("@/lib/hyperliquid-vault-seal", () => ({
  fetchPrivateAgentRuntimeStatus: mocks.fetchRuntime,
}));
vi.mock("@/lib/private-agent-runtime", () => ({
  chooseConfidentialComputeProvider: (providers: unknown[]) => providers[0] ?? null,
}));
vi.mock("@/lib/hyperliquid-agent-wallet.client", () => ({
  preparePhantomHyperliquidAgentAuthorization: mocks.prepareAuthorization,
  preparePhantomHyperliquidAgentDisable: mocks.prepareDisable,
  submitPhantomHyperliquidAuthorization: mocks.submitAuthorization,
  submitPhantomHyperliquidDisable: mocks.submitDisable,
}));

import { ConnectHyperliquidButton } from "./ConnectHyperliquidButton";

const ACCOUNT_COMMITMENT = "account_test";
const NOW = 1_780_000_000_000;
const authorizationRequest = {
  version: 1 as const,
  action: {
    type: "approveAgent" as const,
    hyperliquidChain: "Mainnet" as const,
    signatureChainId: "0x66eee" as const,
    agentAddress: "0x2222222222222222222222222222222222222222" as const,
    agentName: `ghola-mainnet valid_until ${NOW + 24 * 60 * 60 * 1_000}`,
    nonce: NOW,
  },
  signature: {
    r: `0x${"11".repeat(32)}` as const,
    s: `0x${"22".repeat(32)}` as const,
    v: 27 as const,
  },
  nonce: NOW,
  encrypted_execution_vault: {
    alg: "sealed-provider-v1" as const,
    ciphertext: "sealed",
    recipient: "attested:test",
    aad: "committed-aad",
  },
};
const disableRequest = {
  version: 1 as const,
  action: authorizationRequest.action,
  signature: authorizationRequest.signature,
  nonce: NOW,
};

describe("ConnectHyperliquidButton", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    window.sessionStorage.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    mocks.getVaultStatus.mockResolvedValue({
      account_commitment: ACCOUNT_COMMITMENT,
      hyperliquid_execution_vault: null,
    });
    mocks.getLiveAccess.mockResolvedValue({ eligibility_ready: true });
    mocks.fetchRuntime.mockResolvedValue({
      providers: [{ id: "phala", available: true, attested: true }],
      preferred_provider: "phala",
    });
    mocks.prepareAuthorization.mockResolvedValue(authorizationRequest);
    mocks.prepareDisable.mockResolvedValue(disableRequest);
    mocks.submitAuthorization.mockResolvedValue({ ready: true });
    mocks.submitDisable.mockResolvedValue({ ready: false });
    mocks.removeLegacy.mockResolvedValue({ ready: false });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.sessionStorage.clear();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("keeps wallet setup hidden until current eligibility is accepted", async () => {
    mocks.getLiveAccess.mockResolvedValue({ eligibility_ready: false });
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("Review eligibility and terms"));
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(mocks.fetchRuntime).not.toHaveBeenCalled();
    expect(mocks.prepareAuthorization).not.toHaveBeenCalled();
  });

  it("shows one Phantom flow without a manual secret form", async () => {
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("Authorize with Phantom"));
    expect(container.querySelector("input")).toBeNull();
    expect(container.textContent).toContain("No seed phrase or private key is requested or shown");
    expect(container.textContent).not.toContain("Seal & connect account");
  });

  it("rechecks investor access before opening Phantom", async () => {
    const beforeWalletAction = vi.fn().mockResolvedValue(false);
    await render({ beforeWalletAction });
    await clickButton("Authorize with Phantom");
    expect(beforeWalletAction).toHaveBeenCalledOnce();
    expect(mocks.prepareAuthorization).not.toHaveBeenCalled();
    expect(mocks.submitAuthorization).not.toHaveBeenCalled();
  });

  it("single-flights rapid authorization clicks before the first access check resolves", async () => {
    let releaseAccess!: (allowed: boolean) => void;
    const beforeWalletAction = vi.fn(() => new Promise<boolean>((resolve) => {
      releaseAccess = resolve;
    }));
    await render({ beforeWalletAction });
    const button = await findButton("Authorize with Phantom");
    act(() => {
      button.click();
      button.click();
    });
    expect(beforeWalletAction).toHaveBeenCalledOnce();
    expect(mocks.prepareAuthorization).not.toHaveBeenCalled();

    await act(async () => releaseAccess(true));
    await vi.waitFor(() => expect(mocks.submitAuthorization).toHaveBeenCalledOnce());
    expect(mocks.prepareAuthorization).toHaveBeenCalledOnce();
  });

  it("retries the exact cached request across a pre-submit 429 without a second Phantom prompt", async () => {
    const rateLimited = Object.assign(new Error("wallet_setup_rate_limited"), {
      status: 429,
      body: { retry_safe: true },
    });
    mocks.submitAuthorization.mockRejectedValueOnce(rateLimited).mockResolvedValueOnce({ ready: true });
    await render();
    await clickButton("Authorize with Phantom");
    await vi.waitFor(() => expect(container.textContent).toContain("Retry exact venue check"));
    await clickButton("Retry exact venue check");
    await vi.waitFor(() => expect(mocks.submitAuthorization).toHaveBeenCalledTimes(2));
    expect(mocks.prepareAuthorization).toHaveBeenCalledOnce();
    expect(mocks.submitAuthorization.mock.calls[0]?.[0]).toEqual(authorizationRequest);
    expect(mocks.submitAuthorization.mock.calls[1]?.[0]).toEqual(authorizationRequest);
  });

  it("does not classify venue-unknown state as retry-safe", async () => {
    const unknown = Object.assign(new Error("hyperliquid_agent_authorization_state_unknown"), {
      status: 503,
      body: {},
    });
    mocks.submitAuthorization.mockRejectedValueOnce(unknown);
    await render();
    await clickButton("Authorize with Phantom");
    await vi.waitFor(() => expect(container.textContent).toContain("Try again"));
    expect(container.textContent).not.toContain("Retry exact venue check");
    expect(window.sessionStorage.getItem(
      `ghola-hyperliquid-agent-authorize-v1:${ACCOUNT_COMMITMENT}`,
    )).toBeNull();
  });

  it("never labels a legacy vault investor-ready and requires worker-verified removal", async () => {
    mocks.getVaultStatus.mockResolvedValue({
      account_commitment: ACCOUNT_COMMITMENT,
      ready: true,
      hyperliquid_execution_vault: {
        status: "sealed",
        network: "mainnet",
        authorization_source: "legacy_import",
        venue_revoke_supported: false,
      },
    });
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("not investor-ready"));
    expect(container.textContent).not.toContain("Disable Ghola trading");
    expect(container.textContent).not.toContain("Run real $11.00 proof trade");
    expect(container.textContent).toContain("Verify revocation and remove legacy wallet");
    expect(container.querySelector<HTMLAnchorElement>('a[href="https://app.hyperliquid.xyz/API"]')).not.toBeNull();
  });

  it("removes legacy local state only through the server verifier, then offers automatic setup", async () => {
    const onVaultStatusChange = vi.fn();
    mocks.getVaultStatus
      .mockResolvedValueOnce({
        account_commitment: ACCOUNT_COMMITMENT,
        ready: true,
        hyperliquid_execution_vault: {
          status: "sealed",
          network: "mainnet",
          authorization_source: "legacy_import",
          venue_revoke_supported: false,
        },
      })
      .mockResolvedValue({
        account_commitment: ACCOUNT_COMMITMENT,
        ready: false,
        hyperliquid_execution_vault: { status: "revoked", network: "mainnet" },
      });
    await render({ onVaultStatusChange });
    await clickButton("Verify revocation and remove legacy wallet");
    await vi.waitFor(() => expect(mocks.removeLegacy).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(container.textContent).toContain("Authorize with Phantom"));
    expect(onVaultStatusChange).toHaveBeenCalledOnce();
    expect(mocks.prepareAuthorization).not.toHaveBeenCalled();
  });

  it("keeps legacy state and directs venue revocation while authority remains", async () => {
    mocks.getVaultStatus.mockResolvedValue({
      account_commitment: ACCOUNT_COMMITMENT,
      ready: false,
      hyperliquid_execution_vault: {
        status: "sealed",
        network: "mainnet",
        authorization_source: "legacy_import",
        venue_revoke_supported: false,
      },
    });
    mocks.removeLegacy.mockRejectedValue(Object.assign(
      new Error("legacy_hyperliquid_agent_still_authorized"),
      { status: 409, body: {} },
    ));
    await render();
    await clickButton("Verify revocation and remove legacy wallet");
    await vi.waitFor(() => expect(container.textContent).toContain("still authorized"));
    expect(container.querySelector<HTMLAnchorElement>('a[href="https://app.hyperliquid.xyz/API"]')).not.toBeNull();
    expect(mocks.prepareAuthorization).not.toHaveBeenCalled();
    expect(mocks.submitAuthorization).not.toHaveBeenCalled();
  });

  it("uses same-name Phantom rotation for true automated disable", async () => {
    const onVaultStatusChange = vi.fn();
    mocks.getVaultStatus.mockResolvedValue({
      account_commitment: ACCOUNT_COMMITMENT,
      ready: true,
      hyperliquid_execution_vault: {
        status: "sealed",
        network: "mainnet",
        authorization_source: "phantom_approve_agent_v1",
        venue_revoke_supported: true,
        authorization_valid_until: new Date(NOW + 60 * 60_000).toISOString(),
      },
    });
    await render({ onVaultStatusChange });
    await clickButton("Disable Ghola trading");
    await vi.waitFor(() => expect(mocks.submitDisable).toHaveBeenCalledWith(disableRequest));
    await vi.waitFor(() => expect(onVaultStatusChange).toHaveBeenCalledOnce());
    expect(mocks.prepareDisable).toHaveBeenCalledWith({ accountCommitment: ACCOUNT_COMMITMENT });
  });

  it("keeps authority-reducing disable available after investor access expires", async () => {
    const beforeWalletAction = vi.fn().mockResolvedValue(false);
    mocks.getVaultStatus.mockResolvedValue({
      account_commitment: ACCOUNT_COMMITMENT,
      ready: true,
      hyperliquid_execution_vault: {
        status: "sealed",
        network: "mainnet",
        authorization_source: "phantom_approve_agent_v1",
        venue_revoke_supported: true,
        authorization_valid_until: new Date(NOW + 60 * 60_000).toISOString(),
      },
    });
    await render({ beforeWalletAction });
    await clickButton("Disable Ghola trading");
    await vi.waitFor(() => expect(mocks.submitDisable).toHaveBeenCalledWith(disableRequest));
    expect(beforeWalletAction).not.toHaveBeenCalled();
  });

  it("preserves a pending disable across reload instead of showing the stale vault as connected", async () => {
    window.sessionStorage.setItem(
      `ghola-hyperliquid-agent-disable-v1:${ACCOUNT_COMMITMENT}`,
      JSON.stringify(disableRequest),
    );
    mocks.getVaultStatus.mockResolvedValue({
      account_commitment: ACCOUNT_COMMITMENT,
      ready: true,
      hyperliquid_execution_vault: {
        status: "sealed",
        network: "mainnet",
        authorization_source: "phantom_approve_agent_v1",
        venue_revoke_supported: true,
        authorization_valid_until: new Date(NOW + 60 * 60_000).toISOString(),
      },
    });
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("previous disable may already have reached Hyperliquid"));
    expect(container.textContent).toContain("Retry exact venue check");
    expect(container.textContent).not.toContain("Disable Ghola trading");
    expect(window.sessionStorage.getItem(`ghola-hyperliquid-agent-disable-v1:${ACCOUNT_COMMITMENT}`)).not.toBeNull();

    await clickButton("Retry exact venue check");
    await vi.waitFor(() => expect(mocks.submitDisable).toHaveBeenCalledWith(disableRequest));
    expect(mocks.prepareDisable).not.toHaveBeenCalled();
  });

  it("offers reauthorization instead of claiming an expired agent is connected", async () => {
    mocks.getVaultStatus.mockResolvedValue({
      account_commitment: ACCOUNT_COMMITMENT,
      ready: true,
      hyperliquid_execution_vault: {
        status: "sealed",
        network: "mainnet",
        authorization_source: "phantom_approve_agent_v1",
        venue_revoke_supported: true,
        authorization_valid_until: new Date(NOW + 4 * 60_000).toISOString(),
      },
    });
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("Authorize with Phantom"));
    expect(container.textContent).not.toContain("Disable Ghola trading");
  });

  it("does not claim connected when the server rejects the stored worker or release proof", async () => {
    mocks.getVaultStatus.mockResolvedValue({
      account_commitment: ACCOUNT_COMMITMENT,
      ready: false,
      hyperliquid_execution_vault: {
        status: "sealed",
        network: "mainnet",
        authorization_source: "phantom_approve_agent_v1",
        venue_revoke_supported: true,
        authorization_valid_until: new Date(NOW + 60 * 60_000).toISOString(),
      },
    });
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("Authorize with Phantom"));
    expect(container.textContent).not.toContain("Disable Ghola trading");
  });

  it("refreshes parent setup after successful Phantom authorization", async () => {
    const onVaultStatusChange = vi.fn();
    await render({ onVaultStatusChange });
    await clickButton("Authorize with Phantom");
    await vi.waitFor(() => expect(mocks.submitAuthorization).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(onVaultStatusChange).toHaveBeenCalledOnce());
  });

  async function render(props: {
    beforeWalletAction?: () => Promise<boolean>;
    onVaultStatusChange?: () => void | Promise<void>;
  } = {}) {
    await act(async () => {
      root.render(createElement(ConnectHyperliquidButton, { ready: true, ...props }));
    });
  }

  async function clickButton(label: string) {
    const button = await findButton(label);
    await act(async () => button.click());
  }

  async function findButton(label: string) {
    await vi.waitFor(() => {
      expect(Array.from(container.querySelectorAll("button")).some((button) => button.textContent?.includes(label))).toBe(true);
    });
    return Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((candidate) => candidate.textContent?.includes(label))!;
  }
});
