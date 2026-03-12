"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import {
  getAnalytics,
  getAnalyticsTimeline,
  getAgentStats,
  getDiscoveryFunnel,
} from "@/lib/api";
import type {
  AnalyticsSummary,
  AnalyticsTimeline,
  AgentStats,
  DiscoveryFunnel,
} from "@/lib/types";
import {
  BarChart3,
  Eye,
  Globe,
  Zap,
  Bot,
  FileText,
  TrendingUp,
  ArrowRight,
} from "lucide-react";

interface StatCardProps {
  label: string;
  value: number;
  icon: React.ReactNode;
  description: string;
}

function StatCard({ label, value, icon, description }: StatCardProps) {
  return (
    <div className="rounded-xl border border-[#1e2a3a] bg-[#161822] p-6">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-medium text-[#8b95a8]">{label}</p>
          <p className="mt-2 text-3xl font-bold tracking-tight text-[#eef1f8]">
            {value.toLocaleString()}
          </p>
          <p className="mt-1 text-xs text-[#4a5568]">{description}</p>
        </div>
        <div className="rounded-lg bg-[#2b96f0]/10 border border-[#2b96f0]/20 p-2.5">
          {icon}
        </div>
      </div>
    </div>
  );
}

function TimelineChart({ timeline }: { timeline: AnalyticsTimeline }) {
  const maxViews = Math.max(...timeline.days.map((d) => d.views), 1);

  return (
    <div className="rounded-xl border border-[#1e2a3a] bg-[#161822] p-6">
      <div className="flex items-center gap-2 mb-4">
        <TrendingUp className="h-5 w-5 text-[#8b95a8]" />
        <h2 className="text-lg font-semibold text-[#eef1f8]">
          Views — Last 30 Days
        </h2>
      </div>
      <div className="flex items-end gap-[3px] h-40">
        {timeline.days.map((day) => {
          const heightPct = (day.views / maxViews) * 100;
          return (
            <div
              key={day.date}
              className="flex-1 min-w-0 group relative"
              style={{ height: "100%" }}
            >
              <div
                className="absolute bottom-0 left-0 right-0 rounded-t bg-[#3da8ff]/70 hover:bg-[#3da8ff] transition-colors cursor-default"
                style={{ height: `${Math.max(heightPct, 2)}%` }}
                title={`${day.date}: ${day.views} views, ${day.resolves} resolves, ${day.service_calls} service calls`}
              />
            </div>
          );
        })}
      </div>
      <div className="flex justify-between mt-2 text-xs text-[#4a5568]">
        <span>{timeline.days[0]?.date || ""}</span>
        <span>{timeline.days[timeline.days.length - 1]?.date || ""}</span>
      </div>
    </div>
  );
}

function AgentsTable({ stats }: { stats: AgentStats }) {
  return (
    <div className="rounded-xl border border-[#1e2a3a] bg-[#161822] p-6">
      <div className="flex items-center gap-2 mb-4">
        <Bot className="h-5 w-5 text-[#8b95a8]" />
        <h2 className="text-lg font-semibold text-[#eef1f8]">Top Agents</h2>
      </div>
      {stats.agents.length === 0 ? (
        <div className="rounded-lg border border-[#1e2a3a]/50 bg-[#0f1117] px-6 py-10 text-center">
          <Bot className="mx-auto h-10 w-10 text-[#4a5568] mb-3" />
          <p className="text-sm text-[#8b95a8]">
            No agent interactions recorded yet.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#1e2a3a] text-left">
                <th className="pb-3 font-medium text-[#8b95a8]">Agent</th>
                <th className="pb-3 font-medium text-[#8b95a8] text-right">Interactions</th>
                <th className="pb-3 font-medium text-[#8b95a8] text-right">Last Seen</th>
              </tr>
            </thead>
            <tbody>
              {stats.agents.map((agent) => (
                <tr key={agent.identifier} className="border-b border-[#1e2a3a]/50">
                  <td className="py-3 text-[#eef1f8] font-mono text-xs">
                    {agent.identifier}
                  </td>
                  <td className="py-3 text-[#8b95a8] text-right">
                    {agent.interactions.toLocaleString()}
                  </td>
                  <td className="py-3 text-[#4a5568] text-right">
                    {new Date(agent.last_seen).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FunnelChart({ funnel }: { funnel: DiscoveryFunnel }) {
  const steps = [
    { label: "agents.txt fetched", value: funnel.agents_txt_fetched },
    { label: ".well-known fetched", value: funnel.well_known_fetched },
    { label: "Profile resolved", value: funnel.profile_resolved },
    { label: "Service called", value: funnel.service_called },
  ];
  const maxValue = Math.max(...steps.map((s) => s.value), 1);

  return (
    <div className="rounded-xl border border-[#1e2a3a] bg-[#161822] p-6">
      <div className="flex items-center gap-2 mb-4">
        <BarChart3 className="h-5 w-5 text-[#8b95a8]" />
        <h2 className="text-lg font-semibold text-[#eef1f8]">Discovery Funnel</h2>
      </div>
      <div className="space-y-3">
        {steps.map((step, i) => {
          const widthPct = (step.value / maxValue) * 100;
          const prevValue = i > 0 ? steps[i - 1].value : null;
          const conversionPct =
            prevValue && prevValue > 0
              ? ((step.value / prevValue) * 100).toFixed(1)
              : null;

          return (
            <div key={step.label}>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2 text-sm text-[#8b95a8]">
                  {i > 0 && <ArrowRight className="h-3 w-3 text-[#4a5568]" />}
                  {step.label}
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-medium text-[#eef1f8]">
                    {step.value.toLocaleString()}
                  </span>
                  {conversionPct && (
                    <span className="text-xs text-[#4a5568]">
                      ({conversionPct}%)
                    </span>
                  )}
                </div>
              </div>
              <div className="h-6 rounded bg-[#0f1117] overflow-hidden">
                <div
                  className="h-full rounded bg-[#2b96f0]/60 transition-all"
                  style={{ width: `${Math.max(widthPct, 2)}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function AnalyticsPage() {
  const { authenticated, loading: authLoading } = useAuth();
  const router = useRouter();

  const [analytics, setAnalytics] = useState<AnalyticsSummary | null>(null);
  const [timeline, setTimeline] = useState<AnalyticsTimeline | null>(null);
  const [agentStats, setAgentStats] = useState<AgentStats | null>(null);
  const [funnel, setFunnel] = useState<DiscoveryFunnel | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !authenticated) {
      router.push("/identity/login");
    }
  }, [authLoading, authenticated, router]);

  useEffect(() => {
    if (!authenticated) return;
    setLoading(true);

    Promise.all([
      getAnalytics().catch(() => null),
      getAnalyticsTimeline(30).catch(() => null),
      getAgentStats().catch(() => null),
      getDiscoveryFunnel().catch(() => null),
    ])
      .then(([analyticsData, timelineData, agentsData, funnelData]) => {
        if (analyticsData) setAnalytics(analyticsData);
        if (timelineData) setTimeline(timelineData);
        if (agentsData) setAgentStats(agentsData);
        if (funnelData) setFunnel(funnelData);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [authenticated]);

  if (authLoading || !authenticated) {
    return (
      <div className="flex h-screen items-center justify-center pt-16">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#3da8ff] border-t-transparent" />
      </div>
    );
  }

  const uniqueAgents = agentStats?.agents.length ?? 0;
  const totalServiceCalls =
    timeline?.days.reduce((sum, d) => sum + d.service_calls, 0) ?? 0;

  return (
    <div className="space-y-8">
      <div>
        <div className="flex items-center gap-2">
          <BarChart3 className="h-6 w-6 text-[#3da8ff]" />
          <h1 className="text-2xl font-bold text-[#eef1f8]">Analytics</h1>
        </div>
        <p className="mt-1 text-[#8b95a8]">
          Monitor how agents discover and interact with your business identity
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-600/30 bg-red-900/20 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {loading ? (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div
                key={i}
                className="h-36 animate-pulse rounded-xl bg-[#161822]"
              />
            ))}
          </div>
        </div>
      ) : (
        <div className="space-y-8">
          {/* Stat Cards — 6 total */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <StatCard
              label="Profile Views"
              value={analytics?.profile_views ?? 0}
              icon={<Eye className="h-5 w-5 text-[#3da8ff]" />}
              description="Times your profile was viewed"
            />
            <StatCard
              label="Resolve Requests"
              value={analytics?.resolve_count ?? 0}
              icon={<Globe className="h-5 w-5 text-[#3da8ff]" />}
              description="Agent identity resolutions"
            />
            <StatCard
              label="Total API Calls"
              value={analytics?.total_api_calls ?? 0}
              icon={<Zap className="h-5 w-5 text-[#3da8ff]" />}
              description="Calls to your API endpoints"
            />
            <StatCard
              label="agents.txt Fetches"
              value={funnel?.agents_txt_fetched ?? 0}
              icon={<FileText className="h-5 w-5 text-[#3da8ff]" />}
              description="Discovery file downloads"
            />
            <StatCard
              label="Unique Agents"
              value={uniqueAgents}
              icon={<Bot className="h-5 w-5 text-[#3da8ff]" />}
              description="Distinct agents interacting"
            />
            <StatCard
              label="Service Calls"
              value={totalServiceCalls}
              icon={<TrendingUp className="h-5 w-5 text-[#3da8ff]" />}
              description="Last 30 days via timeline"
            />
          </div>

          {/* Timeline Chart */}
          {timeline && timeline.days.length > 0 && (
            <TimelineChart timeline={timeline} />
          )}

          {/* Top Agents */}
          {agentStats && <AgentsTable stats={agentStats} />}

          {/* Discovery Funnel */}
          {funnel && <FunnelChart funnel={funnel} />}
        </div>
      )}
    </div>
  );
}
