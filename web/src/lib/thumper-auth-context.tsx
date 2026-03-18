"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { clearThumperToken, thumperLogout } from "./thumper-api";

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

  // Auto-refresh JWT before expiry
  useEffect(() => {
    const interval = setInterval(() => {
      const token = localStorage.getItem("thumper_token");
      if (!token) return;

      try {
        const payload = JSON.parse(atob(token.split(".")[1]));
        const expMs = payload.exp * 1000;
        const now = Date.now();

        // Token already expired — force logout
        if (expMs <= now) {
          clearThumperToken();
          setState({ authenticated: false, loading: false, user: null });
          return;
        }

        // Within 5 minutes of expiry — refresh
        const fiveMinutes = 5 * 60 * 1000;
        if (expMs - now <= fiveMinutes) {
          fetch("/api/auth/refresh", {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
          })
            .then((res) => {
              if (!res.ok) throw new Error("Refresh failed");
              return res.json();
            })
            .then((data: { token: string }) => {
              localStorage.setItem("thumper_token", data.token);
              const newPayload = JSON.parse(atob(data.token.split(".")[1]));
              setState({
                authenticated: true,
                loading: false,
                user: {
                  id: newPayload.sub || newPayload.user_id,
                  email: newPayload.email,
                  name: newPayload.name,
                },
              });
            })
            .catch(() => {
              // Refresh failed — force logout
              clearThumperToken();
              setState({ authenticated: false, loading: false, user: null });
            });
        }
      } catch {
        // Invalid token — force logout
        clearThumperToken();
        setState({ authenticated: false, loading: false, user: null });
      }
    }, 60_000);

    return () => clearInterval(interval);
  }, []);

  const setAuth = useCallback((token: string, user: ThumperUser) => {
    localStorage.setItem("thumper_token", token);
    setState({ authenticated: true, loading: false, user });
  }, []);

  const logout = useCallback(() => {
    thumperLogout();
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
