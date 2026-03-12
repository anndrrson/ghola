"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { getBillingStatus, getBillingPortal } from "@/lib/api";
import type { BillingStatus } from "@/lib/types";
import {
  CreditCard,
  Shield,
  ExternalLink,
  Activity,
} from "lucide-react";

export default function ConsumerBillingPage() {
  const { authenticated, loading: authLoading } = useAuth();
  const router = useRouter();

  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
          Your usage and billing details
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
            <div key={i} className="h-40 animate-pulse rounded-xl bg-[#161822]" />
          ))}
        </div>
      ) : billing ? (
        <>
          {/* Current Plan */}
          <div className="rounded-xl border border-[#1e2a3a] bg-[#161822] p-6">
            <h2 className="text-lg font-semibold text-[#eef1f8] mb-4">Current Plan</h2>
            <div className="flex items-center gap-3 mb-4">
              <span className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium bg-[#1c1f2e] text-[#8b95a8] border border-[#1e2a3a]">
                <Shield className="h-3.5 w-3.5" />
                Free — Pay as you grow
              </span>
            </div>
            <p className="text-sm text-[#4a5568]">
              1,000 free API calls/day. Beyond that, $0.001 per resolution, metered monthly.
            </p>
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

          {/* Usage */}
          {billing.usage && (
            <div className="rounded-xl border border-[#1e2a3a] bg-[#161822] p-6">
              <div className="flex items-center gap-2 mb-4">
                <Activity className="h-5 w-5 text-[#3da8ff]" />
                <h2 className="text-lg font-semibold text-[#eef1f8]">Today&apos;s Usage</h2>
              </div>
              <div className="mb-3">
                <div className="flex justify-between text-sm mb-1.5">
                  <span className="text-[#8b95a8]">API calls</span>
                  <span className="text-[#eef1f8] font-medium">
                    {billing.usage.api_calls_today.toLocaleString()} / {billing.usage.limit.toLocaleString()}
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
              </div>
              {usagePercent >= 100 && (
                <p className="text-xs text-yellow-400 mt-2">
                  Free tier exceeded. Additional calls are billed at $0.001 each.
                </p>
              )}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
