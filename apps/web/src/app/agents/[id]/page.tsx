"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  getAgent,
  getAgentEarnings,
  getAgentReputation,
} from "@/lib/api";
import type {
  AgentDetail,
  AgentEarnings,
  AgentReputationView,
} from "@/lib/types";
import {
  Wallet,
  Wrench,
  Star,
  TrendingUp,
  ExternalLink,
  Copy,
  Check,
  Fingerprint,
} from "lucide-react";

function formatUsdc(micro: number): string {
  const usdc = micro / 1_000_000;
  return `$${usdc.toFixed(usdc < 0.01 ? 4 : 2)}`;
}

function truncateAddress(addr: string): string {
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

export default function AgentOverviewPage() {
  const params = useParams<{ id: string }>();
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [earnings, setEarnings] = useState<AgentEarnings | null>(null);
  const [reputation, setReputation] = useState<AgentReputationView | null>(null);
  const [loading, setLoading] = useState(true);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  useEffect(() => {
    if (!params.id) return;
    Promise.all([
      getAgent(params.id),
      getAgentEarnings(params.id).catch(() => null),
      getAgentReputation(params.id).catch(() => null),
    ])
      .then(([a, e, r]) => {
        setAgent(a);
        setEarnings(e);
        setReputation(r);
      })
      .finally(() => setLoading(false));
  }, [params.id]);

  function copy(value: string, field: string) {
    navigator.clipboard.writeText(value);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  }

  if (loading || !agent) {
    return (
      <div className="space-y-6">
        <div className="h-10 w-72 animate-pulse rounded-lg bg-[#161822]" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="h-28 animate-pulse rounded-xl bg-[#161822]"
            />
          ))}
        </div>
      </div>
    );
  }

  const balanceUsdc = earnings?.net_micro_usdc ?? 0;
  const stats = [
    {
      label: "Balance",
      value: formatUsdc(balanceUsdc),
      icon: Wallet,
      sub: `${earnings?.transaction_count ?? 0} transactions`,
    },
    {
      label: "Services",
      value: agent.service_count.toString(),
      icon: Wrench,
      sub: agent.service_count === 0 ? "None yet" : "Listed",
    },
    {
      label: "Reputation",
      value:
        reputation && reputation.overall_score > 0
          ? reputation.overall_score.toFixed(2)
          : "—",
      icon: Star,
      sub: `${reputation?.review_count ?? 0} reviews`,
    },
    {
      label: "Earnings",
      value: formatUsdc(earnings?.total_received_micro_usdc ?? 0),
      icon: TrendingUp,
      sub: "Lifetime received",
    },
  ];

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-[#eef1f8]">
          {agent.display_name}
        </h1>
        <p className="mt-1 text-[#8b95a8]">
          @{agent.slug} · Created{" "}
          {new Date(agent.created_at).toLocaleDateString()}
        </p>
        {agent.bio && (
          <p className="mt-3 text-[#8b95a8] max-w-2xl">{agent.bio}</p>
        )}
      </div>

      {/* Identity card */}
      <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
        <div className="flex items-center gap-2 mb-4">
          <Fingerprint className="h-4 w-4 text-[#3da8ff]" />
          <span className="text-sm font-medium text-[#eef1f8]">
            Cryptographic identity
          </span>
        </div>
        <div className="space-y-3">
          <div>
            <p className="text-xs text-[#4a5568] mb-1">DID</p>
            <button
              onClick={() => copy(agent.did, "did")}
              className="flex items-center gap-2 text-sm font-mono text-[#8b95a8] hover:text-[#eef1f8] transition-colors"
            >
              <code className="truncate max-w-md">{agent.did}</code>
              {copiedField === "did" ? (
                <Check className="h-3.5 w-3.5 text-green-400 shrink-0" />
              ) : (
                <Copy className="h-3.5 w-3.5 shrink-0" />
              )}
            </button>
          </div>
          <div>
            <p className="text-xs text-[#4a5568] mb-1">Solana address</p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => copy(agent.solana_address, "addr")}
                className="flex items-center gap-2 text-sm font-mono text-[#8b95a8] hover:text-[#eef1f8] transition-colors"
              >
                <code>{truncateAddress(agent.solana_address)}</code>
                {copiedField === "addr" ? (
                  <Check className="h-3.5 w-3.5 text-green-400 shrink-0" />
                ) : (
                  <Copy className="h-3.5 w-3.5 shrink-0" />
                )}
              </button>
              <a
                href={`https://explorer.solana.com/address/${agent.solana_address}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-[#3da8ff] hover:text-[#5bb8ff] inline-flex items-center gap-1"
              >
                Explorer <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <div
              key={stat.label}
              className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5"
            >
              <div className="flex items-center gap-3 mb-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#3da8ff]/10">
                  <Icon className="h-4 w-4 text-[#3da8ff]" />
                </div>
                <p className="text-sm text-[#8b95a8]">{stat.label}</p>
              </div>
              <p className="text-2xl font-bold text-[#eef1f8]">
                {stat.value}
              </p>
              <p className="text-xs text-[#4a5568] mt-1">{stat.sub}</p>
            </div>
          );
        })}
      </div>

      {/* Quick actions */}
      <div>
        <h2 className="mb-4 text-lg font-semibold text-[#eef1f8]">
          Quick actions
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {[
            {
              href: `/agents/${agent.id}/services`,
              label: "Manage services",
              desc: "Register API endpoints other agents can hire",
              icon: Wrench,
            },
            {
              href: `/agents/${agent.id}/wallet`,
              label: "View wallet",
              desc: "Check balance, send funds, view transaction history",
              icon: Wallet,
            },
            {
              href: `/agents/${agent.id}/reputation`,
              label: "Reputation",
              desc: "On-chain attestations, reviews, transaction history",
              icon: Star,
            },
            {
              href: `/agents/${agent.id}/settings`,
              label: "Settings",
              desc: "Edit display name, avatar, bio, or archive",
              icon: TrendingUp,
            },
          ].map((action) => {
            const Icon = action.icon;
            return (
              <Link
                key={action.href}
                href={action.href}
                className="group flex items-start gap-4 rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5 transition-colors hover:border-[#3da8ff]/30 hover:bg-[#161822]"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#3da8ff]/10 transition-colors group-hover:bg-[#3da8ff]/20">
                  <Icon className="h-5 w-5 text-[#3da8ff]" />
                </div>
                <div>
                  <p className="font-medium text-[#eef1f8]">{action.label}</p>
                  <p className="mt-0.5 text-sm text-[#8b95a8]">
                    {action.desc}
                  </p>
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
