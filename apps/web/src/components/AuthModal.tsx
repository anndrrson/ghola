"use client";

import { memo, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { thumperSignIn, thumperSignUp } from "@/lib/thumper-api";
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
};

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

export const AuthModal = memo(function AuthModal({
  mode,
  open,
  onClose,
  onModeChange,
  redirectTo = "/trade",
}: AuthModalProps) {
  const router = useRouter();
  const { setAuth } = useThumperAuth();
  const { createWallet, walletAddress } = useTurnkeyWallet();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const nameId = useId();
  const emailId = useId();
  const passwordId = useId();
  const isSignup = mode === "signup";
  const strength = passwordStrength(password);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const raf = requestAnimationFrame(() => {
        setError("");
        setVisible(true);
      });
      return () => cancelAnimationFrame(raf);
    }

    setVisible(false);
    const timeout = window.setTimeout(() => setMounted(false), 180);
    return () => window.clearTimeout(timeout);
  }, [open]);

  useEffect(() => {
    if (!mounted) return;
    const dialog = dialogRef.current;
    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )).filter((element) => element.offsetParent !== null);
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1) ?? first;
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    queueMicrotask(() => {
      const initialFocus = dialog?.querySelector<HTMLElement>("input:not([disabled])") ?? dialog;
      initialFocus?.focus();
    });
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      const returnFocus = returnFocusRef.current;
      returnFocusRef.current = null;
      if (returnFocus?.isConnected) queueMicrotask(() => returnFocus.focus());
    };
  }, [mounted]);

  if (!mounted) return null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = isSignup
        ? await thumperSignUp({ name, email, password })
        : await thumperSignIn({ email, password });
      const user = {
        id: res.user.id,
        email: res.user.email,
        name: res.user.name,
      };
      if (res.token) setAuth(res.token, user);
      else setAuth(user);
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

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center px-4 py-6">
      <div
        aria-hidden="true"
        className={`absolute inset-0 bg-black/72 backdrop-blur-sm transition-opacity duration-200 ease-out ${
          visible ? "opacity-100" : "opacity-0"
        }`}
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
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

        <h2 id={titleId} className="text-lg font-semibold text-[#eef1f8]">
          {isSignup ? "Create your account" : "Welcome back"}
        </h2>
        <p className="mt-1 text-sm text-[#8b95a8]">
          {isSignup
            ? "Start a private AI session without leaving this page."
            : "Sign in and continue to your private AI."}
        </p>

        <form onSubmit={submit} className="mt-6 space-y-4">
          {isSignup && (
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

          {error ? (
            <div role="alert" aria-atomic="true" className="rounded-lg border border-red-500/20 bg-red-500/10 p-3">
              <p className="text-sm text-red-400">{error}</p>
            </div>
          ) : null}

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
                ? "Get started"
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
    </div>
  );
});
