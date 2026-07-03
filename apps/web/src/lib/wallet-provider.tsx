"use client";

import {
  FC,
  ReactNode,
  useCallback,
  useEffect,
  useState,
  createContext,
  useContext,
  useRef,
} from "react";
import { TurnkeyWalletProvider, useTurnkeyWallet } from "./turnkey-provider";
import { orniGetNonce, orniVerifySignature, clearOrniToken } from "./api";

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

function TurnkeySIWSHandler({
  onAuthChange,
}: {
  onAuthChange: (state: WalletAuthState) => void;
}) {
  const { walletAddress, signMessage, loading } = useTurnkeyWallet();
  const authenticatingRef = useRef(false);
  const lastWalletRef = useRef<string | null>(null);

  const authenticate = useCallback(async () => {
    if (!walletAddress || authenticatingRef.current) return;
    authenticatingRef.current = true;
    try {
      const { nonce, message } = await orniGetNonce(walletAddress);
      // Use the message returned by the backend (fixes SIWS message mismatch bug)
      const signature = await signMessage(message);
      // Signature is already base64-encoded (fixes encoding mismatch bug)
      const { is_creator } = await orniVerifySignature(
        walletAddress,
        signature,
        nonce
      );
      onAuthChange({ authenticated: true, isCreator: is_creator });
    } catch {
      clearOrniToken();
      onAuthChange({ authenticated: false, isCreator: false });
    } finally {
      authenticatingRef.current = false;
    }
  }, [walletAddress, signMessage, onAuthChange]);

  useEffect(() => {
    if (loading) return;

    if (walletAddress) {
      // Only re-authenticate if wallet changed or we haven't authed yet.
      if (lastWalletRef.current !== walletAddress) {
        lastWalletRef.current = walletAddress;

        // SECURITY: pre-migration we cached the JWT in
        // `localStorage["ghola_orni_token"]` here. That's an XSS
        // exfiltration target — any script that runs in the page can
        // read it and impersonate the user until expiry. The JWT now
        // lives in an HttpOnly cookie set by `/auth/verify`; JS cannot
        // see it. We always run the lightweight SIWS round-trip on first
        // load now — if the cookie is still valid the server will mint a
        // fresh one (cheap), and if it isn't we needed a new sign-in
        // anyway.
        //
        // Best-effort: purge the legacy localStorage entry so users who
        // signed in before this deploy don't carry a stale, JS-readable
        // JWT around. The `refresh-cookie` migration endpoint
        // (apps/web/src/lib/migrate-token.ts) handles the smoother UX
        // path of re-using the existing JWT instead of forcing a SIWS.
        clearOrniToken();
        authenticate();
      }
    } else {
      lastWalletRef.current = null;
      clearOrniToken();
      onAuthChange({ authenticated: false, isCreator: false });
    }
  }, [walletAddress, loading, authenticate, onAuthChange]);

  return null;
}

export const AppWalletProvider: FC<{ children: ReactNode }> = ({
  children,
}) => {
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
    <TurnkeyWalletProvider>
      <TurnkeySIWSHandler onAuthChange={handleAuthChange} />
      <WalletAuthContext.Provider value={authState}>
        {children}
      </WalletAuthContext.Provider>
    </TurnkeyWalletProvider>
  );
};
