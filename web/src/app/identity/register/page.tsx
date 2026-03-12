"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { register, registerConsumer } from "@/lib/api";
import { BUSINESS_CATEGORIES } from "@/lib/types";
import { Shield, Building2, User } from "lucide-react";

type AccountType = "business" | "individual";

export default function RegisterPage() {
  const router = useRouter();
  const { setAuth } = useAuth();

  const [accountType, setAccountType] = useState<AccountType>("individual");

  // Shared fields
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  // Individual fields
  const [displayName, setDisplayName] = useState("");

  // Business fields
  const [businessName, setBusinessName] = useState("");
  const [category, setCategory] = useState("");
  const [website, setWebsite] = useState("");

  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");

    // Shared validation
    if (!email || !password || !confirmPassword) {
      setError("Please fill in all required fields.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    if (accountType === "individual") {
      if (!displayName) {
        setError("Please enter your display name.");
        return;
      }
    } else {
      if (!businessName || !category || !website) {
        setError("Please fill in all business fields.");
        return;
      }
    }

    setSubmitting(true);
    try {
      if (accountType === "individual") {
        const res = await registerConsumer({
          email,
          password,
          display_name: displayName,
        });
        setAuth(res.user);
        router.push("/identity/consumer/dashboard");
      } else {
        const res = await register({
          email,
          password,
          business_name: businessName,
          category,
          website,
        });
        setAuth(res.user);
        router.push("/identity/dashboard");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen pt-16 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-8">
          {/* Header */}
          <div className="mb-8 text-center">
            <div className="mx-auto mb-4 inline-flex h-12 w-12 items-center justify-center rounded-lg bg-[#3da8ff]/10 text-[#3da8ff]">
              <Shield className="h-6 w-6" />
            </div>
            <h1 className="text-2xl font-bold text-[#eef1f8]">
              Create your Ghola
            </h1>
            <p className="mt-2 text-sm text-[#8b95a8]">
              {accountType === "business"
                ? "Set up your business for the agentic web."
                : "Own your identity across AI services."}
            </p>
          </div>

          {/* Account type toggle */}
          <div className="mb-6 flex rounded-lg border border-[#1e2a3a] bg-[#161822] p-1">
            <button
              type="button"
              onClick={() => setAccountType("individual")}
              className={`flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors cursor-pointer ${
                accountType === "individual"
                  ? "bg-[#3da8ff] text-[#08090d]"
                  : "text-[#8b95a8] hover:text-[#eef1f8]"
              }`}
            >
              <User className="h-4 w-4" />
              I&apos;m an Individual
            </button>
            <button
              type="button"
              onClick={() => setAccountType("business")}
              className={`flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors cursor-pointer ${
                accountType === "business"
                  ? "bg-[#3da8ff] text-[#08090d]"
                  : "text-[#8b95a8] hover:text-[#eef1f8]"
              }`}
            >
              <Building2 className="h-4 w-4" />
              I&apos;m a Business
            </button>
          </div>

          {/* Error */}
          {error && (
            <div className="mb-6 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              {error}
            </div>
          )}

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Account section */}
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-[#4a5568] mb-3">
                Account
              </p>
              <div className="space-y-4">
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
                    placeholder={
                      accountType === "business"
                        ? "you@company.com"
                        : "you@example.com"
                    }
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
                    placeholder="Min. 8 characters"
                    autoComplete="new-password"
                    className="w-full rounded-lg border border-[#1e2a3a] bg-[#161822] px-4 py-2.5 text-sm text-[#eef1f8] placeholder-[#4a5568] focus:border-[#3da8ff] focus:ring-1 focus:ring-[#3da8ff] outline-none transition-colors"
                  />
                </div>
                <div>
                  <label
                    htmlFor="confirm-password"
                    className="block text-sm font-medium text-[#8b95a8] mb-1.5"
                  >
                    Confirm Password
                  </label>
                  <input
                    id="confirm-password"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Re-enter password"
                    autoComplete="new-password"
                    className="w-full rounded-lg border border-[#1e2a3a] bg-[#161822] px-4 py-2.5 text-sm text-[#eef1f8] placeholder-[#4a5568] focus:border-[#3da8ff] focus:ring-1 focus:ring-[#3da8ff] outline-none transition-colors"
                  />
                </div>
              </div>
            </div>

            {/* Divider */}
            <div className="border-t border-[#1e2a3a]" />

            {/* Individual section */}
            {accountType === "individual" && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-[#4a5568] mb-3">
                  Profile
                </p>
                <div className="space-y-4">
                  <div>
                    <label
                      htmlFor="display-name"
                      className="block text-sm font-medium text-[#8b95a8] mb-1.5"
                    >
                      Display Name
                    </label>
                    <input
                      id="display-name"
                      type="text"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder="How AI agents should address you"
                      className="w-full rounded-lg border border-[#1e2a3a] bg-[#161822] px-4 py-2.5 text-sm text-[#eef1f8] placeholder-[#4a5568] focus:border-[#3da8ff] focus:ring-1 focus:ring-[#3da8ff] outline-none transition-colors"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Business section */}
            {accountType === "business" && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-[#4a5568] mb-3">
                  Business
                </p>
                <div className="space-y-4">
                  <div>
                    <label
                      htmlFor="business-name"
                      className="block text-sm font-medium text-[#8b95a8] mb-1.5"
                    >
                      Business Name
                    </label>
                    <input
                      id="business-name"
                      type="text"
                      value={businessName}
                      onChange={(e) => setBusinessName(e.target.value)}
                      placeholder="Acme Inc."
                      className="w-full rounded-lg border border-[#1e2a3a] bg-[#161822] px-4 py-2.5 text-sm text-[#eef1f8] placeholder-[#4a5568] focus:border-[#3da8ff] focus:ring-1 focus:ring-[#3da8ff] outline-none transition-colors"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="category"
                      className="block text-sm font-medium text-[#8b95a8] mb-1.5"
                    >
                      Category
                    </label>
                    <select
                      id="category"
                      value={category}
                      onChange={(e) => setCategory(e.target.value)}
                      className="w-full rounded-lg border border-[#1e2a3a] bg-[#161822] px-4 py-2.5 text-sm text-[#eef1f8] focus:border-[#3da8ff] focus:ring-1 focus:ring-[#3da8ff] outline-none transition-colors appearance-none cursor-pointer"
                    >
                      <option value="" disabled>
                        Select a category
                      </option>
                      {BUSINESS_CATEGORIES.map((cat) => (
                        <option key={cat.value} value={cat.value}>
                          {cat.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label
                      htmlFor="website"
                      className="block text-sm font-medium text-[#8b95a8] mb-1.5"
                    >
                      Website
                    </label>
                    <input
                      id="website"
                      type="url"
                      value={website}
                      onChange={(e) => setWebsite(e.target.value)}
                      placeholder="https://acme.com"
                      className="w-full rounded-lg border border-[#1e2a3a] bg-[#161822] px-4 py-2.5 text-sm text-[#eef1f8] placeholder-[#4a5568] focus:border-[#3da8ff] focus:ring-1 focus:ring-[#3da8ff] outline-none transition-colors"
                    />
                  </div>
                </div>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-lg bg-[#3da8ff] px-4 py-2.5 text-sm font-semibold text-[#08090d] hover:bg-[#5bb8ff] disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98] transition-all cursor-pointer"
            >
              {submitting ? "Creating identity..." : "Create Identity"}
            </button>
          </form>

          {/* Footer link */}
          <p className="mt-6 text-center text-sm text-[#8b95a8]">
            Already have an account?{" "}
            <Link
              href="/identity/login"
              className="font-medium text-[#3da8ff] hover:text-[#5bb8ff] transition-colors"
            >
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
