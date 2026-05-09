"use client";

import { useEffect, useState } from "react";
import { getCreatorStats, getCreatorModels } from "@/lib/api";
import type { CreatorStats, Model } from "@/lib/types";
import { useWalletAuth } from "@/lib/wallet-provider";
import Link from "next/link";
import { Plus, BarChart3, MessageSquare, DollarSign, Bot } from "lucide-react";
import { useRouter } from "next/navigation";

const formatPrice = (microUsdc: number) => {
  const usd = microUsdc / 1_000_000;
  if (usd === 0) return "Free";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
};

export default function CreatorDashboard() {
  const { authenticated, isCreator } = useWalletAuth();
  const router = useRouter();
  const [stats, setStats] = useState<CreatorStats | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!authenticated) return;
    Promise.all([getCreatorStats(), getCreatorModels()])
      .then(([s, m]) => {
        setStats(s);
        setModels(m);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [authenticated]);

  if (!authenticated) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-16 text-center">
        <h1 className="mb-4 text-2xl font-bold">Creator Dashboard</h1>
        <p className="text-[#8b95a8]">Connect your wallet to access your dashboard.</p>
      </div>
    );
  }

  if (!isCreator) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-16 text-center">
        <h1 className="mb-4 text-2xl font-bold">Become a Creator</h1>
        <p className="mb-6 text-[#8b95a8]">
          Creator accounts are currently invite-only. Check back soon!
        </p>
        <button
          onClick={() => router.push("/")}
          className="rounded-xl bg-[#5bb8ff] px-6 py-2.5 text-sm font-semibold text-[#eef1f8] hover:bg-[#3da8ff]"
        >
          Back to Home
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-3xl font-bold">Creator Dashboard</h1>
        <Link
          href="/models/creator/new"
          className="inline-flex items-center gap-2 rounded-xl bg-[#3da8ff] px-5 py-2.5 text-sm font-semibold text-[#eef1f8] hover:bg-[#5bb8ff] transition-colors"
        >
          <Plus className="h-4 w-4" />
          Create Model
        </Link>
      </div>

      {/* Stats */}
      {loading ? (
        <div className="mb-8 grid gap-4 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-28 animate-pulse rounded-xl bg-[#0f1117]" />
          ))}
        </div>
      ) : (
        stats && (
          <div className="mb-8 grid gap-4 md:grid-cols-4">
            {[
              { label: "Total Models", value: stats.total_models, icon: Bot },
              {
                label: "Total Queries",
                value: stats.total_queries.toLocaleString(),
                icon: MessageSquare,
              },
              {
                label: "Total Revenue",
                value: `$${stats.total_revenue.toFixed(2)}`,
                icon: BarChart3,
              },
              {
                label: "Your Earnings",
                value: `$${stats.pending_earnings.toFixed(2)}`,
                icon: DollarSign,
              },
            ].map((s) => (
              <div
                key={s.label}
                className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5"
              >
                <s.icon className="mb-2 h-5 w-5 text-[#3da8ff]" />
                <p className="text-2xl font-bold">{s.value}</p>
                <p className="text-xs text-[#4a5568]">{s.label}</p>
              </div>
            ))}
          </div>
        )
      )}

      {/* Models List */}
      <h2 className="mb-4 text-xl font-semibold">Your Models</h2>
      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-20 animate-pulse rounded-xl bg-[#0f1117]" />
          ))}
        </div>
      ) : models.length > 0 ? (
        <div className="space-y-3">
          {models.map((m) => (
            <div
              key={m.id}
              className="flex items-center justify-between rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-4"
            >
              <div className="flex items-center gap-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#3da8ff]/10">
                  <Bot className="h-5 w-5 text-[#3da8ff]" />
                </div>
                <div>
                  <h3 className="font-semibold">{m.name}</h3>
                  <p className="text-xs text-[#4a5568]">
                    {m.total_queries.toLocaleString()} queries | {formatPrice(m.price_per_query)}/query
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                    m.status === "active"
                      ? "bg-green-500/10 text-green-400"
                      : m.status === "draft"
                        ? "bg-yellow-500/10 text-yellow-400"
                        : "bg-[#1c1f2e] text-[#8b95a8]"
                  }`}
                >
                  {m.status}
                </span>
                <Link
                  href={`/models/${m.slug}`}
                  className="rounded-lg bg-[#161822] px-3 py-1.5 text-xs text-[#8b95a8] hover:bg-[#1c1f2e]"
                >
                  View
                </Link>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] py-12 text-center">
          <p className="mb-4 text-[#4a5568]">You haven&apos;t created any models yet.</p>
          <Link
            href="/models/creator/new"
            className="inline-flex items-center gap-2 rounded-xl bg-[#5bb8ff] px-5 py-2.5 text-sm font-semibold text-[#eef1f8] hover:bg-[#3da8ff]"
          >
            <Plus className="h-4 w-4" />
            Create Your First Model
          </Link>
        </div>
      )}
    </div>
  );
}
