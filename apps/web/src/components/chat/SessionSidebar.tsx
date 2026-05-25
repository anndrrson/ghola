"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Cpu,
  Home,
  MessageSquare,
  Plus,
  Settings,
  ShoppingBag,
  Trash2,
} from "lucide-react";
import { GholaLogo } from "@/components/GholaLogo";
import type { ThumperSession } from "@/lib/thumper-types";

interface SessionSidebarProps {
  sessions: ThumperSession[];
  activeSessionId: string | null;
  onSelect: (session: ThumperSession) => void;
  onNew: () => void;
  onDelete: (sessionId: string) => void;
}

function groupSessions(sessions: ThumperSession[]) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const weekAgo = new Date(today.getTime() - 7 * 86400000);

  const groups: { label: string; sessions: ThumperSession[] }[] = [
    { label: "Today", sessions: [] },
    { label: "Yesterday", sessions: [] },
    { label: "This week", sessions: [] },
    { label: "Older", sessions: [] },
  ];

  for (const s of sessions) {
    const d = new Date(s.lastMessageAt);
    if (d >= today) groups[0].sessions.push(s);
    else if (d >= yesterday) groups[1].sessions.push(s);
    else if (d >= weekAgo) groups[2].sessions.push(s);
    else groups[3].sessions.push(s);
  }

  return groups.filter((g) => g.sessions.length > 0);
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  return new Date(dateStr).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function SessionSidebar({
  sessions,
  activeSessionId,
  onSelect,
  onNew,
  onDelete,
}: SessionSidebarProps) {
  const groups = groupSessions(sessions);
  const pathname = usePathname();
  const navItems = [
    { href: "/", label: "Home", icon: Home, active: pathname === "/" },
    {
      href: "/intent",
      label: "Shop / Pay",
      icon: ShoppingBag,
      active: pathname.startsWith("/intent"),
    },
    {
      href: "/settings",
      label: "Settings",
      icon: Settings,
      active: pathname.startsWith("/settings"),
    },
    {
      href: "/provide",
      label: "Provide",
      icon: Cpu,
      active: pathname.startsWith("/provide"),
    },
  ];

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#1e2a3a]">
        <Link href="/" className="flex items-center gap-1.5 hover:opacity-80 transition-opacity">
          <GholaLogo size={22} className="text-[#eef1f8]" />
          <span className="text-base font-semibold text-[#eef1f8]">ghola</span>
        </Link>
        <button
          onClick={onNew}
          className="flex items-center gap-1.5 rounded-lg bg-[#3da8ff]/10 px-3 py-1.5 text-xs font-medium text-[#3da8ff] hover:bg-[#3da8ff]/20 transition-colors cursor-pointer"
        >
          <Plus className="h-3.5 w-3.5" />
          New
        </button>
      </div>

      {/* Navigation */}
      <div className="grid grid-cols-2 gap-1 border-b border-[#1e2a3a] px-2 py-2">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex min-h-9 items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-medium transition-colors ${
                item.active
                  ? "bg-[#3da8ff]/10 text-[#3da8ff]"
                  : "text-[#8b95a8] hover:bg-[#0f1117] hover:text-[#eef1f8]"
              }`}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{item.label}</span>
            </Link>
          );
        })}
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto">
        {sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full px-4 text-center">
            <MessageSquare className="h-8 w-8 text-[#1e2a3a] mb-3" />
            <p className="text-sm text-[#4a5568]">No conversations yet</p>
            <p className="text-xs text-[#4a5568] mt-1">
              Start a new chat to begin
            </p>
          </div>
        ) : (
          <div className="py-2">
            {groups.map((group) => (
              <div key={group.label}>
                <p className="px-4 py-1.5 text-[10px] font-medium text-[#4a5568] uppercase tracking-wider">
                  {group.label}
                </p>
                {group.sessions.map((session) => (
                  <div
                    key={session.id}
                    className="group relative"
                  >
                    <button
                      onClick={() => onSelect(session)}
                      className={`w-full text-left px-4 py-2.5 transition-colors cursor-pointer ${
                        session.id === activeSessionId
                          ? "bg-[#3da8ff]/10"
                          : "hover:bg-[#0f1117]"
                      }`}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <p
                          className={`text-sm truncate ${
                            session.id === activeSessionId
                              ? "text-[#3da8ff] font-medium"
                              : "text-[#eef1f8]"
                          }`}
                        >
                          {session.title}
                        </p>
                        <span className="shrink-0 text-[10px] text-[#4a5568]">
                          {timeAgo(session.lastMessageAt)}
                        </span>
                      </div>
                      <p className="text-xs text-[#4a5568] truncate mt-0.5">
                        {session.lastMessage}
                      </p>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(session.id);
                      }}
                      className="absolute right-2 top-1/2 -translate-y-1/2 hidden group-hover:flex items-center justify-center h-6 w-6 rounded-md text-[#4a5568] hover:text-red-400 hover:bg-red-400/10 transition-colors cursor-pointer"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
