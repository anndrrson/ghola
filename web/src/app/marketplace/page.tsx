"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { listServices } from "@/lib/api";
import type { ServiceListingResponse } from "@/lib/types";
import { SERVICE_CATEGORIES } from "@/lib/types";
import {
  Search,
  Star,
  Activity,
  Zap,
  ChevronLeft,
  ChevronRight,
  SlidersHorizontal,
} from "lucide-react";

const SORT_OPTIONS = [
  { value: "newest", label: "Newest" },
  { value: "price_asc", label: "Price: Low to High" },
  { value: "price_desc", label: "Price: High to Low" },
  { value: "rating", label: "Top Rated" },
  { value: "uptime", label: "Best Uptime" },
];

const LIMIT = 12;

function formatPrice(micro: number, model: string): string {
  if (model === "free") return "Free";
  const usdc = micro / 1_000_000;
  const suffix = model === "flat_monthly" ? "/mo" : model === "per_minute" ? "/min" : "/req";
  return `$${usdc.toFixed(usdc < 0.01 ? 4 : 2)} USDC${suffix}`;
}

export default function MarketplacePage() {
  const [services, setServices] = useState<ServiceListingResponse[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [sort, setSort] = useState("newest");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listServices({
        q: query || undefined,
        category: category || undefined,
        sort,
        page,
        limit: LIMIT,
      });
      setServices(res.services);
      setTotal(res.total);
    } catch (err) {
      console.error("Failed to load services:", err);
    } finally {
      setLoading(false);
    }
  }, [query, category, sort, page]);

  useEffect(() => { load(); }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / LIMIT));

  return (
    <div className="min-h-screen bg-[#08090d]">
      <div className="mx-auto max-w-6xl px-4 py-10">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-[#eef1f8]">Service Marketplace</h1>
          <p className="mt-2 text-[#8b95a8]">
            Browse headless merchant services available for agent-to-agent commerce.
          </p>
        </div>

        {/* Search + Sort row */}
        <div className="mb-6 flex flex-col gap-3 sm:flex-row">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#4a5568]" />
            <input
              type="text"
              placeholder="Search services..."
              value={query}
              onChange={(e) => { setQuery(e.target.value); setPage(1); }}
              className="w-full rounded-lg border border-[#1e2a3a] bg-[#0f1117] pl-10 pr-3 py-2 text-[#eef1f8] placeholder-[#4a5568] focus:border-[#3da8ff] focus:outline-none transition-colors"
            />
          </div>
          <div className="relative">
            <SlidersHorizontal className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#4a5568]" />
            <select
              value={sort}
              onChange={(e) => { setSort(e.target.value); setPage(1); }}
              className="appearance-none rounded-lg border border-[#1e2a3a] bg-[#0f1117] pl-10 pr-8 py-2 text-sm text-[#eef1f8] focus:border-[#3da8ff] focus:outline-none transition-colors"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Category pills */}
        <div className="mb-8 flex gap-2 overflow-x-auto pb-2">
          <button
            onClick={() => { setCategory(""); setPage(1); }}
            className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              category === ""
                ? "bg-[#3da8ff] text-[#08090d]"
                : "border border-[#1e2a3a] bg-[#0f1117] text-[#8b95a8] hover:bg-[#161822]"
            }`}
          >
            All
          </button>
          {SERVICE_CATEGORIES.map((cat) => (
            <button
              key={cat}
              onClick={() => { setCategory(cat); setPage(1); }}
              className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-medium capitalize transition-colors ${
                category === cat
                  ? "bg-[#3da8ff] text-[#08090d]"
                  : "border border-[#1e2a3a] bg-[#0f1117] text-[#8b95a8] hover:bg-[#161822]"
              }`}
            >
              {cat.replace("-", " ")}
            </button>
          ))}
        </div>

        {/* Grid */}
        {loading ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-52 animate-pulse rounded-xl bg-[#161822]" />
            ))}
          </div>
        ) : services.length === 0 ? (
          <div className="py-20 text-center text-[#8b95a8]">
            No services found. Try adjusting your filters.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {services.map((svc) => (
              <Link
                key={svc.id}
                href={`/marketplace/${svc.slug}`}
                className="group rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5 transition-colors hover:border-[#3da8ff]/30 hover:bg-[#161822]"
              >
                <div className="mb-3 flex items-start justify-between">
                  <h3 className="font-semibold text-[#eef1f8] group-hover:text-[#3da8ff] transition-colors">
                    {svc.name}
                  </h3>
                  <span className="shrink-0 rounded-full bg-[#3da8ff]/10 px-2 py-0.5 text-xs font-medium capitalize text-[#3da8ff]">
                    {svc.category.replace("-", " ")}
                  </span>
                </div>
                <p className="mb-4 line-clamp-2 text-sm text-[#8b95a8]">{svc.description}</p>
                <div className="flex items-center justify-between text-xs text-[#8b95a8]">
                  <span className="font-medium text-[#eef1f8]">
                    {formatPrice(svc.price_micro_usdc, svc.pricing_model)}
                  </span>
                  <div className="flex items-center gap-3">
                    {svc.avg_rating !== null && (
                      <span className="flex items-center gap-1">
                        <Star className="h-3 w-3 text-yellow-500" />
                        {svc.avg_rating.toFixed(1)}
                      </span>
                    )}
                    <span className="flex items-center gap-1">
                      <Activity className="h-3 w-3 text-green-500" />
                      {svc.uptime_percent.toFixed(1)}%
                    </span>
                    <span className="flex items-center gap-1">
                      <Zap className="h-3 w-3" />
                      {svc.total_requests.toLocaleString()}
                    </span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="mt-8 flex items-center justify-center gap-4">
            <button
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
              className="flex items-center gap-1 rounded-lg border border-[#1e2a3a] bg-[#0f1117] px-3 py-2 text-sm text-[#8b95a8] transition-colors hover:bg-[#161822] disabled:opacity-40"
            >
              <ChevronLeft className="h-4 w-4" /> Prev
            </button>
            <span className="text-sm text-[#8b95a8]">
              Page {page} of {totalPages}
            </span>
            <button
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
              className="flex items-center gap-1 rounded-lg border border-[#1e2a3a] bg-[#0f1117] px-3 py-2 text-sm text-[#8b95a8] transition-colors hover:bg-[#161822] disabled:opacity-40"
            >
              Next <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
