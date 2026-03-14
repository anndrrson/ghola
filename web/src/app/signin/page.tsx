"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useThumperAuth } from "@/lib/thumper-auth-context";
import { thumperSignIn, thumperGoogleSignIn } from "@/lib/thumper-api";
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

export default function SignInPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const { setAuth } = useThumperAuth();
  const { createWallet, walletAddress } = useTurnkeyWallet();
  const router = useRouter();

  const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

  const handleGoogleCredential = useCallback(
    async (credential: string) => {
      setError("");
      setLoading(true);
      try {
        const res = await thumperGoogleSignIn(credential);
        setAuth(res.token, {
          id: res.user.id,
          email: res.user.email,
          name: res.user.name,
        });
        // Create Turnkey wallet if not already present
        if (!walletAddress && res.user.email) {
          try {
            await createWallet(res.user.email);
          } catch {
            // Non-fatal
          }
        }
        router.push("/chat");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Google sign-in failed");
      } finally {
        setLoading(false);
      }
    },
    [setAuth, createWallet, walletAddress, router]
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
          text: "signin_with",
          shape: "rectangular",
        });
      }
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
      const res = await thumperSignIn({ email, password });
      setAuth(res.token, {
        id: res.user.id,
        email: res.user.email,
        name: res.user.name,
      });
      // Create Turnkey wallet if not already present
      if (!walletAddress) {
        try {
          await createWallet(email);
        } catch {
          // Non-fatal
        }
      }
      router.push("/chat");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-[#08090d]">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2.5 mb-8">
          <GholaLogo size={32} className="text-[#eef1f8]" />
          <span className="text-2xl font-bold tracking-tight text-[#eef1f8]">
            ghola
          </span>
        </div>

        <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6">
          <h1 className="text-lg font-semibold text-[#eef1f8] mb-1">
            Welcome back
          </h1>
          <p className="text-sm text-[#8b95a8] mb-6">
            Sign in to your AI assistant
          </p>

          {(googleClientId || process.env.NEXT_PUBLIC_TWITTER_ENABLED) && (
            <>
              {googleClientId && (
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
                placeholder="Your password"
                className="w-full rounded-lg border border-[#1e2a3a] bg-[#161822] px-3 py-2.5 text-sm text-[#eef1f8] placeholder-[#4a5568] outline-none focus:border-[#3da8ff] transition-colors"
              />
            </div>

            {error && (
              <p className="text-sm text-red-400">{error}</p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-[#3da8ff] py-2.5 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] disabled:opacity-50 transition-colors cursor-pointer"
            >
              {loading ? "Signing in..." : "Sign in"}
            </button>
          </form>
        </div>

        <p className="mt-4 text-center text-sm text-[#8b95a8]">
          Need an account?{" "}
          <Link href="/signup" className="text-[#3da8ff] hover:underline">
            Sign up
          </Link>
        </p>
      </div>
    </div>
  );
}
