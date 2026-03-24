"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getMyServices } from "@/lib/api";
import type { ServiceListingResponse } from "@/lib/types";
import { BarChart3, Users, Clock, Star, DollarSign } from "lucide-react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080/v1";

interface AgentRow { agent_did: string; total_requests: number; total_amount_micro_usdc: number }
interface UptimePoint { timestamp: string; status: "ok" | "error" }
interface ServiceAnalytics {
  revenue_timeline: { date: string; amount_micro_usdc: number }[];
  top_agents: AgentRow[];
  uptime_timeline: UptimePoint[];
  avg_rating: number | null;
  review_count: number;
  pending_settlement_micro_usdc: number;
}

const fmtUsdc = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;
const Skel = ({ className }: { className: string }) => (
  <div className={`animate-pulse rounded-lg bg-[#161822] ${className}`} />
);

export default function MerchantAnalyticsPage() {
  const router = useRouter();
  const [services, setServices] = useState<ServiceListingResponse[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [analytics, setAnalytics] = useState<ServiceAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [aLoading, setALoading] = useState(false);

  useEffect(() => {
    const token = typeof window !== "undefined" ? localStorage.getItem("ghola_token") : null;
    if (!token) { router.push("/signin"); return; }
    (async () => {
      try {
        const res = await getMyServices();
        setServices(res.services);
        if (res.services.length > 0) setSelectedId(res.services[0].id);
      } catch (err) { console.error("Failed to load services:", err); }
      finally { setLoading(false); }
    })();
  }, [router]);

  useEffect(() => {
    if (!selectedId) return;
    const token = localStorage.getItem("ghola_token");
    if (!token) return;
    setALoading(true);
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/services/${selectedId}/analytics`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`API error ${res.status}`);
        setAnalytics(await res.json());
      } catch (err) { console.error("Failed to load analytics:", err); setAnalytics(null); }
      finally { setALoading(false); }
    })();
  }, [selectedId]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#08090d]">
        <div className="mx-auto max-w-6xl px-4 py-10 space-y-6">
          <Skel className="h-8 w-64" />
          <Skel className="h-10 w-72" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {[1, 2, 3].map((i) => <Skel key={i} className="h-28" />)}
          </div>
          <Skel className="h-56" />
        </div>
      </div>
    );
  }

  const maxRev = analytics ? Math.max(...analytics.revenue_timeline.map((d) => d.amount_micro_usdc), 1) : 1;
  const stats = analytics ? [
    { label: "Avg Rating", value: analytics.avg_rating?.toFixed(1) ?? "N/A", sub: `${analytics.review_count} reviews`, icon: Star },
    { label: "Pending Settlement", value: fmtUsdc(analytics.pending_settlement_micro_usdc), sub: "USDC", icon: DollarSign },
    { label: "Top Agents", value: String(analytics.top_agents.length), sub: "unique agents", icon: Users },
  ] : [];

  return (
    <div className="min-h-screen bg-[#08090d]">
      <div className="mx-auto max-w-6xl px-4 py-10">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-[#eef1f8]">Service Analytics</h1>
          <p className="mt-1 text-[#8b95a8]">Performance metrics for your registered services.</p>
        </div>

        {services.length === 0 ? (
          <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-12 text-center">
            <BarChart3 className="mx-auto mb-4 h-12 w-12 text-[#8b95a8]" />
            <p className="text-[#8b95a8]">No services registered yet.</p>
          </div>
        ) : (
          <>
            <select
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
              className="mb-6 w-full max-w-sm rounded-lg border border-[#1e2a3a] bg-[#0f1117] px-4 py-2.5 text-sm text-[#eef1f8] outline-none focus:border-[#3da8ff]"
            >
              {services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>

            {aLoading ? (
              <div className="space-y-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  {[1, 2, 3].map((i) => <Skel key={i} className="h-28" />)}
                </div>
                <Skel className="h-56" />
                <Skel className="h-44" />
              </div>
            ) : analytics ? (
              <div className="space-y-6">
                {/* Stat cards */}
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  {stats.map((s) => {
                    const Icon = s.icon;
                    return (
                      <div key={s.label} className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
                        <div className="flex items-center gap-3">
                          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#3da8ff]/10">
                            <Icon className="h-5 w-5 text-[#3da8ff]" />
                          </div>
                          <div>
                            <p className="text-sm text-[#8b95a8]">{s.label}</p>
                            <p className="text-2xl font-bold text-[#eef1f8]">{s.value}</p>
                            <p className="text-xs text-[#8b95a8]">{s.sub}</p>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Revenue bar chart */}
                <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
                  <div className="mb-4 flex items-center gap-2 text-[#eef1f8]">
                    <BarChart3 className="h-5 w-5 text-[#3da8ff]" />
                    <h2 className="font-semibold">Revenue</h2>
                  </div>
                  {analytics.revenue_timeline.length === 0 ? (
                    <p className="py-8 text-center text-sm text-[#8b95a8]">No revenue data yet.</p>
                  ) : (
                    <div className="flex items-end gap-1" style={{ height: 160 }}>
                      {analytics.revenue_timeline.map((d) => (
                        <div key={d.date} className="group relative flex flex-1 flex-col items-center">
                          <div className="w-full rounded-t bg-[#3da8ff] group-hover:bg-[#5bb8ff] transition-colors"
                            style={{ height: `${Math.max((d.amount_micro_usdc / maxRev) * 100, 2)}%` }} />
                          <span className="mt-1 text-[9px] text-[#8b95a8] truncate w-full text-center">{d.date.slice(5)}</span>
                          <div className="pointer-events-none absolute -top-8 rounded bg-[#161822] px-2 py-1 text-xs text-[#eef1f8] opacity-0 group-hover:opacity-100">
                            {fmtUsdc(d.amount_micro_usdc)}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Top agents */}
                <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
                  <div className="mb-4 flex items-center gap-2 text-[#eef1f8]">
                    <Users className="h-5 w-5 text-[#3da8ff]" />
                    <h2 className="font-semibold">Top Agents</h2>
                  </div>
                  {analytics.top_agents.length === 0 ? (
                    <p className="py-4 text-center text-sm text-[#8b95a8]">No agent activity yet.</p>
                  ) : (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-[#1e2a3a] text-left text-[#8b95a8]">
                          <th className="pb-2 font-medium">Agent DID</th>
                          <th className="pb-2 font-medium text-right">Requests</th>
                          <th className="pb-2 font-medium text-right">Amount (USDC)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {analytics.top_agents.map((a) => (
                          <tr key={a.agent_did} className="border-b border-[#1e2a3a]/50 hover:bg-[#161822]">
                            <td className="py-2 font-mono text-xs text-[#eef1f8] truncate max-w-[240px]">{a.agent_did}</td>
                            <td className="py-2 text-right text-[#eef1f8]">{a.total_requests.toLocaleString()}</td>
                            <td className="py-2 text-right text-[#3da8ff]">{fmtUsdc(a.total_amount_micro_usdc)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                {/* Uptime timeline */}
                <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
                  <div className="mb-4 flex items-center gap-2 text-[#eef1f8]">
                    <Clock className="h-5 w-5 text-[#3da8ff]" />
                    <h2 className="font-semibold">Uptime Timeline</h2>
                  </div>
                  {analytics.uptime_timeline.length === 0 ? (
                    <p className="py-4 text-center text-sm text-[#8b95a8]">No uptime data yet.</p>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {analytics.uptime_timeline.map((pt, i) => (
                        <div key={i} title={`${pt.timestamp} - ${pt.status}`}
                          className={`h-3 w-3 rounded-full ${pt.status === "ok" ? "bg-green-500" : "bg-red-500"}`} />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-12 text-center">
                <p className="text-[#8b95a8]">Failed to load analytics for this service.</p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
