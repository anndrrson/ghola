"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { getModels } from "@/lib/api";
import type { Model } from "@/lib/types";
import ModelCard from "@/components/ModelCard";
import { Search, ChevronLeft, ChevronRight, X } from "lucide-react";

const CATEGORIES = [
  "All",
  "Education",
  "Entertainment",
  "Finance",
  "Health",
  "Lifestyle",
  "Technology",
  "Writing",
  "Other",
] as const;
type Category = (typeof CATEGORIES)[number];

const SORT_OPTIONS = [
  { label: "Popular", value: "popular" },
  { label: "Newest", value: "newest" },
  { label: "Price ↑", value: "price_asc" },
  { label: "Price ↓", value: "price_desc" },
] as const;
type SortValue = (typeof SORT_OPTIONS)[number]["value"];

const PER_PAGE = 12;

export default function BrowsePage() {
  const [models, setModels] = useState<Model[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<Category>("All");
  const [sort, setSort] = useState<SortValue>("popular");
  const [page, setPage] = useState(1);

  const fetchModels = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getModels({
        search: search || undefined,
        category: category === "All" ? undefined : category,
        sort,
        page,
        limit: PER_PAGE,
      });
      setModels(res.models);
      setTotal(res.total);
    } catch {
      setModels([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [search, category, sort, page]);

  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  useEffect(() => {
    setPage(1);
  }, [search, category, sort]);

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const filtersActive = search.length > 0 || category !== "All";
  const showingRange = useMemo(() => {
    if (total === 0) return null;
    const lo = (page - 1) * PER_PAGE + 1;
    const hi = Math.min(page * PER_PAGE, total);
    return `${lo}–${hi} of ${total}`;
  }, [page, total]);

  return (
    <div className="relative min-h-screen overflow-hidden">
      {/* Backdrop — same dot grid as the hero, masked to fade out down the page */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[600px]"
        style={{
          backgroundImage: "radial-gradient(circle, #14202e 1px, transparent 1px)",
          backgroundSize: "32px 32px",
          maskImage: "linear-gradient(to bottom, black 0%, transparent 100%)",
          WebkitMaskImage: "linear-gradient(to bottom, black 0%, transparent 100%)",
        }}
      />

      <div className="relative mx-auto max-w-7xl px-4 pt-28 pb-24 sm:px-6 lg:px-12">
        {/* Header */}
        <header className="mb-12 max-w-3xl">
          <div className="mb-6 flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.22em] text-[#8b95a8]">
            <span className="h-px w-8 bg-[#2a3a50]" />
            01 — Marketplace · Open weights
          </div>
          <h1 className="font-display text-[clamp(2.5rem,6vw,4.5rem)] leading-[0.96] font-medium text-[#eef1f8]">
            Every open model.
            <br />
            <span className="text-[#3da8ff]">Per-call pricing.</span>
          </h1>
          <p className="mt-6 max-w-xl text-[15px] leading-relaxed text-[#8b95a8]">
            Llama, Qwen, DeepSeek, Mistral, Gemma — chat with any of them.
            Settle in USDT or USDC. No subscription. No vendor lock-in.
          </p>
        </header>

        {/* Filter bar */}
        <div className="mb-10 rounded-2xl border border-[#1e2a3a] bg-[#0c0e14]/80 p-4 backdrop-blur-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
            <label className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#4a5568]" />
              <input
                type="text"
                placeholder="Search by name, developer, or architecture…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-lg border border-[#1e2a3a] bg-[#08090d] py-2.5 pl-10 pr-10 text-[14px] text-[#eef1f8] outline-none transition-colors placeholder:text-[#4a5568] focus:border-[#3da8ff]/60 focus:ring-2 focus:ring-[#3da8ff]/20"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  aria-label="Clear search"
                  className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-0.5 text-[#4a5568] hover:bg-[#161822] hover:text-[#eef1f8]"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </label>

            <div className="-mx-1 flex shrink-0 items-center gap-1 overflow-x-auto px-1">
              {CATEGORIES.map((cat) => {
                const active = category === cat;
                return (
                  <button
                    key={cat}
                    onClick={() => setCategory(cat)}
                    className={`whitespace-nowrap rounded-md px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.16em] transition-colors ${
                      active
                        ? "bg-[#3da8ff]/12 text-[#3da8ff] ring-1 ring-inset ring-[#3da8ff]/30"
                        : "text-[#8b95a8] hover:bg-[#161822] hover:text-[#eef1f8]"
                    }`}
                  >
                    {cat}
                  </button>
                );
              })}
            </div>

            <div className="relative shrink-0">
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as SortValue)}
                className="appearance-none rounded-lg border border-[#1e2a3a] bg-[#08090d] py-2.5 pl-3 pr-9 font-mono text-[12px] uppercase tracking-[0.14em] text-[#cfd4dd] outline-none transition-colors hover:border-[#2a3a50] focus:border-[#3da8ff]/60"
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#4a5568]">
                ▾
              </span>
            </div>
          </div>

          <div className="mt-3 flex items-center justify-between font-mono text-[11px] uppercase tracking-[0.18em] text-[#4a5568]">
            <span>{loading ? "Loading…" : showingRange ?? "No results"}</span>
            {filtersActive && (
              <button
                type="button"
                onClick={() => {
                  setSearch("");
                  setCategory("All");
                }}
                className="text-[#8b95a8] hover:text-[#eef1f8]"
              >
                Clear filters
              </button>
            )}
          </div>
        </div>

        {/* Grid */}
        {loading ? (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="h-[340px] animate-pulse rounded-2xl border border-[#1e2a3a] bg-[#0c0e14]"
                style={{ animationDelay: `${i * 80}ms` }}
              />
            ))}
          </div>
        ) : models.length > 0 ? (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {models.map((m) => (
              <ModelCard key={m.id} model={m} />
            ))}
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-[#1e2a3a] bg-[#0c0e14]/50 py-24 text-center">
            <p className="font-display text-2xl text-[#eef1f8]">No models match.</p>
            <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.18em] text-[#4a5568]">
              Try clearing filters or a different search term
            </p>
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <nav className="mt-12 flex items-center justify-center gap-3" aria-label="Pagination">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="rounded-lg border border-[#1e2a3a] bg-[#0c0e14] p-2.5 text-[#8b95a8] transition hover:border-[#2a3a50] hover:text-[#eef1f8] disabled:opacity-40 disabled:hover:border-[#1e2a3a] disabled:hover:text-[#8b95a8]"
              aria-label="Previous page"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="font-mono text-[11px] uppercase tracking-[0.22em] tabular-nums text-[#8b95a8]">
              Page {String(page).padStart(2, "0")}
              <span className="mx-1.5 text-[#2a3a50]">/</span>
              {String(totalPages).padStart(2, "0")}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="rounded-lg border border-[#1e2a3a] bg-[#0c0e14] p-2.5 text-[#8b95a8] transition hover:border-[#2a3a50] hover:text-[#eef1f8] disabled:opacity-40 disabled:hover:border-[#1e2a3a] disabled:hover:text-[#8b95a8]"
              aria-label="Next page"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </nav>
        )}
      </div>
    </div>
  );
}
