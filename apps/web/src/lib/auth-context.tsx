"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { clearToken, getProfile } from "./api";
import { runTokenMigration } from "./migrate-token";

type AuthMethod = "email" | "wallet" | null;

interface AuthState {
  authenticated: boolean;
  loading: boolean;
  user: { id: string; email: string } | null;
  authMethod: AuthMethod;
  walletUser: { wallet: string; isCreator: boolean } | null;
}

interface AuthContextValue extends AuthState {
  setAuth: (user: { id: string; email: string }) => void;
  setWalletAuth: (wallet: string, isCreator: boolean) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue>({
  authenticated: false,
  loading: true,
  user: null,
  authMethod: null,
  walletUser: null,
  setAuth: () => {},
  setWalletAuth: () => {},
  logout: () => {},
});

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080/v1";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    authenticated: false,
    loading: true,
    user: null,
    authMethod: null,
    walletUser: null,
  });

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // SECURITY: pre-migration we decoded the JWT out of
      // `localStorage["ghola_token"]` here. That was XSS-readable. The JWT
      // now lives in an HttpOnly `ghola_session` cookie that JS cannot read,
      // so we discover whether we have a valid session by calling
      // `/business/profile` with `credentials: "include"`; the cookie rides
      // along automatically.
      //
      // One-time migration: if a pre-cookie JWT is still sitting in
      // localStorage, the helper below hands it to the server which
      // re-emits a proper Set-Cookie and we purge the localStorage entry.
      await runTokenMigration();

      // We use getProfile() — the lightest authenticated GET on the SAID
      // API. A 401 (or any non-2xx) means "no session"; we don't need to
      // tell the user anything, components that require auth will redirect.
      // We don't get id/email back from getProfile (it returns the
      // BusinessProfile shape), so we hold a placeholder user; the
      // identity pages call `setAuth` with the real shape after a login
      // flow runs in their own context.
      try {
        await getProfile();
        if (cancelled) return;
        setState({
          authenticated: true,
          loading: false,
          user: { id: "", email: "" },
          authMethod: "email",
          walletUser: null,
        });
        return;
      } catch {
        // Not signed in (or network blip). Fall through to unauthenticated.
      }
      if (cancelled) return;
      clearToken();
      setState({
        authenticated: false,
        loading: false,
        user: null,
        authMethod: null,
        walletUser: null,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const setAuth = useCallback((user: { id: string; email: string }) => {
    setState({ authenticated: true, loading: false, user, authMethod: "email", walletUser: null });
  }, []);

  const setWalletAuth = useCallback((wallet: string, isCreator: boolean) => {
    setState((prev) => ({
      ...prev,
      walletUser: { wallet, isCreator },
    }));
  }, []);

  const logout = useCallback(() => {
    clearToken();
    // Fire-and-forget call to the server to clear the HttpOnly cookie.
    // Failure to reach the server (network blip, deploy in flight) is fine:
    // local state is already cleared and the browser drops the cookie at
    // Max-Age regardless.
    void fetch(`${API_BASE}/auth/logout`, {
      method: "POST",
      credentials: "include",
    }).catch(() => {});
    setState({ authenticated: false, loading: false, user: null, authMethod: null, walletUser: null });
  }, []);

  return (
    <AuthContext.Provider value={{ ...state, setAuth, setWalletAuth, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
