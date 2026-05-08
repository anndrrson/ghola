"use client";

import Link from "next/link";
import { ArrowLeft, Settings } from "lucide-react";
import { GholaLogo } from "@/components/GholaLogo";

interface ChatHeaderProps {
  title: string;
  onBack: () => void;
}

export function ChatHeader({ title, onBack }: ChatHeaderProps) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-[#1e2a3a] bg-[#0a0b10]">
      <button
        onClick={onBack}
        className="lg:hidden p-1 text-[#8b95a8] hover:text-[#eef1f8] transition-colors cursor-pointer"
      >
        <ArrowLeft className="h-5 w-5" />
      </button>
      <GholaLogo size={24} className="text-[#eef1f8] hidden lg:block" />
      <div className="flex-1 min-w-0">
        <h2 className="text-sm font-semibold text-[#eef1f8] truncate">
          {title || "New conversation"}
        </h2>
      </div>
      <Link
        href="/models"
        className="text-sm text-[#8b95a8] hover:text-[#eef1f8] transition-colors"
      >
        Models
      </Link>
      <Link
        href="/settings"
        className="p-2 text-[#8b95a8] hover:text-[#eef1f8] transition-colors"
      >
        <Settings className="h-4 w-4" />
      </Link>
    </div>
  );
}
