"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getMyServices } from "@/lib/api";
import type { ServiceListingResponse } from "@/lib/types";
import {
  Plus,
  Activity,
  Zap,
  DollarSign,
  Package,
  ArrowRight,
} from "lucide-react";

function formatUsdc(micro: number): string {
  return `$${(micro / 1_000_000).toFixed(2)}`;
}

export default function MerchantDashboardPage() {
  const router = useRouter();
  const [services, setServices] = useState<ServiceListingResponse[]>([]);
  const [totalRevenue, setTotalRevenue] = useState(0);
  const [totalRequests, setTotalRequests] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = typeof window !== "undefined" ? localStorage.getItem("ghola_token") : null;
    if (!token) {
      router.push("/signin");
      return;
    }
    (async () => {
      try {
        const res = await getMyServices();
        setServices(res.services);
        setTotalRevenue(res.total_revenue_micro_usdc);
        setTotalRequests(res.total_requests);
      } catch (err) {
        console.error("Failed to load merchant services:", err);
      } finally {
        setLoading(false);
      }
    })();
  }, [router]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#08090d]">
        <div className="mx-auto max-w-6xl px-4 py-10 space-y-6">
          <div className="h-8 w-64 animate-pulse rounded-lg bg-[#161822]" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-28 animate-pulse rounded-xl bg-[#161822]" />
            ))}
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {[1, 2].map((i) => (
              <div key={i} className="h-44 animate-pulse rounded-xl bg-[#161822]" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  const stats = [
    { label: "Total Services", value: String(services.length), icon: Package },
    { label: "Total Requests", value: totalRequests.toLocaleString(), icon: Zap },
    { label: "Est. Revenue", value: formatUsdc(totalRevenue), icon: DollarSign },
  ];

  return (
    <div className="min-h-screen bg-[#08090d]">
      <div className="mx-auto max-w-6xl px-4 py-10">
        {/* Header */}
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-[#eef1f8]">Merchant Dashboard</h1>
            <p className="mt-1 text-[#8b95a8]">Manage your headless merchant services.</p>
          </div>
          <Link
            href="/merchant/register"
            className="inline-flex items-center gap-2 rounded-lg bg-[#3da8ff] px-4 py-2 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] transition-colors"
          >
            <Plus className="h-4 w-4" /> Register Service
          </Link>
        </div>

        {/* Stats */}
        <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {stats.map((stat) => {
            const Icon = stat.icon;
            return (
              <div key={stat.label} className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#3da8ff]/10">
                    <Icon className="h-5 w-5 text-[#3da8ff]" />
                  </div>
                  <div>
                    <p className="text-sm text-[#8b95a8]">{stat.label}</p>
                    <p className="text-2xl font-bold text-[#eef1f8]">{stat.value}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Services list */}
        {services.length === 0 ? (
          <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-12 text-center">
            <Package className="mx-auto mb-4 h-12 w-12 text-[#8b95a8]" />
            <p className="text-[#8b95a8]">No services registered yet.</p>
            <Link
              href="/merchant/register"
              className="mt-4 inline-flex items-center gap-2 rounded-lg bg-[#3da8ff] px-4 py-2 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] transition-colors"
            >
              <Plus className="h-4 w-4" /> Register Your First Service
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {services.map((svc) => {
              const statusColor =
                svc.status === "active"
                  ? "text-green-400"
                  : svc.status === "degraded"
                  ? "text-yellow-400"
                  : "text-[#8b95a8]";
              return (
                <Link
                  key={svc.id}
                  href={`/marketplace/${svc.slug}`}
                  className="group rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5 transition-colors hover:border-[#3da8ff]/30 hover:bg-[#161822]"
                >
                  <div className="mb-3 flex items-start justify-between">
                    <h3 className="font-semibold text-[#eef1f8]">{svc.name}</h3>
                    <span className={`flex items-center gap-1 text-xs font-medium capitalize ${statusColor}`}>
                      <Activity className="h-3 w-3" /> {svc.status}
                    </span>
                  </div>
                  <p className="mb-4 line-clamp-2 text-sm text-[#8b95a8]">{svc.description}</p>
                  <div className="flex items-center justify-between text-xs text-[#8b95a8]">
                    <div className="flex items-center gap-4">
                      <span className="flex items-center gap-1">
                        <Zap className="h-3 w-3" /> {svc.total_requests.toLocaleString()} req
                      </span>
                      <span>{svc.uptime_percent.toFixed(1)}% uptime</span>
                    </div>
                    <ArrowRight className="h-4 w-4 text-[#3da8ff] opacity-0 transition-opacity group-hover:opacity-100" />
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
