"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { listAgents } from "@/lib/api";
import type { Agent } from "@/lib/types";
import { AgentCard } from "@/components/agents/AgentCard";
import { Plus, Sparkles, ArrowRight } from "lucide-react";

export default function AgentsListPage() {
  const { authenticated, loading: authLoading } = useAuth();
  const router = useRouter();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading) return;
    if (!authenticated) {
      setLoading(false);
      return;
    }
    listAgents()
      .then((rows) => {
        setAgents(rows);
        setError(null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [authenticated, authLoading]);

  if (authLoading || loading) {
    return (
      <div className="min-h-screen pt-24">
        <div className="mx-auto max-w-6xl px-4">
          <div className="h-10 w-72 animate-pulse rounded-lg bg-[#161822]" />
          <div className="mt-3 h-5 w-96 animate-pulse rounded-lg bg-[#161822]" />
          <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-36 animate-pulse rounded-xl bg-[#161822]"
              />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="min-h-screen pt-24">
        <div className="mx-auto max-w-3xl px-4 text-center py-20">
          <div className="inline-flex items-center gap-2 rounded-full border border-[#1e2a3a] bg-[#0f1117] px-4 py-1.5 text-sm text-[#8b95a8] mb-8">
            <Sparkles className="h-3.5 w-3.5 text-[#3da8ff]" />
            Sign in to create agents
          </div>
          <h1 className="text-4xl md:text-5xl font-medium text-[#eef1f8] mb-4">
            Your agents live here.
          </h1>
          <p className="text-[#8b95a8] mb-10 max-w-xl mx-auto">
            Sign in to create cryptographically-owned AI agents with their own
            wallets, services, and on-chain reputation.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link
              href="/identity/login"
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#3da8ff] px-7 py-3.5 text-base font-medium text-[#08090d] hover:bg-[#5bb8ff] transition-all"
            >
              Sign in
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              href="/identity/register"
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-[#1e2a3a] px-7 py-3.5 text-base font-medium text-[#8b95a8] hover:text-[#eef1f8] hover:border-[#2a3a50] transition-all"
            >
              Create account
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen pt-24">
      <div className="mx-auto max-w-6xl px-4 py-10">
        {/* Header */}
        <div className="mb-10 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-[#eef1f8]">My Agents</h1>
            <p className="mt-2 text-[#8b95a8]">
              Cryptographically-owned AI agents you operate. Each has its own
              identity, wallet, and reputation.
            </p>
          </div>
          <button
            onClick={() => router.push("/agents/new")}
            className="hidden sm:inline-flex items-center gap-2 rounded-xl bg-[#3da8ff] px-5 py-2.5 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] transition-colors cursor-pointer"
          >
            <Plus className="h-4 w-4" />
            Create agent
          </button>
        </div>

        {error && (
          <div className="mb-6 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}

        {agents.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[#1e2a3a] bg-[#0f1117] py-20 text-center">
            <div className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-[#3da8ff]/10 mb-4">
              <Sparkles className="h-7 w-7 text-[#3da8ff]" />
            </div>
            <h2 className="text-xl font-medium text-[#eef1f8] mb-2">
              No agents yet
            </h2>
            <p className="text-[#8b95a8] mb-6 max-w-md mx-auto">
              Create your first agent in under 10 seconds. We&apos;ll generate a
              fresh DID, provision a Solana wallet, and you&apos;re live.
            </p>
            <Link
              href="/agents/new"
              className="inline-flex items-center gap-2 rounded-xl bg-[#3da8ff] px-6 py-3 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] transition-colors"
            >
              <Plus className="h-4 w-4" />
              Create your first agent
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {agents.map((agent) => (
              <AgentCard key={agent.id} agent={agent} />
            ))}
          </div>
        )}

        {/* Mobile create button */}
        <div className="mt-6 sm:hidden">
          <Link
            href="/agents/new"
            className="flex items-center justify-center gap-2 rounded-xl bg-[#3da8ff] px-5 py-3 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] transition-colors w-full"
          >
            <Plus className="h-4 w-4" />
            Create agent
          </Link>
        </div>
      </div>
    </div>
  );
}
