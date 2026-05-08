"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { getAgent, getAgentEarnings, getAgentWallet } from "@/lib/api";
import type { AgentDetail, AgentEarnings, AgentWallet } from "@/lib/types";
import { Copy, Check, ExternalLink, Wallet, ArrowDown, ArrowUp } from "lucide-react";

function formatUsdc(micro: number): string {
  const usdc = micro / 1_000_000;
  return `$${usdc.toFixed(usdc < 0.01 ? 4 : 2)}`;
}

export default function AgentWalletPage() {
  const params = useParams<{ id: string }>();
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [wallet, setWallet] = useState<AgentWallet | null>(null);
  const [earnings, setEarnings] = useState<AgentEarnings | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!params.id) return;
    Promise.all([
      getAgent(params.id),
      getAgentWallet(params.id).catch(() => null),
      getAgentEarnings(params.id).catch(() => null),
    ]).then(([a, w, e]) => {
      setAgent(a);
      setWallet(w);
      setEarnings(e);
    });
  }, [params.id]);

  function copy() {
    if (!agent) return;
    navigator.clipboard.writeText(agent.solana_address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (!agent) {
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
        <h1 className="text-3xl font-bold text-[#eef1f8]">Wallet</h1>
        <p className="mt-1 text-[#8b95a8]">
          Solana wallet dedicated to this agent. Earnings flow here directly.
        </p>
      </div>

      {/* Balance card */}
      <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6">
        <div className="flex items-center gap-2 mb-2">
          <Wallet className="h-4 w-4 text-[#3da8ff]" />
          <span className="text-sm text-[#8b95a8]">Net balance (USDC)</span>
        </div>
        <p className="text-4xl font-bold text-[#eef1f8] mb-1">
          {formatUsdc(earnings?.net_micro_usdc ?? 0)}
        </p>
        <p className="text-xs text-[#4a5568]">
          From {earnings?.transaction_count ?? 0} transactions
        </p>
      </div>

      {/* In/Out */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
          <div className="flex items-center gap-2 mb-2">
            <ArrowDown className="h-4 w-4 text-green-400" />
            <span className="text-sm text-[#8b95a8]">Total received</span>
          </div>
          <p className="text-2xl font-bold text-[#eef1f8]">
            {formatUsdc(earnings?.total_received_micro_usdc ?? 0)}
          </p>
        </div>
        <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
          <div className="flex items-center gap-2 mb-2">
            <ArrowUp className="h-4 w-4 text-yellow-400" />
            <span className="text-sm text-[#8b95a8]">Total spent</span>
          </div>
          <p className="text-2xl font-bold text-[#eef1f8]">
            {formatUsdc(earnings?.total_spent_micro_usdc ?? 0)}
          </p>
        </div>
      </div>

      {/* Receive address */}
      <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
        <h2 className="text-sm font-medium text-[#eef1f8] mb-3">
          Receive USDC at
        </h2>
        <button
          onClick={copy}
          className="flex items-center gap-2 w-full rounded-lg bg-[#08090d] border border-[#1e2a3a] px-3 py-2.5 text-left hover:border-[#2a3a50] transition-colors group mb-3"
        >
          <code className="flex-1 text-sm font-mono text-[#8b95a8] group-hover:text-[#eef1f8] truncate">
            {agent.solana_address}
          </code>
          {copied ? (
            <Check className="h-4 w-4 text-green-400 shrink-0" />
          ) : (
            <Copy className="h-4 w-4 text-[#4a5568] group-hover:text-[#8b95a8] shrink-0" />
          )}
        </button>
        <a
          href={`https://explorer.solana.com/address/${agent.solana_address}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-sm text-[#3da8ff] hover:text-[#5bb8ff]"
        >
          View on Solana Explorer
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>

      {wallet && (
        <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
          <h2 className="text-sm font-medium text-[#eef1f8] mb-3">
            Wallet metadata
          </h2>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-[#8b95a8]">Label</dt>
              <dd className="text-[#eef1f8] font-mono">{wallet.label}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-[#8b95a8]">HD index</dt>
              <dd className="text-[#eef1f8] font-mono">{wallet.hd_index}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-[#8b95a8]">Status</dt>
              <dd
                className={
                  wallet.active ? "text-green-400" : "text-[#4a5568]"
                }
              >
                {wallet.active ? "Active" : "Inactive"}
              </dd>
            </div>
          </dl>
        </div>
      )}
    </div>
  );
}
