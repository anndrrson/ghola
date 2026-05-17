"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";

interface TurnkeyWalletContext {
  walletAddress: string | null;
  subOrgId: string | null;
  walletId: string | null;
  loading: boolean;
  createWallet: (email: string) => Promise<void>;
  signMessage: (message: string) => Promise<string>;
  /**
   * Sign arbitrary bytes (not necessarily valid UTF-8) with the
   * wallet's Ed25519 key. Used by the session-vault unlock challenge
   * which contains a binary salt. Returns 64 raw signature bytes.
   */
  signBytes: (bytes: Uint8Array) => Promise<Uint8Array>;
  clearWallet: () => void;
}

const TurnkeyContext = createContext<TurnkeyWalletContext>({
  walletAddress: null,
  subOrgId: null,
  walletId: null,
  loading: true,
  createWallet: async () => {},
  signMessage: async () => "",
  signBytes: async () => new Uint8Array(),
  clearWallet: () => {},
});

export function TurnkeyWalletProvider({ children }: { children: ReactNode }) {
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [subOrgId, setSubOrgId] = useState<string | null>(null);
  const [walletId, setWalletId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Load from localStorage on mount
  useEffect(() => {
    const addr = localStorage.getItem("turnkey_wallet_address");
    const org = localStorage.getItem("turnkey_sub_org_id");
    const wid = localStorage.getItem("turnkey_wallet_id");
    if (addr && org && wid) {
      setWalletAddress(addr);
      setSubOrgId(org);
      setWalletId(wid);
    }
    setLoading(false);
  }, []);

  const createWallet = useCallback(async (email: string) => {
    const res = await fetch("/api/turnkey/create-wallet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: "Wallet creation failed" }));
      throw new Error(body.error || "Wallet creation failed");
    }
    const data = await res.json();
    localStorage.setItem("turnkey_wallet_address", data.walletAddress);
    localStorage.setItem("turnkey_sub_org_id", data.subOrgId);
    localStorage.setItem("turnkey_wallet_id", data.walletId);
    setWalletAddress(data.walletAddress);
    setSubOrgId(data.subOrgId);
    setWalletId(data.walletId);
  }, []);

  const signMessage = useCallback(
    async (message: string): Promise<string> => {
      if (!subOrgId || !walletAddress) {
        throw new Error("No wallet available for signing");
      }
      const res = await fetch("/api/turnkey/sign-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, subOrgId, walletAddress }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Signing failed" }));
        throw new Error(body.error || "Signing failed");
      }
      const data = await res.json();
      return data.signature; // base64-encoded Ed25519 signature
    },
    [subOrgId, walletAddress]
  );

  const signBytes = useCallback(
    async (bytes: Uint8Array): Promise<Uint8Array> => {
      if (!subOrgId || !walletAddress) {
        throw new Error("No wallet available for signing");
      }
      // Encode bytes as hex for the Turnkey route's binary path. We do
      // NOT round-trip through TextDecoder/UTF-8 because the input
      // contains arbitrary cryptographic salt bytes.
      const hex = Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const res = await fetch("/api/turnkey/sign-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageHex: hex, subOrgId, walletAddress }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Signing failed" }));
        throw new Error(body.error || "Signing failed");
      }
      const data = await res.json();
      // The route returns a base64 64-byte Ed25519 signature.
      const bin = atob(data.signature);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      if (out.length !== 64) {
        throw new Error(`Turnkey returned ${out.length}-byte signature, expected 64`);
      }
      return out;
    },
    [subOrgId, walletAddress]
  );

  const clearWallet = useCallback(() => {
    localStorage.removeItem("turnkey_wallet_address");
    localStorage.removeItem("turnkey_sub_org_id");
    localStorage.removeItem("turnkey_wallet_id");
    setWalletAddress(null);
    setSubOrgId(null);
    setWalletId(null);
  }, []);

  return (
    <TurnkeyContext.Provider
      value={{
        walletAddress,
        subOrgId,
        walletId,
        loading,
        createWallet,
        signMessage,
        signBytes,
        clearWallet,
      }}
    >
      {children}
    </TurnkeyContext.Provider>
  );
}

export function useTurnkeyWallet() {
  return useContext(TurnkeyContext);
}
