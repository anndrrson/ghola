"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Fingerprint,
  Wallet,
  Wrench,
  Star,
  TrendingUp,
  Settings,
  Menu,
  X,
} from "lucide-react";
import { AgentAvatar } from "./AgentAvatar";
import type { Agent } from "@/lib/types";

interface AgentSidebarProps {
  agent: Agent;
  children: React.ReactNode;
}

export function AgentSidebar({ agent, children }: AgentSidebarProps) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const base = `/agents/${agent.id}`;
  const items = [
    { href: base, label: "Overview", icon: LayoutDashboard, exact: true },
    { href: `${base}/identity`, label: "Identity", icon: Fingerprint },
    { href: `${base}/wallet`, label: "Wallet", icon: Wallet },
    { href: `${base}/services`, label: "Services", icon: Wrench },
    { href: `${base}/reputation`, label: "Reputation", icon: Star },
    { href: `${base}/earnings`, label: "Earnings", icon: TrendingUp },
    { href: `${base}/settings`, label: "Settings", icon: Settings },
  ];

  function isActive(href: string, exact?: boolean) {
    if (exact) return pathname === href;
    return pathname.startsWith(href);
  }

  const sidebar = (
    <nav className="flex flex-col gap-1 px-3 py-4">
      <div className="flex items-center gap-3 rounded-lg px-3 py-3 mb-2">
        <AgentAvatar
          displayName={agent.display_name}
          avatarUrl={agent.avatar_url}
          size={40}
        />
        <div className="min-w-0">
          <p className="font-semibold text-[#eef1f8] text-sm truncate">
            {agent.display_name}
          </p>
          <p className="text-xs text-[#8b95a8] truncate">@{agent.slug}</p>
        </div>
      </div>
      {items.map((item) => {
        const Icon = item.icon;
        const active = isActive(item.href, item.exact);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={() => setOpen(false)}
            className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              active
                ? "bg-[#3da8ff]/10 text-[#3da8ff]"
                : "text-[#8b95a8] hover:bg-[#161822] hover:text-[#eef1f8]"
            }`}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {item.label}
          </Link>
        );
      })}
      <Link
        href="/agents"
        className="mt-4 flex items-center gap-3 rounded-lg px-3 py-2 text-xs text-[#4a5568] hover:text-[#8b95a8] transition-colors"
      >
        ← All agents
      </Link>
    </nav>
  );

  return (
    <div className="flex min-h-screen pt-16">
      <aside className="hidden lg:flex lg:w-64 lg:flex-col lg:fixed lg:inset-y-0 lg:top-16 bg-[#0f1117] border-r border-[#1e2a3a] overflow-y-auto">
        {sidebar}
      </aside>

      <button
        className="lg:hidden fixed top-[4.5rem] left-4 z-40 rounded-lg bg-[#161822] p-2 text-[#8b95a8] hover:text-[#eef1f8] transition-colors cursor-pointer"
        onClick={() => setOpen(!open)}
        aria-label="Toggle sidebar"
      >
        {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
      </button>

      {open && (
        <>
          <div
            className="lg:hidden fixed inset-0 z-30 bg-black/50 pt-16"
            onClick={() => setOpen(false)}
          />
          <aside className="lg:hidden fixed inset-y-0 left-0 z-40 w-64 bg-[#0f1117] border-r border-[#1e2a3a] pt-16 overflow-y-auto">
            {sidebar}
          </aside>
        </>
      )}

      <main className="flex-1 lg:ml-64">
        <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
          {children}
        </div>
      </main>
    </div>
  );
}
