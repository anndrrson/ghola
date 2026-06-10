import { describe, expect, it } from "vitest";
import {
  browserWalletFromSecret,
  createBrowserEd25519Wallet,
  isBrowserEd25519SecretKeyHex,
  signBrowserEd25519Bytes,
} from "./browser-ed25519-wallet";

describe("browser Ed25519 wallet", () => {
  it("creates a Solana-shaped browser signing identity", () => {
    const wallet = createBrowserEd25519Wallet("test");

    expect(wallet.walletAddress).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    expect(wallet.secretKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(wallet.walletId).toContain("test-wallet-");
    expect(wallet.subOrgId).toContain("test-org-");
    expect(isBrowserEd25519SecretKeyHex(wallet.secretKeyHex)).toBe(true);
  });

  it("signs envelope digest bytes with a persisted browser secret", () => {
    const secret = new Uint8Array(32).fill(7);
    const wallet = browserWalletFromSecret(secret, "fixed");
    const signature = signBrowserEd25519Bytes(wallet.secretKeyHex, new Uint8Array([1, 2, 3]));

    expect(signature).toHaveLength(64);
    expect(wallet.walletAddress).toBe(browserWalletFromSecret(secret, "fixed").walletAddress);
  });
});
