"use client";

import { ArrowLeft, Settings } from "lucide-react";
import { AgentAvatar } from "./AgentAvatar";
import { getProviderColor, getProvider } from "@/lib/providers";
import type { ChatAgent } from "@/lib/types";

interface ChatHeaderProps {
  agent: ChatAgent;
  onBack: () => void;
  onSettings: () => void;
}

export function ChatHeader({ agent, onBack, onSettings }: ChatHeaderProps) {
  const provider = getProvider(agent.provider);

  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-[#1e2a3a] bg-[#0a0b10]">
      <button
        onClick={onBack}
        className="lg:hidden p-1 text-[#8b95a8] hover:text-[#eef1f8] transition-colors cursor-pointer"
      >
        <ArrowLeft className="h-5 w-5" />
      </button>
      <AgentAvatar avatar={agent.avatar} name={agent.name} color={getProviderColor(agent.provider)} size="sm" />
      <div className="flex-1 min-w-0">
        <h2 className="text-sm font-semibold text-[#eef1f8] truncate">{agent.name}</h2>
        <p className="text-xs text-[#8b95a8]">
          {provider?.name || agent.provider} &middot; {agent.model}
        </p>
      </div>
      <button
        onClick={onSettings}
        className="p-2 text-[#8b95a8] hover:text-[#eef1f8] transition-colors cursor-pointer"
      >
        <Settings className="h-4 w-4" />
      </button>
    </div>
  );
}
