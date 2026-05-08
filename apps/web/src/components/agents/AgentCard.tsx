"use client";

import Link from "next/link";
import type { Agent } from "@/lib/types";
import { AgentAvatar } from "./AgentAvatar";
import { Fingerprint, Circle } from "lucide-react";

interface AgentCardProps {
  agent: Agent;
}

function truncateDid(did: string): string {
  if (did.length <= 24) return did;
  return `${did.slice(0, 16)}…${did.slice(-6)}`;
}

const STATUS_STYLES: Record<string, string> = {
  active: "text-green-400",
  paused: "text-yellow-400",
  archived: "text-[#4a5568]",
};

export function AgentCard({ agent }: AgentCardProps) {
  return (
    <Link
      href={`/agents/${agent.id}`}
      className="group rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5 transition-colors hover:border-[#3da8ff]/30 hover:bg-[#161822]"
    >
      <div className="flex items-start gap-4">
        <AgentAvatar
          displayName={agent.display_name}
          avatarUrl={agent.avatar_url}
          size={48}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <h3 className="font-semibold text-[#eef1f8] group-hover:text-[#3da8ff] transition-colors truncate">
              {agent.display_name}
            </h3>
            <span
              className={`flex shrink-0 items-center gap-1 text-xs ${
                STATUS_STYLES[agent.status] ?? "text-[#4a5568]"
              }`}
            >
              <Circle
                className="h-2 w-2 fill-current"
                strokeWidth={0}
              />
              {agent.status}
            </span>
          </div>
          <p className="text-xs text-[#8b95a8] mt-0.5">@{agent.slug}</p>
          {agent.bio && (
            <p className="mt-2 text-sm text-[#8b95a8] line-clamp-2">
              {agent.bio}
            </p>
          )}
        </div>
      </div>
      <div className="mt-4 flex items-center gap-2 rounded-lg border border-[#1e2a3a] bg-[#08090d] px-3 py-2">
        <Fingerprint className="h-3.5 w-3.5 text-[#3da8ff] shrink-0" />
        <code className="text-xs text-[#8b95a8] font-mono truncate">
          {truncateDid(agent.did)}
        </code>
      </div>
    </Link>
  );
}
