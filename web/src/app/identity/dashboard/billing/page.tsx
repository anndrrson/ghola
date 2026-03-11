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
  Crown,
  Shield,
  Check,
  ExternalLink,
  BadgeCheck,
  Building2,
  Sparkles,
} from "lucide-react";

const TIER_LABELS: Record<string, string> = {
  free: "Free",
  business: "Business",
  enterprise: "Enterprise",
};

export default function BillingPage() {
  const { authenticated, loading: authLoading } = useAuth();
  const router = useRouter();

  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [upgrading, setUpgrading] = useState(false);
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

  async function handleUpgrade(tier: string) {
    setUpgrading(true);
    try {
      const { checkout_url } = await createCheckout(tier);
      window.location.href = checkout_url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create checkout");
      setUpgrading(false);
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
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-said-500 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2">
          <CreditCard className="h-6 w-6 text-said-400" />
          <h1 className="text-2xl font-bold text-white">Billing</h1>
        </div>
        <p className="mt-1 text-gray-400">
          Manage your subscription and billing details
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
            <div key={i} className="h-40 animate-pulse rounded-xl bg-gray-800" />
          ))}
        </div>
      ) : billing ? (
        <>
          {/* Current Plan */}
          <div className="rounded-xl border border-gray-700 bg-gray-800 p-6">
            <h2 className="text-lg font-semibold text-white mb-4">Current Plan</h2>
            <div className="flex items-center gap-3 mb-4">
              <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium ${
                billing.tier === "enterprise"
                  ? "bg-said-500/10 text-said-400 border border-said-500/20"
                  : billing.tier === "business"
                  ? "bg-said-500/10 text-said-400 border border-said-500/20"
                  : "bg-gray-700 text-gray-300 border border-gray-600"
              }`}>
                {billing.tier === "enterprise" ? (
                  <Sparkles className="h-3.5 w-3.5" />
                ) : billing.tier === "business" ? (
                  <Crown className="h-3.5 w-3.5" />
                ) : (
                  <Shield className="h-3.5 w-3.5" />
                )}
                {TIER_LABELS[billing.tier] || billing.tier}
              </span>
              {billing.expires_at && (
                <span className="text-sm text-gray-500">
                  Renews {new Date(billing.expires_at).toLocaleDateString()}
                </span>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg bg-gray-900/50 border border-gray-700/50 p-3">
                <p className="text-xs text-gray-500 uppercase tracking-wider">Resolves / Day</p>
                <p className="mt-1 text-lg font-semibold text-white">
                  {billing.limits.resolve_per_day.toLocaleString()}
                </p>
              </div>
              <div className="rounded-lg bg-gray-900/50 border border-gray-700/50 p-3">
                <p className="text-xs text-gray-500 uppercase tracking-wider">Profiles</p>
                <p className="mt-1 text-lg font-semibold text-white">
                  {billing.limits.profiles}
                </p>
              </div>
              <div className="rounded-lg bg-gray-900/50 border border-gray-700/50 p-3">
                <p className="text-xs text-gray-500 uppercase tracking-wider">Analytics</p>
                <p className="mt-1 text-lg font-semibold text-white">
                  {billing.limits.analytics ? "Full" : "Basic"}
                </p>
              </div>
            </div>
            {billing.stripe_customer_id && (
              <button
                onClick={handleManageSubscription}
                className="mt-4 inline-flex items-center gap-2 rounded-lg bg-gray-700 px-4 py-2 text-sm font-medium text-white hover:bg-gray-600 transition-colors cursor-pointer"
              >
                Manage Subscription
                <ExternalLink className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {/* Upgrade Section */}
          {billing.tier !== "enterprise" && (
            <div>
              <h2 className="text-lg font-semibold text-white mb-4">Upgrade Your Plan</h2>
              <div className="grid gap-4 sm:grid-cols-3">
                {/* Free Plan */}
                <div className="rounded-xl border border-gray-700 bg-gray-800 p-6 flex flex-col">
                  <div className="flex items-center gap-2 mb-2">
                    <Shield className="h-5 w-5 text-gray-400" />
                    <h3 className="text-lg font-semibold text-white">Free</h3>
                  </div>
                  <p className="text-3xl font-bold text-white mb-1">$0<span className="text-sm font-normal text-gray-500">/mo</span></p>
                  <ul className="mt-4 space-y-2 text-sm text-gray-400 flex-1">
                    <li className="flex items-center gap-2">
                      <Check className="h-4 w-4 text-gray-500" />
                      1,000 resolves/day
                    </li>
                    <li className="flex items-center gap-2">
                      <Check className="h-4 w-4 text-gray-500" />
                      Basic analytics
                    </li>
                    <li className="flex items-center gap-2">
                      <Check className="h-4 w-4 text-gray-500" />
                      1 profile
                    </li>
                  </ul>
                  <button
                    disabled
                    className="mt-6 w-full rounded-lg bg-gray-700 px-4 py-2 text-sm font-medium text-gray-400 cursor-not-allowed"
                  >
                    {billing.tier === "free" ? "Current Plan" : "Downgrade"}
                  </button>
                </div>

                {/* Business Plan */}
                <div className="rounded-xl border-2 border-said-500 bg-gray-800 p-6 flex flex-col relative">
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <span className="rounded-full bg-said-500 px-3 py-0.5 text-xs font-semibold text-white">
                      Recommended
                    </span>
                  </div>
                  <div className="flex items-center gap-2 mb-2">
                    <Crown className="h-5 w-5 text-said-400" />
                    <h3 className="text-lg font-semibold text-white">Business</h3>
                  </div>
                  <p className="text-3xl font-bold text-white mb-1">$29<span className="text-sm font-normal text-gray-500">/mo</span></p>
                  <ul className="mt-4 space-y-2 text-sm text-gray-300 flex-1">
                    <li className="flex items-center gap-2">
                      <Check className="h-4 w-4 text-said-400" />
                      50,000 resolves/day
                    </li>
                    <li className="flex items-center gap-2">
                      <Check className="h-4 w-4 text-said-400" />
                      Full analytics
                    </li>
                    <li className="flex items-center gap-2">
                      <Check className="h-4 w-4 text-said-400" />
                      Verified badge eligible
                    </li>
                    <li className="flex items-center gap-2">
                      <Check className="h-4 w-4 text-said-400" />
                      Priority support
                    </li>
                  </ul>
                  {billing.tier === "business" ? (
                    <button
                      disabled
                      className="mt-6 w-full rounded-lg bg-said-600/30 px-4 py-2 text-sm font-medium text-said-400 cursor-not-allowed"
                    >
                      Current Plan
                    </button>
                  ) : (
                    <button
                      onClick={() => handleUpgrade("business")}
                      disabled={upgrading}
                      className="mt-6 w-full rounded-lg bg-said-600 px-4 py-2 text-sm font-medium text-white hover:bg-said-500 transition-colors cursor-pointer disabled:opacity-50"
                    >
                      {upgrading ? "Redirecting..." : "Upgrade"}
                    </button>
                  )}
                </div>

                {/* Enterprise Plan */}
                <div className="rounded-xl border border-gray-600 bg-gradient-to-br from-gray-800 to-gray-800/80 p-6 flex flex-col">
                  <div className="flex items-center gap-2 mb-2">
                    <Building2 className="h-5 w-5 text-said-400" />
                    <h3 className="text-lg font-semibold text-white">Enterprise</h3>
                  </div>
                  <p className="text-3xl font-bold text-white mb-1">Custom</p>
                  <ul className="mt-4 space-y-2 text-sm text-gray-300 flex-1">
                    <li className="flex items-center gap-2">
                      <Check className="h-4 w-4 text-said-400" />
                      Unlimited resolves
                    </li>
                    <li className="flex items-center gap-2">
                      <Check className="h-4 w-4 text-said-400" />
                      Full analytics + SSO
                    </li>
                    <li className="flex items-center gap-2">
                      <Check className="h-4 w-4 text-said-400" />
                      Dedicated support + SLA
                    </li>
                    <li className="flex items-center gap-2">
                      <Check className="h-4 w-4 text-said-400" />
                      Unlimited profiles
                    </li>
                  </ul>
                  <a
                    href="mailto:sales@said.dev"
                    className="mt-6 w-full rounded-lg border border-said-500/30 bg-said-500/10 px-4 py-2 text-sm font-medium text-said-300 hover:bg-said-500/20 transition-colors text-center cursor-pointer block"
                  >
                    Contact Sales
                  </a>
                </div>
              </div>
            </div>
          )}

          {/* Verified Badge Section — business tier only */}
          {(billing.tier === "business" || billing.tier === "enterprise") && (
            <div className="rounded-xl border border-gray-700 bg-gray-800 p-6">
              <div className="flex items-center gap-2 mb-1">
                <BadgeCheck className="h-5 w-5 text-said-400" />
                <h2 className="text-lg font-semibold text-white">Verified Badge</h2>
              </div>
              <p className="text-sm text-gray-500 mb-4">
                $99/yr — includes manual review and on-chain attestation
              </p>

              {badgeMessage && (
                <div className="mb-4 rounded-lg border border-said-600/30 bg-said-900/20 px-4 py-3 text-sm text-said-300">
                  {badgeMessage}
                </div>
              )}

              <div className="space-y-3">
                <textarea
                  value={badgeNotes}
                  onChange={(e) => setBadgeNotes(e.target.value)}
                  placeholder="Optional: Tell us about your business for faster verification..."
                  rows={3}
                  className="w-full rounded-lg border border-gray-700 bg-gray-900 px-4 py-3 text-sm text-white placeholder-gray-500 focus:border-said-500 focus:ring-1 focus:ring-said-500 focus:outline-none"
                />
                <button
                  onClick={handleRequestBadge}
                  disabled={badgeSubmitting}
                  className="inline-flex items-center gap-2 rounded-lg bg-said-600 px-4 py-2 text-sm font-medium text-white hover:bg-said-500 transition-colors cursor-pointer disabled:opacity-50"
                >
                  <BadgeCheck className="h-4 w-4" />
                  {badgeSubmitting ? "Submitting..." : "Request Verification"}
                </button>
              </div>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
