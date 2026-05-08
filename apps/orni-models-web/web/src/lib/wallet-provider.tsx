"use client";

import { FC, ReactNode, useMemo, useCallback, useEffect, useState } from "react";
import {
  ConnectionProvider,
  WalletProvider,
  useWallet,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-wallets";
import { clusterApiUrl } from "@solana/web3.js";
import bs58 from "bs58";
import { getNonce, verifySignature, clearToken } from "./api";

import "@solana/wallet-adapter-react-ui/styles.css";

interface AuthState {
  authenticated: boolean;
  isCreator: boolean;
}

function AuthHandler({
  onAuthChange,
}: {
  onAuthChange: (state: AuthState) => void;
}) {
  const { publicKey, signMessage, connected, disconnect } = useWallet();

  const authenticate = useCallback(async () => {
    if (!publicKey || !signMessage) return;
    try {
      const wallet = publicKey.toBase58();
      const { nonce } = await getNonce(wallet);
      const message = new TextEncoder().encode(
        `Sign in to Orni Models\nNonce: ${nonce}`
      );
      const sig = await signMessage(message);
      const { is_creator } = await verifySignature(
        wallet,
        bs58.encode(sig),
        nonce
      );
      onAuthChange({ authenticated: true, isCreator: is_creator });
    } catch {
      clearToken();
      disconnect();
      onAuthChange({ authenticated: false, isCreator: false });
    }
  }, [publicKey, signMessage, disconnect, onAuthChange]);

  useEffect(() => {
    if (connected && publicKey) {
      authenticate();
    } else {
      clearToken();
      onAuthChange({ authenticated: false, isCreator: false });
    }
  }, [connected, publicKey, authenticate, onAuthChange]);

  return null;
}

export const AppWalletProvider: FC<{ children: ReactNode }> = ({
  children,
}) => {
  const network = WalletAdapterNetwork.Devnet;
  const endpoint = useMemo(() => clusterApiUrl(network), [network]);
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);
  const [authState, setAuthState] = useState<AuthState>({
    authenticated: false,
    isCreator: false,
  });

  const handleAuthChange = useCallback((state: AuthState) => {
    setAuthState(state);
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("orni-auth", { detail: state })
      );
    }
  }, []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <AuthHandler onAuthChange={handleAuthChange} />
          <AuthContext.Provider value={authState}>
            {children}
          </AuthContext.Provider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
};

import { createContext, useContext } from "react";

const AuthContext = createContext<AuthState>({
  authenticated: false,
  isCreator: false,
});

export function useAuth() {
  return useContext(AuthContext);
}
