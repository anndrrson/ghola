"use client";

import { useState } from "react";
import { Plus, Search } from "lucide-react";
import { AgentCard } from "./AgentCard";
import type { ChatAgent } from "@/lib/types";
import Link from "next/link";
import { GholaLogo } from "@/components/GholaLogo";

interface AgentListProps {
  agents: ChatAgent[];
  activeAgentId: string | null;
  onSelect: (agent: ChatAgent) => void;
  onNew: () => void;
  onEdit: (agent: ChatAgent) => void;
  onDelete: (id: string) => void;
}

export function AgentList({ agents, activeAgentId, onSelect, onNew, onEdit, onDelete }: AgentListProps) {
  const [search, setSearch] = useState("");

  const filtered = search
    ? agents.filter((a) => a.name.toLowerCase().includes(search.toLowerCase()))
    : agents;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#1e2a3a]">
        <div className="flex items-center gap-2">
          <Link href="/" className="flex items-center gap-2">
            <GholaLogo size={22} className="text-[#eef1f8]" />
            <span className="text-lg font-bold text-[#eef1f8]">Chat</span>
          </Link>
        </div>
        <button
          onClick={onNew}
          className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#3da8ff] text-[#08090d] hover:bg-[#5bb8ff] transition-colors cursor-pointer"
          title="New agent"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {/* Search */}
      <div className="px-3 py-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#4a5568]" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search agents..."
            className="w-full rounded-lg bg-[#161822] pl-9 pr-3 py-2 text-sm text-[#eef1f8] placeholder-[#4a5568] outline-none border border-[#1e2a3a] focus:border-[#3da8ff] transition-colors"
          />
        </div>
      </div>

      {/* Agent list */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full px-4 text-center">
            <p className="text-[#4a5568] text-sm">
              {search ? "No agents found" : "No agents yet"}
            </p>
            {!search && (
              <button
                onClick={onNew}
                className="mt-3 text-sm text-[#3da8ff] hover:text-[#5bb8ff] transition-colors cursor-pointer"
              >
                Create your first agent
              </button>
            )}
          </div>
        ) : (
          filtered.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              active={agent.id === activeAgentId}
              onSelect={() => onSelect(agent)}
              onEdit={() => onEdit(agent)}
              onDelete={() => onDelete(agent.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}
