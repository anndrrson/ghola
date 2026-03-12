"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import {
  LayoutDashboard,
  UserCircle,
  Wrench,
  FileText,
  Eye,
  BarChart3,
  ShieldCheck,
  CreditCard,
  Server,
  Menu,
  X,
} from "lucide-react";

const navItems = [
  { href: "/identity/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/identity/dashboard/profile", label: "Profile", icon: UserCircle },
  { href: "/identity/dashboard/services", label: "Services", icon: Wrench },
  { href: "/identity/dashboard/agents-txt", label: "agents.txt", icon: FileText },
  { href: "/identity/dashboard/preview", label: "Preview", icon: Eye },
  { href: "/identity/dashboard/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/identity/dashboard/verify", label: "Verify Domain", icon: ShieldCheck },
  { href: "/identity/dashboard/nodes", label: "Nodes", icon: Server },
  { href: "/identity/dashboard/billing", label: "Billing", icon: CreditCard },
];

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { authenticated, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    if (!loading && !authenticated) {
      router.push("/identity/login");
    }
  }, [loading, authenticated, router]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center pt-16">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#3da8ff] border-t-transparent" />
      </div>
    );
  }

  if (!authenticated) {
    return null;
  }

  function isActive(href: string) {
    if (href === "/identity/dashboard") return pathname === "/identity/dashboard";
    return pathname.startsWith(href);
  }

  const sidebar = (
    <nav className="flex flex-col gap-1 px-3 py-4">
      <h2 className="px-3 mb-4 text-lg font-semibold text-[#eef1f8] tracking-tight">
        Dashboard
      </h2>
      {navItems.map((item) => {
        const Icon = item.icon;
        const active = isActive(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={() => setSidebarOpen(false)}
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
    </nav>
  );

  return (
    <div className="flex min-h-screen pt-16">
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex lg:w-64 lg:flex-col lg:fixed lg:inset-y-0 lg:top-16 bg-[#0f1117] border-r border-[#1e2a3a] overflow-y-auto">
        {sidebar}
      </aside>

      {/* Mobile sidebar toggle */}
      <button
        className="lg:hidden fixed top-[4.5rem] left-4 z-40 rounded-lg bg-[#161822] p-2 text-[#8b95a8] hover:text-[#eef1f8] transition-colors cursor-pointer"
        onClick={() => setSidebarOpen(!sidebarOpen)}
        aria-label="Toggle sidebar"
      >
        {sidebarOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
      </button>

      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <>
          <div
            className="lg:hidden fixed inset-0 z-30 bg-black/50 pt-16"
            onClick={() => setSidebarOpen(false)}
          />
          <aside className="lg:hidden fixed inset-y-0 left-0 z-40 w-64 bg-[#0f1117] border-r border-[#1e2a3a] pt-16 overflow-y-auto">
            {sidebar}
          </aside>
        </>
      )}

      {/* Main content */}
      <main className="flex-1 lg:ml-64">
        <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
          {children}
        </div>
      </main>
    </div>
  );
}
