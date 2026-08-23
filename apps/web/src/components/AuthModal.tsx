"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { thumperGoogleSignIn, thumperSignIn, thumperSignUp } from "@/lib/thumper-api";
import { useThumperAuth } from "@/lib/thumper-auth-context";
import { useTurnkeyWallet } from "@/lib/turnkey-provider";
import { GholaLogo } from "@/components/GholaLogo";

export type AuthMode = "signin" | "signup";

type AuthModalProps = {
  mode: AuthMode;
  open: boolean;
  onClose: () => void;
  onModeChange: (mode: AuthMode) => void;
  redirectTo?: string | null;
  reason?: "chat-private" | "hyperliquid-setup";
};

type GoogleIdentityApi = {
  initialize: (config: {
    client_id: string;
    callback: (response: { credential: string }) => void;
  }) => void;
  renderButton: (
    element: HTMLElement,
    config: {
      theme?: string;
      size?: string;
      width?: number;
      text?: string;
      shape?: string;
    },
  ) => void;
};

function googleIdentityApi() {
  return (window as typeof window & {
    google?: { accounts?: { id?: GoogleIdentityApi } };
  }).google?.accounts?.id;
}

function passwordStrength(password: string) {
  if (password.length < 12) return { label: "Weak", score: 1, color: "bg-red-500" };
  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  const hasSpecial = /[^A-Za-z0-9]/.test(password);
  if (hasUpper && hasLower && hasNumber && hasSpecial) {
    return { label: "Strong", score: 4, color: "bg-green-500" };
  }
  if (hasUpper && hasLower && hasNumber) {
    return { label: "Good", score: 3, color: "bg-yellow-500" };
  }
  return { label: "Fair", score: 2, color: "bg-orange-500" };
}

export function AuthModal({
  mode,
  open,
  onClose,
  onModeChange,
  redirectTo = "/chat",
  reason,
}: AuthModalProps) {
  const router = useRouter();
  const { setAuth } = useThumperAuth();
  const { createWallet, walletAddress } = useTurnkeyWallet();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [googleAvailable, setGoogleAvailable] = useState(true);
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);
  const googleButtonRef = useRef<HTMLDivElement>(null);
  const fieldId = useId();
  const isSignup = mode === "signup";
  const isPrivateChat = reason === "chat-private";
  const isHyperliquidSetup = reason === "hyperliquid-setup";
  const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  const strength = passwordStrength(password);
  const nameId = `${fieldId}-name`;
  const emailId = `${fieldId}-email`;
  const passwordId = `${fieldId}-password`;

  useEffect(() => {
    if (open) {
      setMounted(true);
      const raf = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(raf);
    }

    setVisible(false);
    const timeout = window.setTimeout(() => setMounted(false), 180);
    return () => window.clearTimeout(timeout);
  }, [open]);

  useEffect(() => {
    if (!mounted) return;
    setError("");
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [mounted, onClose]);

  const handleGoogleCredential = useCallback(async (credential: string) => {
    setError("");
    setLoading(true);
    try {
      const res = await thumperGoogleSignIn(credential);
      setAuth({
        id: res.user.id,
        email: res.user.email,
        name: res.user.name,
      });
      if (!walletAddress && res.user.email) {
        try {
          await createWallet(res.user.email);
        } catch {
          // Wallet creation can be completed later from the account surface.
        }
      }
      onClose();
      if (redirectTo) router.push(redirectTo);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Google sign-in failed");
    } finally {
      setLoading(false);
    }
  }, [createWallet, onClose, redirectTo, router, setAuth, walletAddress]);

  useEffect(() => {
    if (!mounted || !googleClientId || !googleAvailable) return;

    let cancelled = false;
    const renderGoogleButton = () => {
      if (cancelled || !googleButtonRef.current) return;
      const google = googleIdentityApi();
      if (!google) return;
      google.initialize({
        client_id: googleClientId,
        callback: (response) => void handleGoogleCredential(response.credential),
      });
      google.renderButton(googleButtonRef.current, {
        theme: "filled_black",
        size: "large",
        width: 336,
        text: "continue_with",
        shape: "rectangular",
      });
    };

    const source = "https://accounts.google.com/gsi/client";
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${source}"]`);
    if (existing) {
      if (googleIdentityApi()) renderGoogleButton();
      else existing.addEventListener("load", renderGoogleButton, { once: true });
      return () => {
        cancelled = true;
        existing.removeEventListener("load", renderGoogleButton);
      };
    }

    const script = document.createElement("script");
    script.src = source;
    script.async = true;
    script.addEventListener("load", renderGoogleButton, { once: true });
    script.addEventListener("error", () => setGoogleAvailable(false), { once: true });
    document.head.appendChild(script);
    return () => {
      cancelled = true;
      script.removeEventListener("load", renderGoogleButton);
    };
  }, [googleAvailable, googleClientId, handleGoogleCredential, mounted]);

  if (!mounted) return null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = isSignup
        ? await thumperSignUp({ name: isHyperliquidSetup ? undefined : name, email, password })
        : await thumperSignIn({ email, password });
      setAuth({
        id: res.user.id,
        email: res.user.email,
        name: res.user.name,
      });
      if (!walletAddress) {
        try {
          await createWallet(res.user.email || email);
        } catch {
          // Wallet creation can be completed later from the account surface.
        }
      }
      onClose();
      if (redirectTo) router.push(redirectTo);
    } catch (err) {
      setError(err instanceof Error ? err.message : isSignup ? "Sign up failed" : "Sign in failed");
    } finally {
      setLoading(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[110] flex items-center justify-center px-4 py-6">
      <button
        aria-label="Close auth dialog"
        className={`absolute inset-0 bg-black/72 backdrop-blur-sm transition-opacity duration-200 ease-out ${
          visible ? "opacity-100" : "opacity-0"
        }`}
        onClick={onClose}
      />
      <div
        className={`relative w-full max-w-sm rounded-2xl border border-[#1e2a3a] bg-[#0b0d13] p-6 shadow-[0_28px_90px_rgba(0,0,0,0.72)] transition-all duration-200 ease-out ${
          visible
            ? "translate-y-0 scale-100 opacity-100"
            : "translate-y-3 scale-[0.985] opacity-0"
        }`}
      >
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="absolute right-4 top-4 rounded-md p-1 text-[#6f798c] transition hover:bg-[#161822] hover:text-[#eef1f8]"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="mb-6 flex items-center gap-2">
          <GholaLogo size={28} className="text-[#eef1f8]" />
          <span className="text-xl font-bold tracking-tight text-[#eef1f8]">
            ghola
          </span>
        </div>

        <h2 className="text-lg font-semibold text-[#eef1f8]">
          {isPrivateChat
            ? isSignup
              ? "Create an account to get your private answer"
              : "Sign in to get your private answer"
            : isHyperliquidSetup
              ? isSignup
                ? "Start trading"
                : "Welcome back"
            : isSignup
              ? "Create your account"
              : "Welcome back"}
        </h2>
        <p className="mt-1 text-sm text-[#8b95a8]">
          {isPrivateChat
            ? "Your question is saved and will send after private setup finishes."
            : isHyperliquidSetup
              ? "Continue directly to one trade-only Hyperliquid authorization."
            : isSignup
              ? "Start using Ghola without leaving this page."
              : "Sign in to continue to Ghola."}
        </p>

        {googleClientId && googleAvailable && (
          <>
            <div ref={googleButtonRef} className="mt-6 flex min-h-10 justify-center" />
            <div className="relative my-5">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-[#1e2a3a]" />
              </div>
              <div className="relative flex justify-center text-xs">
                <span className="bg-[#0b0d13] px-3 text-[#4a5568]">or use email</span>
              </div>
            </div>
          </>
        )}

        <form onSubmit={submit} className={`${googleClientId && googleAvailable ? "" : "mt-6"} space-y-4`}>
          {isSignup && !isHyperliquidSetup && (
            <div>
              <label htmlFor={nameId} className="mb-1.5 block text-sm text-[#8b95a8]">
                Name
              </label>
              <input
                id={nameId}
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                placeholder="Your name"
                className="w-full rounded-lg border border-[#1e2a3a] bg-[#161822] px-3 py-2.5 text-sm text-[#eef1f8] outline-none transition-colors placeholder:text-[#4a5568] focus:border-[#3da8ff]"
              />
            </div>
          )}

          <div>
            <label htmlFor={emailId} className="mb-1.5 block text-sm text-[#8b95a8]">
              Email
            </label>
            <input
              id={emailId}
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              placeholder="you@example.com"
              className="w-full rounded-lg border border-[#1e2a3a] bg-[#161822] px-3 py-2.5 text-sm text-[#eef1f8] outline-none transition-colors placeholder:text-[#4a5568] focus:border-[#3da8ff]"
            />
          </div>

          <div>
            <label htmlFor={passwordId} className="mb-1.5 block text-sm text-[#8b95a8]">
              Password
            </label>
            <input
              id={passwordId}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              minLength={isSignup ? 12 : undefined}
              placeholder={isSignup ? "At least 12 characters" : "Your password"}
              className="w-full rounded-lg border border-[#1e2a3a] bg-[#161822] px-3 py-2.5 text-sm text-[#eef1f8] outline-none transition-colors placeholder:text-[#4a5568] focus:border-[#3da8ff]"
            />
            {isSignup && password && (
              <div className="mt-2">
                <div className="flex gap-1">
                  {[1, 2, 3, 4].map((score) => (
                    <div
                      key={score}
                      className={`h-1 flex-1 rounded-full ${
                        score <= strength.score ? strength.color : "bg-[#1e2a3a]"
                      }`}
                    />
                  ))}
                </div>
                <p className="mt-1 text-xs text-[#8b95a8]">{strength.label}</p>
              </div>
            )}
          </div>

          {error && (
            <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-3">
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-[#3da8ff] py-2.5 text-sm font-medium text-[#08090d] transition-colors hover:bg-[#5bb8ff] disabled:opacity-50"
          >
            {loading
              ? isSignup
                ? "Creating account..."
                : "Signing in..."
              : isSignup
                ? isHyperliquidSetup ? "Continue" : "Get started"
                : "Sign in"}
          </button>
        </form>

        <p className="mt-4 text-center text-sm text-[#8b95a8]">
          {isSignup ? "Already have an account?" : "Need an account?"}{" "}
          <button
            type="button"
            onClick={() => onModeChange(isSignup ? "signin" : "signup")}
            className="text-[#3da8ff] hover:underline"
          >
            {isSignup ? "Sign in" : "Sign up"}
          </button>
        </p>
      </div>
    </div>,
    document.body,
  );
}
