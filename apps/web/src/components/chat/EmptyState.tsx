"use client";

import { MessageSquarePlus } from "lucide-react";

interface EmptyStateProps {
  onNew: () => void;
}

export function EmptyState({ onNew }: EmptyStateProps) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center max-w-sm px-4">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-[#3da8ff]/10">
          <MessageSquarePlus className="h-8 w-8 text-[#3da8ff]" />
        </div>
        <h3 className="text-lg font-semibold text-[#eef1f8] mb-2">No Agent Selected</h3>
        <p className="text-sm text-[#8b95a8] mb-6">
          Create an agent with your own API key. Your messages stay local — nothing is stored on our servers.
        </p>
        <button
          onClick={onNew}
          className="rounded-xl bg-[#3da8ff] px-6 py-2.5 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] transition-colors cursor-pointer"
        >
          Create Your First Agent
        </button>
      </div>
    </div>
  );
}
