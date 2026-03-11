"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getProfile, getAnalytics } from "@/lib/api";
import type { BusinessProfile, AnalyticsSummary } from "@/lib/types";
import {
  Eye,
  Globe,
  Zap,
  UserCircle,
  Wrench,
  FileText,
  ShieldCheck,
  AlertTriangle,
} from "lucide-react";

export default function DashboardPage() {
  const [profile, setProfile] = useState<BusinessProfile | null>(null);
  const [analytics, setAnalytics] = useState<AnalyticsSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [p, a] = await Promise.all([getProfile(), getAnalytics()]);
        setProfile(p);
        setAnalytics(a);
      } catch (err) {
        console.error("Failed to load dashboard data:", err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) {
    return (
      <div className="space-y-6">
        {/* Welcome skeleton */}
        <div className="h-8 w-72 animate-pulse rounded-lg bg-gray-800" />
        <div className="h-5 w-96 animate-pulse rounded-lg bg-gray-800" />

        {/* Stats skeleton */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 mt-8">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-28 animate-pulse rounded-xl bg-gray-800"
            />
          ))}
        </div>

        {/* Quick actions skeleton */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 mt-8">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="h-24 animate-pulse rounded-xl bg-gray-800"
            />
          ))}
        </div>
      </div>
    );
  }

  const stats = [
    {
      label: "Profile Views",
      value: analytics?.profile_views ?? 0,
      icon: Eye,
    },
    {
      label: "Resolve Requests",
      value: analytics?.resolve_count ?? 0,
      icon: Globe,
    },
    {
      label: "Total API Calls",
      value: analytics?.total_api_calls ?? 0,
      icon: Zap,
    },
  ];

  const quickActions = [
    {
      label: "Edit Profile",
      description: "Update your business information and contact details",
      href: "/identity/dashboard/profile",
      icon: UserCircle,
    },
    {
      label: "Manage Services",
      description: "Add, edit, or remove your service offerings",
      href: "/identity/dashboard/services",
      icon: Wrench,
    },
    {
      label: "Generate agents.txt",
      description: "Create and download your agents.txt file",
      href: "/identity/dashboard/agents-txt",
      icon: FileText,
    },
    {
      label: "Verify Domain",
      description: "Prove ownership of your domain for trust signals",
      href: "/identity/dashboard/verify",
      icon: ShieldCheck,
    },
  ];

  return (
    <div className="space-y-8">
      {/* Domain verification banner */}
      {profile && !profile.verified_domain && (
        <div className="flex items-center gap-3 rounded-xl border border-yellow-600/30 bg-yellow-500/10 px-4 py-3">
          <AlertTriangle className="h-5 w-5 shrink-0 text-yellow-500" />
          <p className="text-sm text-yellow-200">
            Verify your domain to build trust with AI agents.{" "}
            <Link
              href="/identity/dashboard/verify"
              className="font-medium text-yellow-400 underline underline-offset-2 hover:text-yellow-300"
            >
              Verify now
            </Link>
          </p>
        </div>
      )}

      {/* Welcome */}
      <div>
        <h1 className="text-2xl font-bold text-white">
          Welcome back, {profile?.business_name ?? "there"}
        </h1>
        <p className="mt-1 text-gray-400">
          Here is an overview of your SAID identity.
        </p>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <div
              key={stat.label}
              className="rounded-xl border border-gray-800 bg-gray-800/50 p-5"
            >
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-said-500/10">
                  <Icon className="h-5 w-5 text-said-400" />
                </div>
                <div>
                  <p className="text-sm text-gray-400">{stat.label}</p>
                  <p className="text-2xl font-bold text-white">
                    {stat.value.toLocaleString()}
                  </p>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Quick actions */}
      <div>
        <h2 className="mb-4 text-lg font-semibold text-white">
          Quick Actions
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {quickActions.map((action) => {
            const Icon = action.icon;
            return (
              <Link
                key={action.href}
                href={action.href}
                className="group flex items-start gap-4 rounded-xl border border-gray-800 bg-gray-800/50 p-5 transition-colors hover:border-said-500/30 hover:bg-gray-800"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-said-500/10 transition-colors group-hover:bg-said-500/20">
                  <Icon className="h-5 w-5 text-said-400" />
                </div>
                <div>
                  <p className="font-medium text-white">{action.label}</p>
                  <p className="mt-0.5 text-sm text-gray-400">
                    {action.description}
                  </p>
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
