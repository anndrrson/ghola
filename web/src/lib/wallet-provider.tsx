"use client";

import { FC, ReactNode, useMemo, useCallback, useEffect, useState, createContext, useContext } from "react";
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
import { orniGetNonce, orniVerifySignature, clearOrniToken } from "./api";

import "@solana/wallet-adapter-react-ui/styles.css";

interface WalletAuthState {
  authenticated: boolean;
  isCreator: boolean;
}

const WalletAuthContext = createContext<WalletAuthState>({
  authenticated: false,
  isCreator: false,
});

export function useWalletAuth() {
  return useContext(WalletAuthContext);
}

function AuthHandler({
  onAuthChange,
}: {
  onAuthChange: (state: WalletAuthState) => void;
}) {
  const { publicKey, signMessage, connected, disconnect } = useWallet();

  const authenticate = useCallback(async () => {
    if (!publicKey || !signMessage) return;
    try {
      const wallet = publicKey.toBase58();
      const { nonce } = await orniGetNonce(wallet);
      const message = new TextEncoder().encode(
        `Sign in to Ghola Models\nNonce: ${nonce}`
      );
      const sig = await signMessage(message);
      const { is_creator } = await orniVerifySignature(
        wallet,
        bs58.encode(sig),
        nonce
      );
      onAuthChange({ authenticated: true, isCreator: is_creator });
    } catch {
      clearOrniToken();
      disconnect();
      onAuthChange({ authenticated: false, isCreator: false });
    }
  }, [publicKey, signMessage, disconnect, onAuthChange]);

  useEffect(() => {
    if (connected && publicKey) {
      authenticate();
    } else {
      clearOrniToken();
      onAuthChange({ authenticated: false, isCreator: false });
    }
  }, [connected, publicKey, authenticate, onAuthChange]);

  return null;
}

export const AppWalletProvider: FC<{ children: ReactNode }> = ({
  children,
}) => {
  const network = WalletAdapterNetwork.Devnet;
  const endpoint = useMemo(
    () => process.env.NEXT_PUBLIC_SOLANA_RPC || clusterApiUrl(network),
    [network]
  );
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);
  const [authState, setAuthState] = useState<WalletAuthState>({
    authenticated: false,
    isCreator: false,
  });

  const handleAuthChange = useCallback((state: WalletAuthState) => {
    setAuthState(state);
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("ghola-wallet-auth", { detail: state })
      );
    }
  }, []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <AuthHandler onAuthChange={handleAuthChange} />
          <WalletAuthContext.Provider value={authState}>
            {children}
          </WalletAuthContext.Provider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
};
