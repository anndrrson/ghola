"use client";

import { useState, useEffect, useCallback, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useThumperAuth } from "@/lib/thumper-auth-context";
import { thumperSignUp, thumperGoogleSignIn } from "@/lib/thumper-api";
import { useTurnkeyWallet } from "@/lib/turnkey-provider";
import { GholaLogo } from "@/components/GholaLogo";

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
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
            }
          ) => void;
        };
      };
    };
  }
}

function getPasswordStrength(password: string): {
  level: "weak" | "fair" | "good" | "strong";
  score: number;
} {
  if (password.length < 12) return { level: "weak", score: 1 };
  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  const hasSpecial = /[^A-Za-z0-9]/.test(password);
  if (hasUpper && hasLower && hasNumber && hasSpecial)
    return { level: "strong", score: 4 };
  if (hasUpper && hasLower && hasNumber) return { level: "good", score: 3 };
  return { level: "fair", score: 2 };
}

function PasswordStrengthIndicator({ password }: { password: string }) {
  if (!password) return null;
  const { level, score } = getPasswordStrength(password);
  const colors: Record<string, string> = {
    weak: "bg-red-500",
    fair: "bg-orange-500",
    good: "bg-yellow-500",
    strong: "bg-green-500",
  };
  const labels: Record<string, string> = {
    weak: "Weak",
    fair: "Fair",
    good: "Good",
    strong: "Strong",
  };
  return (
    <div className="mt-2">
      <div className="flex gap-1">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className={`h-1 flex-1 rounded-full transition-colors ${
              i <= score ? colors[level] : "bg-[#1e2a3a]"
            }`}
          />
        ))}
      </div>
      <p
        className={`text-xs mt-1 ${
          level === "weak"
            ? "text-red-400"
            : level === "fair"
              ? "text-orange-400"
              : level === "good"
                ? "text-yellow-400"
                : "text-green-400"
        }`}
      >
        {labels[level]}
      </p>
    </div>
  );
}

function SignUpContent() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [googleAvailable, setGoogleAvailable] = useState(true);
  const { setAuth } = useThumperAuth();
  const { createWallet, walletAddress } = useTurnkeyWallet();
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectTo = searchParams.get("redirect") || "/chat";
  const extraParams = searchParams.get("callback_port")
    ? `?callback_port=${searchParams.get("callback_port")}`
    : "";

  const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

  const handleGoogleCredential = useCallback(
    async (credential: string) => {
      setError("");
      setLoading(true);
      try {
        const res = await thumperGoogleSignIn(credential);
        setAuth({
          id: res.user.id,
          email: res.user.email,
          name: res.user.name,
        });
        // Create Turnkey wallet if not already present
        if (!walletAddress && res.user.email) {
          try {
            await createWallet(res.user.email);
          } catch {
            // Non-fatal — wallet can be created later
          }
        }
        router.push(redirectTo + extraParams);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Google sign-in failed");
      } finally {
        setLoading(false);
      }
    },
    [setAuth, createWallet, walletAddress, router, redirectTo, extraParams]
  );

  useEffect(() => {
    if (!googleClientId) return;
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = () => {
      window.google?.accounts.id.initialize({
        client_id: googleClientId,
        callback: (response) => handleGoogleCredential(response.credential),
      });
      const btn = document.getElementById("google-signin-btn");
      if (btn) {
        window.google?.accounts.id.renderButton(btn, {
          theme: "filled_black",
          size: "large",
          width: 350,
          text: "continue_with",
          shape: "rectangular",
        });
      }
    };
    script.onerror = () => {
      setGoogleAvailable(false);
    };
    document.body.appendChild(script);
    return () => {
      document.body.removeChild(script);
    };
  }, [googleClientId, handleGoogleCredential]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await thumperSignUp({ name, email, password });
      setAuth({
        id: res.user.id,
        email: res.user.email,
        name: res.user.name,
      });
      // Create Turnkey wallet after signup
      if (!walletAddress) {
        try {
          await createWallet(email);
        } catch {
          // Non-fatal
        }
      }
      router.push(redirectTo + extraParams);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign up failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-[#08090d]">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-1.5 mb-8">
          <GholaLogo size={32} className="text-[#eef1f8]" />
          <span className="text-2xl font-bold tracking-tight text-[#eef1f8]">
            ghola
          </span>
        </div>

        <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6">
          <h1 className="text-lg font-semibold text-[#eef1f8] mb-1">
            Create your account
          </h1>
          <p className="text-sm text-[#8b95a8] mb-6">
            Confidential AI in seconds — encrypted by default.
          </p>

          {((googleClientId && googleAvailable) || process.env.NEXT_PUBLIC_TWITTER_ENABLED) && (
            <>
              {googleClientId && googleAvailable && (
                <div id="google-signin-btn" className="flex justify-center" />
              )}
              <a
                href="/api/auth/twitter"
                className="flex items-center justify-center gap-2 w-full mt-3 rounded-lg bg-[#0f1117] border border-[#1e2a3a] py-2.5 text-sm font-medium text-[#eef1f8] hover:bg-[#161822] transition-colors"
              >
                <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
                Continue with X
              </a>
              <div className="relative my-5">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-[#1e2a3a]" />
                </div>
                <div className="relative flex justify-center text-xs">
                  <span className="bg-[#0f1117] px-3 text-[#4a5568]">or</span>
                </div>
              </div>
            </>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm text-[#8b95a8] mb-1.5">
                Name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                placeholder="Your name"
                className="w-full rounded-lg border border-[#1e2a3a] bg-[#161822] px-3 py-2.5 text-sm text-[#eef1f8] placeholder-[#4a5568] outline-none focus:border-[#3da8ff] transition-colors"
              />
            </div>
            <div>
              <label className="block text-sm text-[#8b95a8] mb-1.5">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="you@example.com"
                className="w-full rounded-lg border border-[#1e2a3a] bg-[#161822] px-3 py-2.5 text-sm text-[#eef1f8] placeholder-[#4a5568] outline-none focus:border-[#3da8ff] transition-colors"
              />
            </div>
            <div>
              <label className="block text-sm text-[#8b95a8] mb-1.5">
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={12}
                placeholder="At least 12 characters"
                className="w-full rounded-lg border border-[#1e2a3a] bg-[#161822] px-3 py-2.5 text-sm text-[#eef1f8] placeholder-[#4a5568] outline-none focus:border-[#3da8ff] transition-colors"
              />
              <PasswordStrengthIndicator password={password} />
            </div>

            {error && (
              <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-3">
                <p className="text-sm text-red-400">{error}</p>
                {error.toLowerCase().includes("google") && (
                  <p className="text-xs text-[#8b95a8] mt-1">
                    Try signing up with email instead.
                  </p>
                )}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-[#3da8ff] py-2.5 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] disabled:opacity-50 transition-colors cursor-pointer"
            >
              {loading ? "Creating account..." : "Get started free"}
            </button>
          </form>
        </div>

        <p className="mt-4 text-center text-sm text-[#8b95a8]">
          Already have an account?{" "}
          <Link href={`/signin?redirect=${encodeURIComponent(redirectTo)}${extraParams ? "&" + extraParams.slice(1) : ""}`} className="text-[#3da8ff] hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}

export default function SignUpPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-[#08090d]">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#3da8ff] border-t-transparent" />
        </div>
      }
    >
      <SignUpContent />
    </Suspense>
  );
}
