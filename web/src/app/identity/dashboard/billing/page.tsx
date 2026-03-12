"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import {
  getBillingStatus,
  createCheckout,
  getBillingPortal,
  requestBadge,
} from "@/lib/api";
import type { BillingStatus } from "@/lib/types";
import {
  CreditCard,
  Shield,
  Check,
  ExternalLink,
  BadgeCheck,
  Globe,
  Activity,
} from "lucide-react";

export default function BillingPage() {
  const { authenticated, loading: authLoading } = useAuth();
  const router = useRouter();

  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [purchasing, setPurchasing] = useState(false);
  const [badgeNotes, setBadgeNotes] = useState("");
  const [badgeSubmitting, setBadgeSubmitting] = useState(false);
  const [badgeMessage, setBadgeMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !authenticated) {
      router.push("/identity/login");
    }
  }, [authLoading, authenticated, router]);

  useEffect(() => {
    if (!authenticated) return;
    setLoading(true);
    getBillingStatus()
      .then(setBilling)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [authenticated]);

  async function handlePurchase(product: string) {
    setPurchasing(true);
    try {
      const { checkout_url } = await createCheckout(product);
      window.location.href = checkout_url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create checkout");
      setPurchasing(false);
    }
  }

  async function handleManageSubscription() {
    try {
      const { portal_url } = await getBillingPortal();
      window.location.href = portal_url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open billing portal");
    }
  }

  async function handleRequestBadge() {
    setBadgeSubmitting(true);
    setBadgeMessage(null);
    try {
      const res = await requestBadge(badgeNotes);
      setBadgeMessage(res.message);
      setBadgeNotes("");
    } catch (err) {
      setBadgeMessage(err instanceof Error ? err.message : "Failed to request badge");
    } finally {
      setBadgeSubmitting(false);
    }
  }

  if (authLoading || !authenticated) {
    return (
      <div className="flex h-screen items-center justify-center pt-16">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#3da8ff] border-t-transparent" />
      </div>
    );
  }

  const usagePercent = billing?.usage
    ? Math.min(100, (billing.usage.api_calls_today / billing.usage.limit) * 100)
    : 0;

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2">
          <CreditCard className="h-6 w-6 text-[#3da8ff]" />
          <h1 className="text-2xl font-bold text-[#eef1f8]">Billing</h1>
        </div>
        <p className="mt-1 text-[#8b95a8]">
          Usage, verification purchases, and billing management
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-600/30 bg-red-900/20 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {loading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-40 animate-pulse rounded-xl bg-[#161822]" />
          ))}
        </div>
      ) : billing ? (
        <>
          {/* Current Plan + Usage */}
          <div className="rounded-xl border border-[#1e2a3a] bg-[#161822] p-6">
            <h2 className="text-lg font-semibold text-[#eef1f8] mb-4">Plan & Usage</h2>
            <div className="flex items-center gap-3 mb-4">
              <span className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium bg-[#1c1f2e] text-[#8b95a8] border border-[#1e2a3a]">
                <Shield className="h-3.5 w-3.5" />
                Free — Pay as you grow
              </span>
            </div>

            {/* Usage bar */}
            {billing.usage && (
              <div className="mb-4">
                <div className="flex items-center gap-2 mb-2">
                  <Activity className="h-4 w-4 text-[#3da8ff]" />
                  <span className="text-sm font-medium text-[#eef1f8]">Today&apos;s API Usage</span>
                </div>
                <div className="flex justify-between text-sm mb-1.5">
                  <span className="text-[#8b95a8]">
                    {billing.usage.api_calls_today.toLocaleString()} calls
                  </span>
                  <span className="text-[#4a5568]">
                    {billing.usage.limit.toLocaleString()} free/day
                  </span>
                </div>
                <div className="h-2 rounded-full bg-[#1e2a3a] overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      usagePercent > 90 ? "bg-red-500" : usagePercent > 70 ? "bg-yellow-500" : "bg-[#3da8ff]"
                    }`}
                    style={{ width: `${usagePercent}%` }}
                  />
                </div>
                {usagePercent >= 100 && (
                  <p className="text-xs text-yellow-400 mt-2">
                    Free tier exceeded. Additional calls billed at $0.001 each.
                  </p>
                )}
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg bg-[#0f1117] border border-[#1e2a3a]/50 p-3">
                <p className="text-xs text-[#4a5568] uppercase tracking-wider">Free Calls / Day</p>
                <p className="mt-1 text-lg font-semibold text-[#eef1f8]">
                  {billing.limits.resolve_per_day.toLocaleString()}
                </p>
              </div>
              <div className="rounded-lg bg-[#0f1117] border border-[#1e2a3a]/50 p-3">
                <p className="text-xs text-[#4a5568] uppercase tracking-wider">Overage Rate</p>
                <p className="mt-1 text-lg font-semibold text-[#eef1f8]">$0.001</p>
              </div>
              <div className="rounded-lg bg-[#0f1117] border border-[#1e2a3a]/50 p-3">
                <p className="text-xs text-[#4a5568] uppercase tracking-wider">Analytics</p>
                <p className="mt-1 text-lg font-semibold text-[#eef1f8]">
                  {billing.limits.analytics ? "Full" : "Basic"}
                </p>
              </div>
            </div>

            {billing.stripe_customer_id && (
              <button
                onClick={handleManageSubscription}
                className="mt-4 inline-flex items-center gap-2 rounded-lg bg-[#1c1f2e] px-4 py-2 text-sm font-medium text-[#eef1f8] hover:bg-[#2a3a50] transition-colors cursor-pointer"
              >
                Manage Billing
                <ExternalLink className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {/* Verification Purchases */}
          <div>
            <h2 className="text-lg font-semibold text-[#eef1f8] mb-4">Verification & Trust</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              {/* Domain Verification */}
              <div className="rounded-xl border border-[#1e2a3a] bg-[#161822] p-6 flex flex-col">
                <div className="flex items-center gap-2 mb-2">
                  <Globe className="h-5 w-5 text-[#3da8ff]" />
                  <h3 className="text-lg font-semibold text-[#eef1f8]">Domain Verification</h3>
                </div>
                <p className="text-3xl font-bold text-[#eef1f8] mb-1">
                  $29<span className="text-sm font-normal text-[#4a5568]"> one-time</span>
                </p>
                <ul className="mt-4 space-y-2 text-sm text-[#8b95a8] flex-1">
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-[#3da8ff]" />
                    Prove domain ownership
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-[#3da8ff]" />
                    DNS or well-known verification
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-[#3da8ff]" />
                    Trust signal in agents.txt
                  </li>
                </ul>
                <button
                  onClick={() => handlePurchase("domain_verification")}
                  disabled={purchasing}
                  className="mt-6 w-full rounded-lg bg-[#1c1f2e] border border-[#1e2a3a] px-4 py-2 text-sm font-medium text-[#eef1f8] hover:bg-[#2a3a50] transition-colors cursor-pointer disabled:opacity-50"
                >
                  {purchasing ? "Redirecting..." : "Purchase"}
                </button>
              </div>

              {/* Verified Badge */}
              <div className="rounded-xl border-2 border-[#3da8ff] bg-[#161822] p-6 flex flex-col relative">
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <span className="rounded-full bg-[#3da8ff] px-3 py-0.5 text-xs font-semibold text-[#eef1f8]">
                    Recommended
                  </span>
                </div>
                <div className="flex items-center gap-2 mb-2">
                  <BadgeCheck className="h-5 w-5 text-[#3da8ff]" />
                  <h3 className="text-lg font-semibold text-[#eef1f8]">Verified Badge</h3>
                </div>
                <p className="text-3xl font-bold text-[#eef1f8] mb-1">
                  $99<span className="text-sm font-normal text-[#4a5568]">/year</span>
                </p>
                <ul className="mt-4 space-y-2 text-sm text-[#8b95a8] flex-1">
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-[#3da8ff]" />
                    Verified badge for AI agents
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-[#3da8ff]" />
                    On-chain attestation
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-[#3da8ff]" />
                    Priority in discovery
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-[#3da8ff]" />
                    Manual review included
                  </li>
                </ul>
                <button
                  onClick={() => handlePurchase("verified_badge")}
                  disabled={purchasing}
                  className="mt-6 w-full rounded-lg bg-[#2b96f0] px-4 py-2 text-sm font-medium text-[#eef1f8] hover:bg-[#3da8ff] transition-colors cursor-pointer disabled:opacity-50"
                >
                  {purchasing ? "Redirecting..." : "Purchase"}
                </button>
              </div>
            </div>
          </div>

          {/* Badge Request Section */}
          <div className="rounded-xl border border-[#1e2a3a] bg-[#161822] p-6">
            <div className="flex items-center gap-2 mb-1">
              <BadgeCheck className="h-5 w-5 text-[#3da8ff]" />
              <h2 className="text-lg font-semibold text-[#eef1f8]">Request Verification Review</h2>
            </div>
            <p className="text-sm text-[#4a5568] mb-4">
              Already purchased? Submit your business details for manual review.
            </p>

            {badgeMessage && (
              <div className="mb-4 rounded-lg border border-[#2b96f0]/30 bg-[#0a1929]/20 px-4 py-3 text-sm text-[#5bb8ff]">
                {badgeMessage}
              </div>
            )}

            <div className="space-y-3">
              <textarea
                value={badgeNotes}
                onChange={(e) => setBadgeNotes(e.target.value)}
                placeholder="Tell us about your business for faster verification..."
                rows={3}
                className="w-full rounded-lg border border-[#1e2a3a] bg-[#0f1117] px-4 py-3 text-sm text-[#eef1f8] placeholder-[#4a5568] focus:border-[#3da8ff] focus:ring-1 focus:ring-[#3da8ff] focus:outline-none"
              />
              <button
                onClick={handleRequestBadge}
                disabled={badgeSubmitting}
                className="inline-flex items-center gap-2 rounded-lg bg-[#2b96f0] px-4 py-2 text-sm font-medium text-[#eef1f8] hover:bg-[#3da8ff] transition-colors cursor-pointer disabled:opacity-50"
              >
                <BadgeCheck className="h-4 w-4" />
                {badgeSubmitting ? "Submitting..." : "Submit for Review"}
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
