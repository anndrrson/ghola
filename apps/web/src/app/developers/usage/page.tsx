"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, BarChart3 } from "lucide-react";
import { useThumperAuth } from "@/lib/thumper-auth-context";
import { getApiUsage } from "@/lib/thumper-api";
import type { ThumperApiUsageResponse } from "@/lib/thumper-types";

export default function UsagePage() {
  const { authenticated, loading } = useThumperAuth();
  const router = useRouter();
  const [usage, setUsage] = useState<ThumperApiUsageResponse | null>(null);
  const [loadingUsage, setLoadingUsage] = useState(true);

  useEffect(() => {
    if (!loading && !authenticated) {
      router.push("/signin");
    }
  }, [authenticated, loading, router]);

  useEffect(() => {
    if (authenticated) {
      getApiUsage()
        .then(setUsage)
        .catch(() => {})
        .finally(() => setLoadingUsage(false));
    }
  }, [authenticated]);

  if (loading || !authenticated) return null;

  return (
    <div className="min-h-screen bg-[#08090d] pt-16">
      <div className="mx-auto max-w-2xl px-4 py-8">
        {/* Header */}
        <div className="flex items-center gap-3 mb-8">
          <Link
            href="/developers"
            className="p-1.5 rounded-lg text-[#8b95a8] hover:text-[#eef1f8] hover:bg-[#161822] transition-colors"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <BarChart3 className="h-5 w-5 text-[#3da8ff]" />
          <h1 className="text-lg font-semibold text-[#eef1f8]">API Usage</h1>
        </div>

        {loadingUsage ? (
          <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5 text-center text-sm text-[#4a5568]">
            Loading usage data...
          </div>
        ) : usage ? (
          <div className="space-y-6">
            {/* API Calls */}
            <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
              <div className="flex items-baseline justify-between mb-4">
                <h3 className="text-sm font-medium text-[#eef1f8]">
                  API Calls
                </h3>
                <span className="text-sm text-[#8b95a8]">
                  {usage.api_call_count.toLocaleString()} /{" "}
                  {usage.api_call_limit === 2147483647
                    ? "Unlimited"
                    : usage.api_call_limit.toLocaleString()}
                </span>
              </div>
              <UsageBar
                used={usage.api_call_count}
                limit={
                  usage.api_call_limit === 2147483647
                    ? usage.api_call_count + 1000
                    : usage.api_call_limit
                }
              />
              <p className="mt-2 text-xs text-[#4a5568]">
                This billing period
              </p>
            </div>

            {/* Tokens */}
            <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
              <div className="flex items-baseline justify-between mb-4">
                <h3 className="text-sm font-medium text-[#eef1f8]">
                  Tokens Used
                </h3>
                <span className="text-sm text-[#8b95a8]">
                  {usage.api_token_count.toLocaleString()}
                </span>
              </div>
              <p className="text-xs text-[#4a5568]">
                Total tokens consumed across all API calls
              </p>
            </div>

            {/* Other Usage */}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
                <div className="flex items-baseline justify-between mb-3">
                  <h3 className="text-sm font-medium text-[#eef1f8]">
                    Phone Calls
                  </h3>
                  <span className="text-sm text-[#8b95a8]">
                    {usage.call_count} / {usage.call_limit}
                  </span>
                </div>
                <UsageBar used={usage.call_count} limit={usage.call_limit} />
              </div>
              <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
                <div className="flex items-baseline justify-between mb-3">
                  <h3 className="text-sm font-medium text-[#eef1f8]">
                    Emails
                  </h3>
                  <span className="text-sm text-[#8b95a8]">
                    {usage.email_count} / {usage.email_limit}
                  </span>
                </div>
                <UsageBar used={usage.email_count} limit={usage.email_limit} />
              </div>
            </div>

            {/* Tier info */}
            <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
              <h3 className="text-sm font-medium text-[#eef1f8] mb-3">
                API Limits by Tier
              </h3>
              <div className="grid grid-cols-4 gap-2 text-xs">
                <div className="text-[#4a5568]">Tier</div>
                <div className="text-[#4a5568] text-center">API Calls/mo</div>
                <div className="text-[#4a5568] text-center">Phone Calls</div>
                <div className="text-[#4a5568] text-center">Emails</div>

                <div className="text-[#8b95a8]">Free</div>
                <div className="text-[#8b95a8] text-center">100</div>
                <div className="text-[#8b95a8] text-center">5</div>
                <div className="text-[#8b95a8] text-center">10</div>

                <div className="text-[#8b95a8]">Pro</div>
                <div className="text-[#8b95a8] text-center">10,000</div>
                <div className="text-[#8b95a8] text-center">30</div>
                <div className="text-[#8b95a8] text-center">50</div>

                <div className="text-[#8b95a8]">Unlimited</div>
                <div className="text-[#8b95a8] text-center">100,000</div>
                <div className="text-[#8b95a8] text-center">999</div>
                <div className="text-[#8b95a8] text-center">999</div>

                <div className="text-[#3da8ff]">Enterprise</div>
                <div className="text-[#3da8ff] text-center">Unlimited</div>
                <div className="text-[#3da8ff] text-center">Unlimited</div>
                <div className="text-[#3da8ff] text-center">Unlimited</div>
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5 text-center text-sm text-[#4a5568]">
            Failed to load usage data
          </div>
        )}
      </div>
    </div>
  );
}

function UsageBar({ used, limit }: { used: number; limit: number }) {
  const pct = limit > 0 ? Math.min((used / limit) * 100, 100) : 0;
  return (
    <div className="h-2 rounded-full bg-[#161822] overflow-hidden">
      <div
        className={`h-full rounded-full transition-all ${
          pct > 90
            ? "bg-red-400"
            : pct > 70
              ? "bg-yellow-400"
              : "bg-[#3da8ff]"
        }`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
