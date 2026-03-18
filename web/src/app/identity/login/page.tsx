"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { login } from "@/lib/api";
import { LogIn } from "lucide-react";

export default function LoginPage() {
  const router = useRouter();
  const { setAuth } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");

    if (!email || !password) {
      setError("Please fill in all fields.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await login({ email, password });
      setAuth(res.user);
      router.push("/identity/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen pt-16 flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-8">
          {/* Header */}
          <div className="mb-8 text-center">
            <div className="mx-auto mb-4 inline-flex h-12 w-12 items-center justify-center rounded-lg bg-[#3da8ff]/10 text-[#3da8ff]">
              <LogIn className="h-6 w-6" />
            </div>
            <h1 className="text-2xl font-bold text-[#eef1f8]">Sign in to ghola</h1>
            <p className="mt-2 text-sm text-[#8b95a8]">
              Access your identity dashboard.
            </p>
          </div>

          {/* Error */}
          {error && (
            <div className="mb-6 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              {error}
            </div>
          )}

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label
                htmlFor="email"
                className="block text-sm font-medium text-[#8b95a8] mb-1.5"
              >
                Email
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                autoComplete="email"
                className="w-full rounded-lg border border-[#1e2a3a] bg-[#161822] px-4 py-2.5 text-sm text-[#eef1f8] placeholder-[#4a5568] focus:border-[#3da8ff] focus:ring-1 focus:ring-[#3da8ff] outline-none transition-colors"
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-[#8b95a8] mb-1.5"
              >
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
                className="w-full rounded-lg border border-[#1e2a3a] bg-[#161822] px-4 py-2.5 text-sm text-[#eef1f8] placeholder-[#4a5568] focus:border-[#3da8ff] focus:ring-1 focus:ring-[#3da8ff] outline-none transition-colors"
              />
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-lg bg-[#3da8ff] px-4 py-2.5 text-sm font-semibold text-[#08090d] hover:bg-[#5bb8ff] disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98] transition-all cursor-pointer"
            >
              {submitting ? "Signing in..." : "Sign In"}
            </button>
          </form>

          {/* Footer link */}
          <p className="mt-6 text-center text-sm text-[#8b95a8]">
            Don&apos;t have an account?{" "}
            <Link
              href="/identity/register"
              className="font-medium text-[#3da8ff] hover:text-[#5bb8ff] transition-colors"
            >
              Sign up
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
