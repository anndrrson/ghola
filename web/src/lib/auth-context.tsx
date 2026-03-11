"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { clearToken } from "./api";

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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    authenticated: false,
    loading: true,
    user: null,
    authMethod: null,
    walletUser: null,
  });

  useEffect(() => {
    const token = localStorage.getItem("said_token");
    if (token) {
      try {
        const payload = JSON.parse(atob(token.split(".")[1]));
        if (payload.exp * 1000 > Date.now()) {
          setState({
            authenticated: true,
            loading: false,
            user: { id: payload.sub, email: payload.email },
            authMethod: "email",
            walletUser: null,
          });
          return;
        }
      } catch {
        // invalid token
      }
      clearToken();
    }
    setState({ authenticated: false, loading: false, user: null, authMethod: null, walletUser: null });
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
