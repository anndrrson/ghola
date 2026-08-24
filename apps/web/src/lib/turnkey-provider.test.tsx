import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserEd25519Wallet } from "./browser-ed25519-wallet";
import {
  opaqueTurnkeyWalletScope,
  TurnkeyWalletProvider,
  useTurnkeyWallet,
} from "./turnkey-provider";

type WalletContext = ReturnType<typeof useTurnkeyWallet>;

describe("auth-scoped Ghola signing wallets", () => {
  let container: HTMLDivElement;
  let root: Root;
  let current: WalletContext | null;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    current = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ code: "turnkey_server_controlled_wallets_disabled" }),
    }));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("isolates A to B and restores only A when switching back", async () => {
    const scopeA = opaqueTurnkeyWalletScope("google-user-a");
    const scopeB = opaqueTurnkeyWalletScope("google-user-b");
    expect(scopeA).toMatch(/^[0-9a-f]{64}$/);
    expect(scopeB).toMatch(/^[0-9a-f]{64}$/);

    await renderScope(scopeA, "a@example.com");
    await act(async () => current!.createWallet("a@example.com"));
    const walletA = current!.walletAddress;
    expect(walletA).toBeTruthy();

    await renderScope(scopeB, "b@example.com");
    expect(current!.walletAddress).toBeNull();
    await act(async () => current!.createWallet("b@example.com"));
    const walletB = current!.walletAddress;
    expect(walletB).toBeTruthy();
    expect(walletB).not.toBe(walletA);

    await renderScope(scopeA, "a@example.com");
    expect(current!.walletAddress).toBe(walletA);

    await renderScope(null, null);
    expect(current!.walletAddress).toBeNull();
    expect(current!.walletMode).toBeNull();
  });

  it("migrates a legacy browser signer only when the authenticated email label matches", async () => {
    const legacy = createBrowserEd25519Wallet("ghola-a-example-com");
    storeLegacyBrowserWallet(legacy);

    await renderScope(opaqueTurnkeyWalletScope("google-user-a"), " A@Example.com ");

    expect(current!.walletAddress).toBe(legacy.walletAddress);
    expect(localStorage.getItem("ghola_browser_ed25519_secret_key")).toBeNull();
    expect(localStorage.getItem("ghola_browser_wallet_address")).toBeNull();
    const quarantine = localStorage.getItem("ghola_legacy_signing_wallet_quarantine_v1") || "";
    expect(quarantine).toContain("migrated_matching_browser_identity");
    expect(quarantine).not.toContain(legacy.secretKeyHex);
    expect(quarantine).not.toContain(legacy.walletAddress);
  });

  it("fails closed and keeps no raw values when the authenticated email does not match", async () => {
    const legacy = createBrowserEd25519Wallet("ghola-a-example-com");
    storeLegacyBrowserWallet(legacy);

    await renderScope(opaqueTurnkeyWalletScope("google-user-b"), "b@example.com");

    expect(current!.walletAddress).toBeNull();
    for (const key of [
      "ghola_browser_ed25519_secret_key",
      "ghola_browser_wallet_address",
      "ghola_browser_sub_org_id",
      "ghola_browser_wallet_id",
    ]) expect(localStorage.getItem(key)).toBeNull();
    const quarantine = localStorage.getItem("ghola_legacy_signing_wallet_quarantine_v1") || "";
    expect(quarantine).toContain("discarded_unverified_identity");
    expect(quarantine).toContain("ghola_browser_ed25519_secret_key");
    expect(quarantine).not.toContain(legacy.secretKeyHex);
    expect(quarantine).not.toContain(legacy.walletAddress);
    expect(quarantine).not.toContain(legacy.subOrgId);
    expect(quarantine).not.toContain(legacy.walletId);
  });

  it("does not discard an unclaimed legacy signer while auth is unresolved or signed out", async () => {
    const legacy = createBrowserEd25519Wallet("ghola-a-example-com");
    storeLegacyBrowserWallet(legacy);

    await act(async () => {
      root.render(
        <TurnkeyWalletProvider authEmail={null} authResolved={false} authScope={null}>
          <Probe onValue={(value) => { current = value; }} />
        </TurnkeyWalletProvider>,
      );
    });
    expect(current!.walletAddress).toBeNull();
    expect(localStorage.getItem("ghola_browser_ed25519_secret_key")).toBe(legacy.secretKeyHex);

    await renderScope(null, null);
    expect(current!.walletAddress).toBeNull();
    expect(localStorage.getItem("ghola_browser_ed25519_secret_key")).toBe(legacy.secretKeyHex);
  });

  async function renderScope(authScope: string | null, authEmail: string | null) {
    await act(async () => {
      root.render(
        <TurnkeyWalletProvider authEmail={authEmail} authResolved authScope={authScope}>
          <Probe onValue={(value) => { current = value; }} />
        </TurnkeyWalletProvider>,
      );
    });
    expect(current).not.toBeNull();
  }

  function storeLegacyBrowserWallet(wallet: ReturnType<typeof createBrowserEd25519Wallet>) {
    localStorage.setItem("ghola_browser_ed25519_secret_key", wallet.secretKeyHex);
    localStorage.setItem("ghola_browser_wallet_address", wallet.walletAddress);
    localStorage.setItem("ghola_browser_sub_org_id", wallet.subOrgId);
    localStorage.setItem("ghola_browser_wallet_id", wallet.walletId);
  }
});

function Probe({ onValue }: { onValue: (value: WalletContext) => void }) {
  const value = useTurnkeyWallet();
  useEffect(() => onValue(value), [onValue, value]);
  return null;
}
