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
  clearWallet: () => void;
}

const TurnkeyContext = createContext<TurnkeyWalletContext>({
  walletAddress: null,
  subOrgId: null,
  walletId: null,
  loading: true,
  createWallet: async () => {},
  signMessage: async () => "",
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
