"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { getServiceDetail } from "@/lib/api";
import type { ServiceDetail } from "@/lib/types";
import {
  ArrowLeft,
  ExternalLink,
  Shield,
  Clock,
  Zap,
  Star,
  Globe,
  Activity,
  DollarSign,
} from "lucide-react";

function formatUsdc(micro: number): string {
  return `$${(micro / 1_000_000).toFixed(2)} USDC`;
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active: "bg-green-500/10 text-green-400",
    degraded: "bg-yellow-500/10 text-yellow-400",
    pending: "bg-[#3da8ff]/10 text-[#3da8ff]",
    offline: "bg-red-500/10 text-red-400",
  };
  return (
    <span className={`rounded-full px-3 py-1 text-xs font-medium capitalize ${colors[status] ?? colors.pending}`}>
      {status}
    </span>
  );
}

export default function ServiceDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const router = useRouter();
  const [service, setService] = useState<ServiceDetail | null>(null);
  const [heartbeats, setHeartbeats] = useState<unknown[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!slug) return;
    (async () => {
      try {
        const res = await getServiceDetail(slug);
        setService(res.service);
        setHeartbeats(res.heartbeats ?? []);
      } catch {
        setError("Service not found.");
      } finally {
        setLoading(false);
      }
    })();
  }, [slug]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#08090d]">
        <div className="mx-auto max-w-4xl px-4 py-10 space-y-6">
          <div className="h-8 w-48 animate-pulse rounded-lg bg-[#161822]" />
          <div className="h-64 animate-pulse rounded-xl bg-[#161822]" />
          <div className="h-40 animate-pulse rounded-xl bg-[#161822]" />
        </div>
      </div>
    );
  }

  if (error || !service) {
    return (
      <div className="min-h-screen bg-[#08090d]">
        <div className="mx-auto max-w-4xl px-4 py-20 text-center">
          <p className="text-[#8b95a8]">{error || "Service not found."}</p>
          <button onClick={() => router.push("/marketplace")} className="mt-4 text-[#3da8ff] hover:underline text-sm">
            Back to marketplace
          </button>
        </div>
      </div>
    );
  }

  const endpoints = (service.endpoints ?? []) as Array<{
    method?: string;
    path?: string;
    description?: string;
  }>;

  const hbData = (heartbeats.slice(-10) ?? []) as Array<{
    status?: string;
  }>;

  return (
    <div className="min-h-screen bg-[#08090d]">
      <div className="mx-auto max-w-4xl px-4 py-10">
        {/* Back link */}
        <Link href="/marketplace" className="mb-6 inline-flex items-center gap-1 text-sm text-[#8b95a8] hover:text-[#3da8ff] transition-colors">
          <ArrowLeft className="h-4 w-4" /> Back to marketplace
        </Link>

        {/* Header */}
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-[#eef1f8]">{service.name}</h1>
              <StatusBadge status={service.status} />
            </div>
            <p className="mt-1 text-sm text-[#8b95a8]">
              by <span className="font-mono text-xs text-[#3da8ff]">{service.owner_did.slice(0, 24)}...</span>
            </p>
          </div>
          <span className="shrink-0 rounded-full bg-[#3da8ff]/10 px-3 py-1 text-xs font-medium capitalize text-[#3da8ff]">
            {service.category.replace("-", " ")}
          </span>
        </div>

        {/* Stats row */}
        <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[
            { label: "Total Requests", value: service.total_requests.toLocaleString(), icon: Zap },
            { label: "Uptime", value: `${service.uptime_percent.toFixed(1)}%`, icon: Activity },
            { label: "Avg Latency", value: `${service.avg_latency_ms}ms`, icon: Clock },
            { label: "Reviews", value: service.avg_rating !== null ? `${service.avg_rating.toFixed(1)} (${service.review_count})` : `${service.review_count} reviews`, icon: Star },
          ].map((s) => {
            const Icon = s.icon;
            return (
              <div key={s.label} className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-4">
                <div className="flex items-center gap-2 text-[#8b95a8]">
                  <Icon className="h-4 w-4" />
                  <span className="text-xs">{s.label}</span>
                </div>
                <p className="mt-1 text-lg font-bold text-[#eef1f8]">{s.value}</p>
              </div>
            );
          })}
        </div>

        {/* Description */}
        <div className="mb-6 rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
          <h2 className="mb-2 text-sm font-semibold text-[#eef1f8]">Description</h2>
          <p className="text-sm leading-relaxed text-[#8b95a8]">{service.description}</p>
        </div>

        {/* Pricing + SLA row */}
        <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-[#eef1f8]">
              <DollarSign className="h-4 w-4 text-[#3da8ff]" /> Pricing
            </h2>
            <div className="space-y-2 text-sm text-[#8b95a8]">
              <p>Model: <span className="capitalize text-[#eef1f8]">{service.pricing_model.replace("_", " ")}</span></p>
              <p>Price: <span className="text-[#eef1f8]">{formatUsdc(service.price_micro_usdc)}</span></p>
              {service.free_tier_requests !== null && service.free_tier_requests > 0 && (
                <p>Free Tier: <span className="text-[#eef1f8]">{service.free_tier_requests.toLocaleString()} requests</span></p>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-[#eef1f8]">
              <Shield className="h-4 w-4 text-[#3da8ff]" /> SLA
            </h2>
            <div className="space-y-2 text-sm text-[#8b95a8]">
              {service.sla_uptime_percent !== null && (
                <p>Uptime Guarantee: <span className="text-[#eef1f8]">{service.sla_uptime_percent}%</span></p>
              )}
              {service.sla_latency_p50_ms !== null && (
                <p>P50 Latency: <span className="text-[#eef1f8]">{service.sla_latency_p50_ms}ms</span></p>
              )}
              {service.sla_latency_p99_ms !== null && (
                <p>P99 Latency: <span className="text-[#eef1f8]">{service.sla_latency_p99_ms}ms</span></p>
              )}
              {service.sla_uptime_percent === null && service.sla_latency_p50_ms === null && (
                <p className="italic">No SLA defined</p>
              )}
            </div>
          </div>
        </div>

        {/* Endpoints */}
        {endpoints.length > 0 && (
          <div className="mb-6 rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
            <h2 className="mb-3 text-sm font-semibold text-[#eef1f8]">Endpoints</h2>
            <div className="space-y-2">
              {endpoints.map((ep, i) => (
                <div key={i} className="flex items-start gap-3 rounded-lg bg-[#161822] px-3 py-2">
                  <span className="shrink-0 rounded bg-[#3da8ff]/10 px-2 py-0.5 text-xs font-mono font-medium uppercase text-[#3da8ff]">
                    {ep.method ?? "GET"}
                  </span>
                  <span className="font-mono text-sm text-[#eef1f8]">{ep.path ?? "/"}</span>
                  {ep.description && <span className="ml-auto text-xs text-[#8b95a8]">{ep.description}</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Heartbeats */}
        {hbData.length > 0 && (
          <div className="mb-6 rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
            <h2 className="mb-3 text-sm font-semibold text-[#eef1f8]">Heartbeat History</h2>
            <div className="flex items-center gap-1.5">
              {hbData.map((hb, i) => (
                <div
                  key={i}
                  title={hb.status ?? "unknown"}
                  className={`h-6 w-6 rounded-md ${
                    hb.status === "ok" || hb.status === "healthy"
                      ? "bg-green-500/70"
                      : "bg-red-500/70"
                  }`}
                />
              ))}
            </div>
          </div>
        )}

        {/* Links */}
        <div className="flex flex-wrap gap-3">
          {service.website && (
            <a href={service.website} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#1e2a3a] bg-[#0f1117] px-4 py-2 text-sm text-[#8b95a8] hover:bg-[#161822] transition-colors">
              <Globe className="h-4 w-4" /> Website
            </a>
          )}
          {service.openapi_url && (
            <a href={service.openapi_url} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#1e2a3a] bg-[#0f1117] px-4 py-2 text-sm text-[#8b95a8] hover:bg-[#161822] transition-colors">
              <ExternalLink className="h-4 w-4" /> View OpenAPI Spec
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
