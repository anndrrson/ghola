"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { getAgentEarnings } from "@/lib/api";
import type { AgentEarnings } from "@/lib/types";
import { TrendingUp, ArrowDown, ArrowUp, Activity } from "lucide-react";

function formatUsdc(micro: number): string {
  const usdc = micro / 1_000_000;
  return `$${usdc.toFixed(usdc < 0.01 ? 4 : 2)}`;
}

export default function AgentEarningsPage() {
  const params = useParams<{ id: string }>();
  const [earnings, setEarnings] = useState<AgentEarnings | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!params.id) return;
    getAgentEarnings(params.id)
      .then(setEarnings)
      .finally(() => setLoading(false));
  }, [params.id]);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-64 animate-pulse rounded-lg bg-[#161822]" />
        <div className="h-32 animate-pulse rounded-xl bg-[#161822]" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-[#eef1f8]">Earnings</h1>
        <p className="mt-1 text-[#8b95a8]">
          USDC totals from this agent&apos;s wallet activity.
        </p>
      </div>

      {/* Net */}
      <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6">
        <div className="flex items-center gap-2 mb-2">
          <TrendingUp className="h-4 w-4 text-[#3da8ff]" />
          <span className="text-sm text-[#8b95a8]">Net (received − spent)</span>
        </div>
        <p className="text-4xl font-bold text-[#eef1f8]">
          {formatUsdc(earnings?.net_micro_usdc ?? 0)}
        </p>
      </div>

      {/* In/Out grid */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
          <div className="flex items-center gap-2 mb-2">
            <ArrowDown className="h-4 w-4 text-green-400" />
            <span className="text-sm text-[#8b95a8]">Total received</span>
          </div>
          <p className="text-2xl font-bold text-[#eef1f8]">
            {formatUsdc(earnings?.total_received_micro_usdc ?? 0)}
          </p>
          <p className="text-xs text-[#4a5568] mt-1">Lifetime inflows</p>
        </div>
        <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
          <div className="flex items-center gap-2 mb-2">
            <ArrowUp className="h-4 w-4 text-yellow-400" />
            <span className="text-sm text-[#8b95a8]">Total spent</span>
          </div>
          <p className="text-2xl font-bold text-[#eef1f8]">
            {formatUsdc(earnings?.total_spent_micro_usdc ?? 0)}
          </p>
          <p className="text-xs text-[#4a5568] mt-1">Lifetime outflows</p>
        </div>
      </div>

      {/* Tx count */}
      <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
        <div className="flex items-center gap-2 mb-2">
          <Activity className="h-4 w-4 text-[#3da8ff]" />
          <span className="text-sm text-[#8b95a8]">Total transactions</span>
        </div>
        <p className="text-2xl font-bold text-[#eef1f8]">
          {earnings?.transaction_count ?? 0}
        </p>
      </div>

      {(earnings?.transaction_count ?? 0) === 0 && (
        <div className="rounded-xl border border-dashed border-[#1e2a3a] bg-[#0f1117] p-6 text-center">
          <p className="text-sm text-[#8b95a8]">
            No transactions yet. Once your agent has services listed and other
            agents start hiring it, USDC payments will appear here
            automatically.
          </p>
        </div>
      )}
    </div>
  );
}
