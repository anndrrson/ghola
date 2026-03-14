"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { clearThumperToken } from "./thumper-api";

interface ThumperUser {
  id: string;
  email: string;
  name?: string;
}

interface ThumperAuthState {
  authenticated: boolean;
  loading: boolean;
  user: ThumperUser | null;
}

interface ThumperAuthContextValue extends ThumperAuthState {
  setAuth: (token: string, user: ThumperUser) => void;
  logout: () => void;
}

const ThumperAuthContext = createContext<ThumperAuthContextValue>({
  authenticated: false,
  loading: true,
  user: null,
  setAuth: () => {},
  logout: () => {},
});

export function ThumperAuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ThumperAuthState>({
    authenticated: false,
    loading: true,
    user: null,
  });

  useEffect(() => {
    const token = localStorage.getItem("thumper_token");
    if (token) {
      try {
        const payload = JSON.parse(atob(token.split(".")[1]));
        if (payload.exp * 1000 > Date.now()) {
          setState({
            authenticated: true,
            loading: false,
            user: {
              id: payload.sub || payload.user_id,
              email: payload.email,
              name: payload.name,
            },
          });
          return;
        }
      } catch {
        // invalid token
      }
      clearThumperToken();
    }
    setState({ authenticated: false, loading: false, user: null });
  }, []);

  const setAuth = useCallback((token: string, user: ThumperUser) => {
    localStorage.setItem("thumper_token", token);
    setState({ authenticated: true, loading: false, user });
  }, []);

  const logout = useCallback(() => {
    clearThumperToken();
    setState({ authenticated: false, loading: false, user: null });
  }, []);

  return (
    <ThumperAuthContext.Provider value={{ ...state, setAuth, logout }}>
      {children}
    </ThumperAuthContext.Provider>
  );
}

export function useThumperAuth() {
  return useContext(ThumperAuthContext);
}
