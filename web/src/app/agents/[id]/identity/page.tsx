"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { getAgent } from "@/lib/api";
import type { AgentDetail } from "@/lib/types";
import { Copy, Check, ExternalLink, Fingerprint, Lock } from "lucide-react";

export default function AgentIdentityPage() {
  const params = useParams<{ id: string }>();
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (params.id) getAgent(params.id).then(setAgent);
  }, [params.id]);

  function copy(value: string, field: string) {
    navigator.clipboard.writeText(value);
    setCopied(field);
    setTimeout(() => setCopied(null), 2000);
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
        <h1 className="text-3xl font-bold text-[#eef1f8]">Identity</h1>
        <p className="mt-1 text-[#8b95a8]">
          Cryptographic credentials for this agent. These are immutable.
        </p>
      </div>

      <div className="space-y-4">
        {/* DID */}
        <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
          <div className="flex items-center gap-2 mb-3">
            <Fingerprint className="h-4 w-4 text-[#3da8ff]" />
            <h2 className="text-sm font-medium text-[#eef1f8]">
              Decentralized Identifier (DID)
            </h2>
          </div>
          <p className="text-xs text-[#4a5568] mb-3">
            A `did:key:` derived from this agent&apos;s ed25519 public key.
            Anyone can resolve and verify it without contacting any registry.
          </p>
          <button
            onClick={() => copy(agent.did, "did")}
            className="flex items-center gap-2 w-full rounded-lg bg-[#08090d] border border-[#1e2a3a] px-3 py-2.5 text-left hover:border-[#2a3a50] transition-colors group"
          >
            <code className="flex-1 text-sm font-mono text-[#8b95a8] group-hover:text-[#eef1f8] truncate">
              {agent.did}
            </code>
            {copied === "did" ? (
              <Check className="h-4 w-4 text-green-400 shrink-0" />
            ) : (
              <Copy className="h-4 w-4 text-[#4a5568] group-hover:text-[#8b95a8] shrink-0" />
            )}
          </button>
        </div>

        {/* Solana address */}
        <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
          <div className="flex items-center gap-2 mb-3">
            <ExternalLink className="h-4 w-4 text-[#3da8ff]" />
            <h2 className="text-sm font-medium text-[#eef1f8]">
              Solana Address
            </h2>
          </div>
          <p className="text-xs text-[#4a5568] mb-3">
            Your agent&apos;s on-chain address. Send USDC here to fund the
            agent&apos;s wallet.
          </p>
          <button
            onClick={() => copy(agent.solana_address, "addr")}
            className="flex items-center gap-2 w-full rounded-lg bg-[#08090d] border border-[#1e2a3a] px-3 py-2.5 text-left hover:border-[#2a3a50] transition-colors group mb-3"
          >
            <code className="flex-1 text-sm font-mono text-[#8b95a8] group-hover:text-[#eef1f8] truncate">
              {agent.solana_address}
            </code>
            {copied === "addr" ? (
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

        {/* On-chain registry */}
        <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
          <div className="flex items-center gap-2 mb-3">
            <Lock className="h-4 w-4 text-[#3da8ff]" />
            <h2 className="text-sm font-medium text-[#eef1f8]">
              On-chain Registration
            </h2>
          </div>
          {agent.onchain_identity_pda ? (
            <div>
              <p className="text-xs text-[#4a5568] mb-3">
                Registered on the SAID Solana program.
              </p>
              <code className="block text-sm font-mono text-[#8b95a8] truncate">
                {agent.onchain_identity_pda}
              </code>
            </div>
          ) : (
            <div>
              <p className="text-sm text-[#8b95a8] mb-2">
                Not yet registered on-chain.
              </p>
              <p className="text-xs text-[#4a5568]">
                Your agent has a valid DID and address. On-chain registration
                via the SAID program (
                <code className="font-mono">3EqrapHPP...7QyR</code>) is coming
                soon.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
