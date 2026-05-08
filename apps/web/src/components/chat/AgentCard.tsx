"use client";

import { useState } from "react";
import { MoreVertical, Pencil, Trash2 } from "lucide-react";
import { AgentAvatar } from "./AgentAvatar";
import type { ChatAgent } from "@/lib/types";
import { getProviderColor } from "@/lib/providers";

interface AgentCardProps {
  agent: ChatAgent;
  active: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export function AgentCard({ agent, active, onSelect, onEdit, onDelete }: AgentCardProps) {
  const [showMenu, setShowMenu] = useState(false);

  const timeAgo = agent.lastMessageAt
    ? formatRelativeTime(agent.lastMessageAt)
    : formatRelativeTime(agent.createdAt);

  return (
    <div
      className={`relative flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors ${
        active ? "bg-[#3da8ff]/10" : "hover:bg-[#0f1117]"
      }`}
      onClick={onSelect}
    >
      <AgentAvatar avatar={agent.avatar} name={agent.name} color={getProviderColor(agent.provider)} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between">
          <span className={`text-sm font-medium truncate ${active ? "text-[#3da8ff]" : "text-[#eef1f8]"}`}>
            {agent.name}
          </span>
          <span className="text-xs text-[#4a5568] ml-2 shrink-0">{timeAgo}</span>
        </div>
        <p className="text-xs text-[#8b95a8] truncate mt-0.5">
          {agent.lastMessagePreview || agent.model}
        </p>
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); setShowMenu(!showMenu); }}
        className="p-1 text-[#4a5568] hover:text-[#8b95a8] transition-colors cursor-pointer shrink-0"
      >
        <MoreVertical className="h-4 w-4" />
      </button>
      {showMenu && (
        <div className="absolute right-4 top-12 z-10 rounded-lg bg-[#161822] border border-[#1e2a3a] shadow-lg py-1 min-w-[120px]">
          <button
            onClick={(e) => { e.stopPropagation(); setShowMenu(false); onEdit(); }}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-[#eef1f8] hover:bg-[#0f1117] cursor-pointer"
          >
            <Pencil className="h-3.5 w-3.5" /> Edit
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); setShowMenu(false); onDelete(); }}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-red-400 hover:bg-[#0f1117] cursor-pointer"
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </button>
        </div>
      )}
    </div>
  );
}

function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "now";
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
