"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { getBillingStatus, createCheckout, getBillingPortal } from "@/lib/api";
import type { BillingStatus } from "@/lib/types";
import {
  CreditCard,
  Crown,
  Shield,
  Check,
  ExternalLink,
} from "lucide-react";

export default function ConsumerBillingPage() {
  const { authenticated, loading: authLoading } = useAuth();
  const router = useRouter();

  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [upgrading, setUpgrading] = useState(false);

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

  async function handleUpgrade() {
    setUpgrading(true);
    try {
      const { checkout_url } = await createCheckout("consumer_pro");
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
          Manage your subscription plan
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-600/30 bg-red-900/20 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {loading ? (
        <div className="space-y-4">
          {[1, 2].map((i) => (
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
                billing.tier === "consumer_pro"
                  ? "bg-said-500/10 text-said-400 border border-said-500/20"
                  : "bg-gray-700 text-gray-300 border border-gray-600"
              }`}>
                {billing.tier === "consumer_pro" ? (
                  <Crown className="h-3.5 w-3.5" />
                ) : (
                  <Shield className="h-3.5 w-3.5" />
                )}
                {billing.tier === "consumer_pro" ? "Consumer Pro" : "Free"}
              </span>
              {billing.expires_at && (
                <span className="text-sm text-gray-500">
                  Renews {new Date(billing.expires_at).toLocaleDateString()}
                </span>
              )}
            </div>
            {billing.stripe_customer_id && (
              <button
                onClick={handleManageSubscription}
                className="inline-flex items-center gap-2 rounded-lg bg-gray-700 px-4 py-2 text-sm font-medium text-white hover:bg-gray-600 transition-colors cursor-pointer"
              >
                Manage Subscription
                <ExternalLink className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {/* Plans */}
          <div>
            <h2 className="text-lg font-semibold text-white mb-4">Choose Your Plan</h2>
            <div className="grid gap-4 sm:grid-cols-2">
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
                    Basic identity management
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-gray-500" />
                    Up to 5 agent connections
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-gray-500" />
                    Standard resolution
                  </li>
                </ul>
                <button
                  disabled
                  className="mt-6 w-full rounded-lg bg-gray-700 px-4 py-2 text-sm font-medium text-gray-400 cursor-not-allowed"
                >
                  {billing.tier === "free" ? "Current Plan" : "Free Tier"}
                </button>
              </div>

              {/* Consumer Pro Plan */}
              <div className="rounded-xl border-2 border-said-500 bg-gray-800 p-6 flex flex-col relative">
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <span className="rounded-full bg-said-500 px-3 py-0.5 text-xs font-semibold text-white">
                    Recommended
                  </span>
                </div>
                <div className="flex items-center gap-2 mb-2">
                  <Crown className="h-5 w-5 text-said-400" />
                  <h3 className="text-lg font-semibold text-white">Consumer Pro</h3>
                </div>
                <p className="text-3xl font-bold text-white mb-1">$9<span className="text-sm font-normal text-gray-500">/mo</span></p>
                <ul className="mt-4 space-y-2 text-sm text-gray-300 flex-1">
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-said-400" />
                    Unlimited agent connections
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-said-400" />
                    Identity analytics
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-said-400" />
                    Priority resolution
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-said-400" />
                    Advanced preferences
                  </li>
                </ul>
                {billing.tier === "consumer_pro" ? (
                  <button
                    disabled
                    className="mt-6 w-full rounded-lg bg-said-600/30 px-4 py-2 text-sm font-medium text-said-400 cursor-not-allowed"
                  >
                    Current Plan
                  </button>
                ) : (
                  <button
                    onClick={handleUpgrade}
                    disabled={upgrading}
                    className="mt-6 w-full rounded-lg bg-said-600 px-4 py-2 text-sm font-medium text-white hover:bg-said-500 transition-colors cursor-pointer disabled:opacity-50"
                  >
                    {upgrading ? "Redirecting..." : "Upgrade"}
                  </button>
                )}
              </div>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
