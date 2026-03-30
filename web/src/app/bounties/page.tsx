"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { browseMarketplace } from "@/lib/thumper-api";
import type { MarketplaceTask } from "@/lib/thumper-types";
import { BOUNTY_TASK_TYPES } from "@/lib/thumper-types";
import {
  Search,
  DollarSign,
  Clock,
  ChevronLeft,
  ChevronRight,
  SlidersHorizontal,
  Plus,
  User,
  ShieldCheck,
  Star,
} from "lucide-react";

const SORT_OPTIONS = [
  { value: "newest", label: "Newest" },
  { value: "bounty_desc", label: "Bounty: High to Low" },
  { value: "bounty_asc", label: "Bounty: Low to High" },
];

const LIMIT = 12;

function formatUsdc(micro: number): string {
  const usdc = micro / 1_000_000;
  return `$${usdc.toFixed(usdc < 0.01 ? 4 : 2)} USDC`;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export default function BountiesPage() {
  const [tasks, setTasks] = useState<MarketplaceTask[]>([]);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [taskType, setTaskType] = useState("");
  const [sort, setSort] = useState("newest");
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await browseMarketplace({
        task_type: taskType || undefined,
        sort,
        limit: LIMIT,
        offset: (page - 1) * LIMIT,
      });
      // Client-side search filter (API doesn't support text search)
      const filtered = query
        ? res.filter(
            (t) =>
              t.title?.toLowerCase().includes(query.toLowerCase()) ||
              t.description?.toLowerCase().includes(query.toLowerCase()),
          )
        : res;
      setTasks(filtered);
      setHasMore(res.length >= LIMIT);
    } catch (err) {
      console.error("Failed to load bounties:", err);
    } finally {
      setLoading(false);
    }
  }, [query, taskType, sort, page]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="min-h-screen bg-[#08090d]">
      <div className="mx-auto max-w-6xl px-4 py-10">
        {/* Header */}
        <div className="mb-8 flex items-start justify-between">
          <div>
            <h1 className="text-3xl font-bold text-[#eef1f8]">
              Bounty Marketplace
            </h1>
            <p className="mt-2 text-[#8b95a8]">
              Browse tasks with USDC bounties. Claim, complete, and get paid.
            </p>
          </div>
          <Link
            href="/bounties/create"
            className="hidden sm:inline-flex items-center gap-2 rounded-xl bg-[#3da8ff] px-5 py-2.5 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] transition-colors"
          >
            <Plus className="h-4 w-4" />
            Post Bounty
          </Link>
        </div>

        {/* Search + Sort */}
        <div className="mb-6 flex flex-col gap-3 sm:flex-row">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#4a5568]" />
            <input
              type="text"
              placeholder="Search bounties..."
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
              className="w-full rounded-lg border border-[#1e2a3a] bg-[#0f1117] pl-10 pr-3 py-2 text-[#eef1f8] placeholder-[#4a5568] focus:border-[#3da8ff] focus:outline-none transition-colors"
            />
          </div>
          <div className="relative">
            <SlidersHorizontal className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#4a5568]" />
            <select
              value={sort}
              onChange={(e) => {
                setSort(e.target.value);
                setPage(1);
              }}
              className="appearance-none rounded-lg border border-[#1e2a3a] bg-[#0f1117] pl-10 pr-8 py-2 text-sm text-[#eef1f8] focus:border-[#3da8ff] focus:outline-none transition-colors"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Task type pills */}
        <div className="mb-8 flex gap-2 overflow-x-auto pb-2">
          <button
            onClick={() => {
              setTaskType("");
              setPage(1);
            }}
            className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              taskType === ""
                ? "bg-[#3da8ff] text-[#08090d]"
                : "border border-[#1e2a3a] bg-[#0f1117] text-[#8b95a8] hover:bg-[#161822]"
            }`}
          >
            All
          </button>
          {BOUNTY_TASK_TYPES.map((tt) => (
            <button
              key={tt}
              onClick={() => {
                setTaskType(tt);
                setPage(1);
              }}
              className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-medium capitalize transition-colors ${
                taskType === tt
                  ? "bg-[#3da8ff] text-[#08090d]"
                  : "border border-[#1e2a3a] bg-[#0f1117] text-[#8b95a8] hover:bg-[#161822]"
              }`}
            >
              {tt.replace(/_/g, " ")}
            </button>
          ))}
        </div>

        {/* Grid */}
        {loading ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="h-52 animate-pulse rounded-xl bg-[#161822]"
              />
            ))}
          </div>
        ) : tasks.length === 0 ? (
          <div className="py-20 text-center">
            <p className="text-[#8b95a8] mb-4">
              No bounties available yet.
            </p>
            <Link
              href="/bounties/create"
              className="inline-flex items-center gap-2 rounded-xl bg-[#3da8ff] px-6 py-3 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] transition-colors"
            >
              Post the first bounty
              <Plus className="h-4 w-4" />
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {tasks.map((task) => (
              <Link
                key={task.id}
                href={`/bounties/${task.id}`}
                className="group rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5 transition-colors hover:border-[#3da8ff]/30 hover:bg-[#161822]"
              >
                <div className="mb-3 flex items-start justify-between">
                  <h3 className="font-semibold text-[#eef1f8] group-hover:text-[#3da8ff] transition-colors line-clamp-1">
                    {task.title || "Untitled Task"}
                  </h3>
                  <span className="shrink-0 rounded-full bg-[#3da8ff]/10 px-2 py-0.5 text-xs font-medium capitalize text-[#3da8ff]">
                    {task.task_type.replace(/_/g, " ")}
                  </span>
                </div>
                <p className="mb-4 line-clamp-2 text-sm text-[#8b95a8]">
                  {task.description || "No description provided."}
                </p>
                {/* Funder identity */}
                <div className="mb-3 flex items-center gap-2 text-xs text-[#8b95a8]">
                  <User className="h-3 w-3" />
                  <span className="truncate">
                    {task.funder_name || `${task.funder_id.slice(0, 8)}...`}
                  </span>
                  {task.funder_verified && (
                    <ShieldCheck className="h-3.5 w-3.5 text-[#3da8ff] shrink-0" />
                  )}
                  {task.funder_reputation != null && (
                    <span className="flex items-center gap-0.5 shrink-0">
                      <Star className="h-3 w-3 text-yellow-500" />
                      {(task.funder_reputation * 100).toFixed(0)}
                    </span>
                  )}
                </div>
                <div className="flex items-center justify-between text-xs text-[#8b95a8]">
                  {task.bounty_usdc != null && (
                    <span className="flex items-center gap-1 font-semibold text-[#eef1f8]">
                      <DollarSign className="h-3.5 w-3.5 text-green-400" />
                      {formatUsdc(task.bounty_usdc)}
                    </span>
                  )}
                  <div className="flex items-center gap-2">
                    {task.min_reputation != null && (
                      <span className="text-yellow-400" title="Minimum reputation required">
                        min {(task.min_reputation * 100).toFixed(0)}
                      </span>
                    )}
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {timeAgo(task.created_at)}
                    </span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}

        {/* Pagination */}
        {(page > 1 || hasMore) && (
          <div className="mt-8 flex items-center justify-center gap-4">
            <button
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
              className="flex items-center gap-1 rounded-lg border border-[#1e2a3a] bg-[#0f1117] px-3 py-2 text-sm text-[#8b95a8] transition-colors hover:bg-[#161822] disabled:opacity-40"
            >
              <ChevronLeft className="h-4 w-4" /> Prev
            </button>
            <span className="text-sm text-[#8b95a8]">Page {page}</span>
            <button
              disabled={!hasMore}
              onClick={() => setPage((p) => p + 1)}
              className="flex items-center gap-1 rounded-lg border border-[#1e2a3a] bg-[#0f1117] px-3 py-2 text-sm text-[#8b95a8] transition-colors hover:bg-[#161822] disabled:opacity-40"
            >
              Next <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Mobile post bounty button */}
        <div className="mt-6 sm:hidden">
          <Link
            href="/bounties/create"
            className="flex items-center justify-center gap-2 rounded-xl bg-[#3da8ff] px-5 py-3 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] transition-colors w-full"
          >
            <Plus className="h-4 w-4" />
            Post Bounty
          </Link>
        </div>
      </div>
    </div>
  );
}
