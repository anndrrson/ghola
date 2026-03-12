"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { getConsumerProfile } from "@/lib/api";
import type { PublicProfile } from "@/lib/types";
import {
  UserCircle,
  Plug,
  Download,
  Copy,
  Check,
  Fingerprint,
} from "lucide-react";

export default function ConsumerDashboardPage() {
  const { user } = useAuth();
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    getConsumerProfile()
      .then(setProfile)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  function copyDid() {
    if (!profile?.did) return;
    navigator.clipboard.writeText(profile.did);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function computeCompleteness(p: PublicProfile): number {
    let filled = 0;
    let total = 0;
    const checks: boolean[] = [
      !!p.display_name,
      !!p.handle,
      !!p.avatar_url,
      !!p.bio,
      !!p.timezone,
      !!p.agent_preferences.communication_style,
      !!p.agent_preferences.response_format,
      p.agent_preferences.expertise_areas.length > 0,
      !!p.agent_preferences.location?.city ||
        !!p.agent_preferences.location?.country,
    ];
    total = checks.length;
    filled = checks.filter(Boolean).length;
    return Math.round((filled / total) * 100);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#3da8ff] border-t-transparent" />
      </div>
    );
  }

  const completeness = profile ? computeCompleteness(profile) : 0;

  return (
    <div className="space-y-8">
      {/* Welcome header */}
      <div>
        <h1 className="text-2xl font-bold text-[#eef1f8]">
          Welcome back{profile?.display_name ? `, ${profile.display_name}` : ""}
        </h1>
        <p className="mt-1 text-[#8b95a8]">
          Manage your sovereign AI identity.
        </p>
      </div>

      {/* DID display */}
      {profile?.did && (
        <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
          <div className="flex items-center gap-3 mb-2">
            <Fingerprint className="h-5 w-5 text-[#3da8ff]" />
            <span className="text-sm font-medium text-[#8b95a8]">
              Your Decentralized Identifier
            </span>
          </div>
          <div className="flex items-center gap-3">
            <code className="flex-1 rounded-lg bg-[#161822] px-4 py-2.5 text-sm text-[#8b95a8] font-mono overflow-x-auto">
              {profile.did}
            </code>
            <button
              onClick={copyDid}
              className="shrink-0 rounded-lg bg-[#161822] p-2.5 text-[#8b95a8] hover:text-[#eef1f8] transition-colors cursor-pointer"
              title="Copy DID"
            >
              {copied ? (
                <Check className="h-4 w-4 text-green-400" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </button>
          </div>
          {profile.on_chain_registered && (
            <p className="mt-2 text-xs text-green-400">
              Registered on Solana
            </p>
          )}
        </div>
      )}

      {/* Profile completeness */}
      <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-medium text-[#8b95a8]">
            Profile Completeness
          </span>
          <span className="text-sm font-semibold text-[#3da8ff]">
            {completeness}%
          </span>
        </div>
        <div className="h-2 rounded-full bg-[#161822] overflow-hidden">
          <div
            className="h-full rounded-full bg-[#3da8ff] transition-all duration-500"
            style={{ width: `${completeness}%` }}
          />
        </div>
        {completeness < 100 && (
          <p className="mt-2 text-xs text-[#4a5568]">
            Complete your profile so AI agents can better personalize your experience.
          </p>
        )}
      </div>

      {/* Quick action cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Link
          href="/identity/consumer/dashboard/profile"
          className="group rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5 hover:border-[#3da8ff]/40 transition-colors"
        >
          <UserCircle className="h-8 w-8 text-[#3da8ff] mb-3" />
          <h3 className="text-sm font-semibold text-[#eef1f8] group-hover:text-[#3da8ff] transition-colors">
            Edit Profile
          </h3>
          <p className="mt-1 text-xs text-[#4a5568]">
            Update your display name, preferences, and agent settings.
          </p>
        </Link>

        <Link
          href="/identity/consumer/dashboard/connections"
          className="group rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5 hover:border-[#3da8ff]/40 transition-colors"
        >
          <Plug className="h-8 w-8 text-[#3da8ff] mb-3" />
          <h3 className="text-sm font-semibold text-[#eef1f8] group-hover:text-[#3da8ff] transition-colors">
            Manage AI Connections
          </h3>
          <p className="mt-1 text-xs text-[#4a5568]">
            Connect your identity to Claude, ChatGPT, and more.
          </p>
        </Link>

        <Link
          href="/identity/consumer/dashboard/export"
          className="group rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5 hover:border-[#3da8ff]/40 transition-colors"
        >
          <Download className="h-8 w-8 text-[#3da8ff] mb-3" />
          <h3 className="text-sm font-semibold text-[#eef1f8] group-hover:text-[#3da8ff] transition-colors">
            Export Identity
          </h3>
          <p className="mt-1 text-xs text-[#4a5568]">
            Download your encrypted wallet or go fully self-custody.
          </p>
        </Link>
      </div>
    </div>
  );
}
