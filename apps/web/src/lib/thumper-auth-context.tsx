"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { clearThumperToken, getUserProfile, thumperLogout } from "./thumper-api";

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

async function fetchCookieSession(): Promise<ThumperUser | null> {
  const res = await fetch("/api/auth/session/me", {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    authenticated?: boolean;
    user?: ThumperUser | null;
  };
  return data.authenticated && data.user ? data.user : null;
}

async function fetchLegacyTokenSession(): Promise<ThumperUser | null> {
  const token = safeGetTokenFromStorage();
  if (!token) return null;
  try {
    const profile = await getUserProfile();
    return {
      id: profile.id,
      email: profile.email,
      name: profile.name ?? undefined,
    };
  } catch {
    clearThumperToken();
    return null;
  }
}

export function ThumperAuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ThumperAuthState>({
    authenticated: false,
    loading: true,
    user: null,
  });

  useEffect(() => {
    let cancelled = false;
    // Fail-safe: never leave auth in permanent loading on this route.
    const fallback = window.setTimeout(() => {
      setState((prev) => (prev.loading ? { ...prev, loading: false } : prev));
    }, 2000);

    const loadSession = async () => {
      try {
        const user = (await fetchCookieSession()) ?? (await fetchLegacyTokenSession());
        if (cancelled) return;
        if (user) {
          setState({ authenticated: true, loading: false, user });
        } else {
          setState({ authenticated: false, loading: false, user: null });
        }
      } catch {
        if (!cancelled) setState({ authenticated: false, loading: false, user: null });
      }
    };

    void loadSession();
    const interval = window.setInterval(() => {
      void loadSession();
    }, 5 * 60_000);

    return () => {
      cancelled = true;
      window.clearTimeout(fallback);
      window.clearInterval(interval);
    };
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
