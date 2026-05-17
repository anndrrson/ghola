"use client";

import { useEffect, useState } from "react";
import {
  getCreatorStats,
  getCreatorModels,
  getCreatorEarnings,
  publishModel,
  toggleModelStatus,
  type CreatorStats,
  type Model,
  type EarningsData,
} from "@/lib/api";
import { useAuth } from "@/lib/wallet-provider";
import Link from "next/link";
import {
  Plus,
  BarChart3,
  MessageSquare,
  DollarSign,
  Bot,
  Eye,
  EyeOff,
  TrendingUp,
} from "lucide-react";
import { useRouter } from "next/navigation";

export default function CreatorDashboard() {
  const { authenticated, isCreator } = useAuth();
  const router = useRouter();
  const [stats, setStats] = useState<CreatorStats | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [earnings, setEarnings] = useState<EarningsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState<string | null>(null);

  const fetchData = () => {
    if (!authenticated) return;
    Promise.all([getCreatorStats(), getCreatorModels(), getCreatorEarnings()])
      .then(([s, m, e]) => {
        setStats(s);
        setModels(m);
        setEarnings(e);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchData();
  }, [authenticated]);

  const handleToggleStatus = async (model: Model) => {
    setToggling(model.id);
    try {
      const newStatus = model.status === "live" ? "paused" : "live";
      if (model.status === "draft") {
        await publishModel(model.id);
      } else {
        await toggleModelStatus(model.id, newStatus);
      }
      fetchData();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to update status");
    } finally {
      setToggling(null);
    }
  };

  const formatMicro = (micro: number) =>
    `$${(micro / 1_000_000).toFixed(2)}`;

  if (!authenticated) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-16 text-center">
        <h1 className="mb-4 text-2xl font-medium">Creator Dashboard</h1>
        <p className="text-[#a1a1a1]">
          Connect your wallet to access your dashboard.
        </p>
      </div>
    );
  }

  if (!isCreator) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-16 text-center">
        <h1 className="mb-4 text-2xl font-medium">Become a Creator</h1>
        <p className="mb-6 text-[#a1a1a1]">
          Create your first AI model to get started!
        </p>
        <Link
          href="/creator/models/new"
          className="inline-flex items-center gap-2 rounded-lg bg-[#fafafa] px-6 py-2.5 text-sm font-medium text-[#0a0a0a] hover:bg-[#e5e5e5] transition-colors active:scale-[0.98]"
        >
          <Plus className="h-4 w-4" />
          Create Your First Model
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-3xl font-medium">Creator Dashboard</h1>
        <Link
          href="/creator/models/new"
          className="inline-flex items-center gap-2 rounded-lg bg-[#fafafa] px-5 py-2.5 text-sm font-medium text-[#0a0a0a] hover:bg-[#e5e5e5] transition-colors active:scale-[0.98]"
        >
          <Plus className="h-4 w-4" />
          Create Model
        </Link>
      </div>

      {/* Stats */}
      {loading ? (
        <div className="mb-8 grid gap-4 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-28 animate-pulse rounded-lg bg-[#141414]"
            />
          ))}
        </div>
      ) : (
        stats && (
          <div className="mb-8 grid gap-4 md:grid-cols-4">
            {[
              { label: "Total Models", value: stats.total_models, icon: Bot, money: false },
              {
                label: "Total Queries",
                value: stats.total_queries.toLocaleString(),
                icon: MessageSquare,
                money: false,
              },
              {
                label: "Total Revenue",
                value: formatMicro(stats.total_revenue),
                icon: BarChart3,
                money: true,
              },
              {
                label: "Your Earnings",
                value: formatMicro(stats.pending_earnings),
                icon: DollarSign,
                money: true,
              },
            ].map((s) => (
              <div
                key={s.label}
                className="bg-[#141414] border border-[#262626] rounded-lg p-5"
              >
                <s.icon className="mb-2 h-5 w-5 text-[#a1a1a1]" />
                <p className={`text-2xl font-medium ${s.money ? "text-[#00E5A0]" : "text-[#fafafa]"}`}>{s.value}</p>
                <p className="text-xs text-[#666]">{s.label}</p>
              </div>
            ))}
          </div>
        )
      )}

      {/* Earnings Chart */}
      {earnings && earnings.daily.length > 0 && (
        <div className="mb-8 bg-[#141414] border border-[#262626] rounded-lg p-6">
          <h2 className="mb-4 flex items-center gap-2 text-lg font-medium">
            <TrendingUp className="h-5 w-5 text-[#a1a1a1]" />
            Earnings (Last 30 Days)
          </h2>
          <div className="flex h-32 items-end gap-1">
            {earnings.daily.map((d) => {
              const maxAmount = Math.max(
                ...earnings.daily.map((x) => x.amount),
                1
              );
              const height = (d.amount / maxAmount) * 100;
              return (
                <div
                  key={d.date}
                  className="group relative flex-1"
                  title={`${d.date}: ${formatMicro(d.amount)}`}
                >
                  <div
                    className="w-full rounded-t bg-[#00E5A0] transition-colors hover:bg-[#00cc8e]"
                    style={{ height: `${Math.max(height, 2)}%` }}
                  />
                </div>
              );
            })}
          </div>
          <div className="mt-2 flex justify-between text-xs text-[#666]">
            <span>{earnings.daily[0]?.date}</span>
            <span>{earnings.daily[earnings.daily.length - 1]?.date}</span>
          </div>

          {/* Per-model breakdown */}
          {earnings.per_model.length > 0 && (
            <div className="mt-6">
              <h3 className="mb-3 text-sm font-medium text-[#a1a1a1]">
                Per-Model Breakdown
              </h3>
              <div className="space-y-2">
                {earnings.per_model.map((m) => (
                  <div
                    key={m.model_id}
                    className="flex items-center justify-between rounded-lg bg-[#1a1a1a] px-4 py-2 text-sm"
                  >
                    <Link
                      href={`/models/${m.model_slug}`}
                      className="font-medium text-[#a1a1a1] hover:text-[#fafafa] transition-colors"
                    >
                      {m.model_name}
                    </Link>
                    <div className="flex items-center gap-4 text-[#a1a1a1]">
                      <span>{m.query_count} queries</span>
                      <span className="font-medium text-[#00E5A0]">
                        {formatMicro(m.creator_earnings)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex justify-between border-t border-[#262626] pt-3 text-sm">
                <span className="text-[#a1a1a1]">
                  Split: 85% creator / 15% platform
                </span>
                <span className="font-medium text-[#00E5A0]">
                  Total: {formatMicro(earnings.total_earnings)}
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Models List */}
      <h2 className="mb-4 text-xl font-medium">Your Models</h2>
      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="h-20 animate-pulse rounded-lg bg-[#141414]"
            />
          ))}
        </div>
      ) : models.length > 0 ? (
        <div className="space-y-3">
          {models.map((m) => (
            <div
              key={m.id}
              className="flex items-center justify-between bg-[#141414] border border-[#262626] rounded-lg p-4"
            >
              <div className="flex items-center gap-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#1a1a1a]">
                  <Bot className="h-5 w-5 text-[#a1a1a1]" />
                </div>
                <div>
                  <h3 className="font-medium">{m.name}</h3>
                  <p className="text-xs text-[#666]">
                    {m.total_queries.toLocaleString()} queries |{" "}
                    {formatMicro(m.price_per_query)}/query
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-medium border ${
                    m.status === "live"
                      ? "bg-[#00E5A0]/10 text-[#00E5A0] border-[#00E5A0]/20"
                      : m.status === "draft"
                        ? "bg-[#f59e0b]/10 text-[#f59e0b] border-[#f59e0b]/20"
                        : m.status === "paused"
                          ? "bg-[#f59e0b]/10 text-[#f59e0b] border-[#f59e0b]/20"
                          : "bg-[#222] text-[#a1a1a1] border-[#333]"
                  }`}
                >
                  {m.status}
                </span>
                <button
                  onClick={() => handleToggleStatus(m)}
                  disabled={toggling === m.id}
                  className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors active:scale-[0.98] ${
                    m.status === "live"
                      ? "bg-[#f59e0b]/10 text-[#f59e0b] hover:bg-[#f59e0b]/20"
                      : "bg-[#00E5A0]/10 text-[#00E5A0] hover:bg-[#00E5A0]/20"
                  } disabled:opacity-50`}
                  title={
                    m.status === "live" ? "Pause model" : "Publish model"
                  }
                >
                  {m.status === "live" ? (
                    <>
                      <EyeOff className="h-3.5 w-3.5" /> Unpublish
                    </>
                  ) : (
                    <>
                      <Eye className="h-3.5 w-3.5" /> Publish
                    </>
                  )}
                </button>
                <Link
                  href={`/models/${m.slug}`}
                  className="rounded-lg bg-[#1a1a1a] px-3 py-1.5 text-xs text-[#a1a1a1] hover:bg-[#222] transition-colors"
                >
                  View
                </Link>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="bg-[#141414] border border-[#262626] rounded-lg py-12 text-center">
          <p className="mb-4 text-[#666]">
            You haven&apos;t created any models yet.
          </p>
          <Link
            href="/creator/models/new"
            className="inline-flex items-center gap-2 rounded-lg bg-[#fafafa] px-5 py-2.5 text-sm font-medium text-[#0a0a0a] hover:bg-[#e5e5e5] transition-colors active:scale-[0.98]"
          >
            <Plus className="h-4 w-4" />
            Create Your First Model
          </Link>
        </div>
      )}
    </div>
  );
}
