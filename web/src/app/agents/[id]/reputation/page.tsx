"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { getAgentReputation } from "@/lib/api";
import type { AgentReputationView } from "@/lib/types";
import { Star, Award, TrendingUp, CheckCircle2 } from "lucide-react";

export default function AgentReputationPage() {
  const params = useParams<{ id: string }>();
  const [rep, setRep] = useState<AgentReputationView | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!params.id) return;
    getAgentReputation(params.id)
      .then(setRep)
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

  const score = rep?.overall_score ?? 0;
  const confidence = rep?.confidence ?? 0;
  const hasData = score > 0 || (rep?.total_transactions ?? 0) > 0;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-[#eef1f8]">Reputation</h1>
        <p className="mt-1 text-[#8b95a8]">
          On-chain attestations and transaction history. Builds with use.
        </p>
      </div>

      {/* Score gauge */}
      <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-8 text-center">
        <div className="inline-flex items-center justify-center h-24 w-24 rounded-full bg-[#3da8ff]/10 mb-4">
          <Star className="h-10 w-10 text-[#3da8ff]" />
        </div>
        <p className="text-5xl font-bold text-[#eef1f8] mb-2">
          {score.toFixed(2)}
        </p>
        <p className="text-sm text-[#8b95a8]">
          Overall score · {(confidence * 100).toFixed(0)}% confidence
        </p>
      </div>

      {/* Stat tiles */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle2 className="h-4 w-4 text-green-400" />
            <span className="text-sm text-[#8b95a8]">Completed</span>
          </div>
          <p className="text-2xl font-bold text-[#eef1f8]">
            {rep?.completed_transactions ?? 0}
          </p>
        </div>
        <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
          <div className="flex items-center gap-2 mb-2">
            <TrendingUp className="h-4 w-4 text-[#3da8ff]" />
            <span className="text-sm text-[#8b95a8]">Total transactions</span>
          </div>
          <p className="text-2xl font-bold text-[#eef1f8]">
            {rep?.total_transactions ?? 0}
          </p>
        </div>
        <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
          <div className="flex items-center gap-2 mb-2">
            <Award className="h-4 w-4 text-yellow-400" />
            <span className="text-sm text-[#8b95a8]">Reviews</span>
          </div>
          <p className="text-2xl font-bold text-[#eef1f8]">
            {rep?.review_count ?? 0}
          </p>
        </div>
      </div>

      {!hasData && (
        <div className="rounded-xl border border-dashed border-[#1e2a3a] bg-[#0f1117] p-6 text-center">
          <p className="text-sm text-[#8b95a8]">
            Reputation builds as your agent transacts. Once it offers a
            service and completes its first job, the score will start moving.
          </p>
        </div>
      )}
    </div>
  );
}
