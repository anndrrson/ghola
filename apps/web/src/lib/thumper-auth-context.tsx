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
  /**
   * Set the authenticated user. The `token` is optional — the newer
   * Twitter exchange flow uses cookie-backed sessions (no JWT to
   * store), so callers in that path pass only the user. Legacy
   * email/password + Google flows still pass the token to keep the
   * thumper_token localStorage entry in sync.
   */
  setAuth: (userOrToken: ThumperUser | string, user?: ThumperUser) => void;
  logout: () => void;
}

const ThumperAuthContext = createContext<ThumperAuthContextValue>({
  authenticated: false,
  loading: true,
  user: null,
  setAuth: () => {},
  logout: () => {},
});

function safeGetTokenFromStorage(): string | null {
  try {
    return localStorage.getItem("thumper_token");
  } catch {
    return null;
  }
}

function safeSetTokenInStorage(token: string) {
  try {
    localStorage.setItem("thumper_token", token);
  } catch {
    // Best-effort only.
  }
}

export function ThumperAuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ThumperAuthState>({
    authenticated: false,
    loading: true,
    user: null,
  });

  useEffect(() => {
    // Fail-safe: never leave auth in permanent loading on this route.
    const fallback = window.setTimeout(() => {
      setState((prev) => (prev.loading ? { ...prev, loading: false } : prev));
    }, 2000);
    try {
      const token = safeGetTokenFromStorage();
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
            return () => window.clearTimeout(fallback);
          }
        } catch {
          // invalid token
        }
        clearThumperToken();
      }
    } catch {
      // Keep going; we always drop loading below.
    }
    setState({ authenticated: false, loading: false, user: null });
    return () => window.clearTimeout(fallback);
  }, []);

  // Auto-refresh JWT before expiry
  useEffect(() => {
    const interval = setInterval(() => {
      const token = safeGetTokenFromStorage();
      // Storage can be unavailable in hardened browser settings.
      // Treat that as "logged out" and skip refresh.
      if (token === null) return;

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
              safeSetTokenInStorage(data.token);
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

  const setAuth = useCallback(
    (userOrToken: ThumperUser | string, user?: ThumperUser) => {
      // Two call shapes:
      //   setAuth(token, user) — legacy email/password + Google
      //   setAuth(user)        — cookie-backed Twitter session (no JWT)
      if (typeof userOrToken === "string") {
        safeSetTokenInStorage(userOrToken);
        if (user) setState({ authenticated: true, loading: false, user });
      } else {
        setState({
          authenticated: true,
          loading: false,
          user: userOrToken,
        });
      }
    },
    [],
  );

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
