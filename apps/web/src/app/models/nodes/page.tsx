"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import {
  Search,
  ChevronLeft,
  ChevronRight,
  Server,
  Star,
  Activity,
  Clock,
  DollarSign,
} from "lucide-react";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080/v1";

interface InferenceNode {
  id: string;
  owner_did: string;
  endpoint_url: string;
  models_served: string[];
  price_per_query_micro_usdc: number;
  status: string;
  region: string | null;
  description: string | null;
  uptime_percent: number;
  total_queries: number;
  avg_rating: number;
  review_count: number;
  last_heartbeat_at: string | null;
  created_at: string;
}

const SORT_OPTIONS = [
  { label: "Uptime", value: "uptime" },
  { label: "Price: Low", value: "price_asc" },
  { label: "Price: High", value: "price_desc" },
  { label: "Rating", value: "rating" },
];

const PER_PAGE = 12;

function statusColor(status: string): string {
  switch (status) {
    case "active":
      return "bg-green-500";
    case "degraded":
      return "bg-yellow-500";
    case "pending":
      return "bg-[#4a5568]";
    default:
      return "bg-red-500";
  }
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case "active":
      return "bg-green-500/10 text-green-400";
    case "degraded":
      return "bg-yellow-500/10 text-yellow-400";
    case "pending":
      return "bg-[#4a5568]/10 text-[#8b95a8]";
    default:
      return "bg-red-500/10 text-red-400";
  }
}

function formatPrice(microUsdc: number): string {
  return `$${(microUsdc / 1_000_000).toFixed(4)}`;
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return "never";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function StarRating({ rating, count }: { rating: number; count: number }) {
  if (count === 0) {
    return <span className="text-[#4a5568] text-xs">No reviews</span>;
  }
  return (
    <span className="flex items-center gap-1 text-xs">
      <Star className="h-3.5 w-3.5 text-yellow-400 fill-yellow-400" />
      <span className="text-[#8b95a8]">{rating.toFixed(1)}</span>
      <span className="text-[#4a5568]">({count})</span>
    </span>
  );
}

export default function NodesPage() {
  const [nodes, setNodes] = useState<InferenceNode[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [region, setRegion] = useState("");
  const [sort, setSort] = useState("uptime");
  const [page, setPage] = useState(1);
  const [regions, setRegions] = useState<string[]>([]);

  const fetchNodes = useCallback(async () => {
    setLoading(true);
    try {
      const sp = new URLSearchParams();
      if (search) sp.set("model", search);
      if (region) sp.set("region", region);
      if (sort) sp.set("sort", sort);
      sp.set("page", String(page));
      sp.set("limit", String(PER_PAGE));
      const qs = sp.toString();

      const res = await fetch(`${API_BASE}/nodes${qs ? `?${qs}` : ""}`);
      if (!res.ok) throw new Error("Failed to fetch nodes");
      const data = await res.json();
      setNodes(data.nodes || []);
      setTotal(data.total || 0);

      // Extract unique regions from results
      const uniqueRegions = [
        ...new Set(
          (data.nodes || [])
            .map((n: InferenceNode) => n.region)
            .filter(Boolean) as string[]
        ),
      ];
      setRegions((prev) => {
        const merged = [...new Set([...prev, ...uniqueRegions])];
        return merged.sort();
      });
    } catch {
      setNodes([]);
    } finally {
      setLoading(false);
    }
  }, [search, region, sort, page]);

  useEffect(() => {
    fetchNodes();
  }, [fetchNodes]);

  useEffect(() => {
    setPage(1);
  }, [search, region, sort]);

  const totalPages = Math.ceil(total / PER_PAGE) || 1;

  return (
    <div className="mx-auto max-w-7xl px-4 pt-24 pb-8">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <Server className="h-7 w-7 text-[#3da8ff]" />
          <h1 className="text-3xl font-bold text-[#eef1f8]">Inference Nodes</h1>
        </div>
        <p className="text-[#8b95a8] max-w-2xl">
          Discover self-hosted AI inference nodes. Each node provides
          OpenAI-compatible endpoints for running models with verified uptime
          and transparent pricing.
        </p>
      </div>

      {/* Filters */}
      <div className="mb-8 flex flex-col gap-4 md:flex-row md:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#4a5568]" />
          <input
            type="text"
            placeholder="Filter by model name..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-xl border border-[#1e2a3a] bg-[#0f1117] py-2.5 pl-10 pr-4 text-sm text-[#eef1f8] placeholder-[#4a5568] outline-none focus:border-[#3da8ff]"
          />
        </div>
        {regions.length > 0 && (
          <select
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] px-3 py-2.5 text-sm text-[#8b95a8] outline-none focus:border-[#3da8ff]"
          >
            <option value="">All Regions</option>
            {regions.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        )}
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value)}
          className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] px-3 py-2.5 text-sm text-[#8b95a8] outline-none focus:border-[#3da8ff]"
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {/* Grid */}
      {loading ? (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-56 animate-pulse rounded-xl bg-[#0f1117]"
            />
          ))}
        </div>
      ) : nodes.length > 0 ? (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {nodes.map((node) => (
            <Link
              key={node.id}
              href={`/models/nodes/${node.id}`}
              className="group"
            >
              <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5 transition hover:border-[#3da8ff]/50 hover:shadow-lg hover:shadow-[#3da8ff]/5 h-full flex flex-col">
                {/* Header */}
                <div className="mb-3 flex items-start justify-between">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-[#3da8ff]/10">
                      <Server className="h-5 w-5 text-[#3da8ff]" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-[#eef1f8] truncate group-hover:text-[#5bb8ff] transition">
                        {node.endpoint_url
                          .replace(/^https?:\/\//, "")
                          .replace(/\/$/, "")}
                      </p>
                      <p className="text-xs text-[#4a5568] truncate">
                        {node.owner_did.length > 24
                          ? `${node.owner_did.slice(0, 24)}...`
                          : node.owner_did}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <div
                      className={`h-2 w-2 rounded-full ${statusColor(node.status)}`}
                    />
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusBadgeClass(node.status)}`}
                    >
                      {node.status}
                    </span>
                  </div>
                </div>

                {/* Description */}
                {node.description && (
                  <p className="mb-3 line-clamp-2 text-sm text-[#8b95a8]">
                    {node.description}
                  </p>
                )}

                {/* Models served */}
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {node.models_served.slice(0, 3).map((model) => (
                    <span
                      key={model}
                      className="rounded-md bg-[#161822] px-2 py-0.5 text-xs text-[#8b95a8]"
                    >
                      {model.length > 30
                        ? `${model.slice(0, 30)}...`
                        : model}
                    </span>
                  ))}
                  {node.models_served.length > 3 && (
                    <span className="rounded-md bg-[#161822] px-2 py-0.5 text-xs text-[#4a5568]">
                      +{node.models_served.length - 3} more
                    </span>
                  )}
                </div>

                {/* Stats row */}
                <div className="mt-auto flex items-center justify-between pt-3 border-t border-[#1e2a3a] text-xs text-[#4a5568]">
                  <div className="flex items-center gap-3">
                    <span
                      className="flex items-center gap-1"
                      title="Uptime"
                    >
                      <Activity className="h-3.5 w-3.5" />
                      {node.uptime_percent.toFixed(1)}%
                    </span>
                    <StarRating
                      rating={node.avg_rating || 0}
                      count={node.review_count || 0}
                    />
                  </div>
                  <span className="flex items-center gap-1 font-medium text-[#3da8ff]">
                    <DollarSign className="h-3.5 w-3.5" />
                    {formatPrice(node.price_per_query_micro_usdc)}/q
                  </span>
                </div>

                {/* Footer */}
                <div className="mt-2 flex items-center justify-between text-xs text-[#4a5568]">
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    Heartbeat: {timeAgo(node.last_heartbeat_at)}
                  </span>
                  {node.region && (
                    <span className="rounded bg-[#0f1117] px-1.5 py-0.5">
                      {node.region}
                    </span>
                  )}
                </div>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] py-16 text-center">
          <Server className="mx-auto h-8 w-8 text-[#4a5568] mb-3" />
          <p className="text-[#4a5568]">No inference nodes found</p>
          <p className="mt-1 text-sm text-[#4a5568]">
            Nodes will appear here once operators register their endpoints.
          </p>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-8 flex items-center justify-center gap-4">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="rounded-lg bg-[#161822] p-2 text-[#8b95a8] transition hover:bg-[#1c1f2e] disabled:opacity-50"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-sm text-[#8b95a8]">
            Page {page} of {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="rounded-lg bg-[#161822] p-2 text-[#8b95a8] transition hover:bg-[#1c1f2e] disabled:opacity-50"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}
