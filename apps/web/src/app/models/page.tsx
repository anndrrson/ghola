"use client";

import { useEffect, useState, useCallback } from "react";
import { getModels } from "@/lib/api";
import type { Model } from "@/lib/types";
import ModelCard from "@/components/ModelCard";
import { Search, ChevronLeft, ChevronRight } from "lucide-react";

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
];
const SORT_OPTIONS = [
  { label: "Popular", value: "popular" },
  { label: "Newest", value: "newest" },
  { label: "Price: Low", value: "price_asc" },
  { label: "Price: High", value: "price_desc" },
];
const PER_PAGE = 12;

export default function BrowsePage() {
  const [models, setModels] = useState<Model[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All");
  const [sort, setSort] = useState("popular");
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

  const totalPages = Math.ceil(total / PER_PAGE) || 1;

  return (
    <div className="mx-auto max-w-7xl px-4 pt-24 pb-8">
      <h1 className="mb-6 text-3xl font-bold text-[#eef1f8]">Browse Models</h1>

      {/* Filters */}
      <div className="mb-8 flex flex-col gap-4 md:flex-row md:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#4a5568]" />
          <input
            type="text"
            placeholder="Search models..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-xl border border-[#1e2a3a] bg-[#0f1117] py-2.5 pl-10 pr-4 text-sm text-[#eef1f8] placeholder-[#4a5568] outline-none focus:border-[#D4A04A]"
          />
        </div>
        <div className="flex gap-2 overflow-x-auto">
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              onClick={() => setCategory(cat)}
              className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                category === cat
                  ? "bg-[#D4A04A] text-[#eef1f8]"
                  : "bg-[#161822] text-[#8b95a8] hover:bg-[#1c1f2e]"
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value)}
          className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] px-3 py-2.5 text-sm text-[#8b95a8] outline-none focus:border-[#D4A04A]"
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
            <div key={i} className="h-48 animate-pulse rounded-xl bg-[#0f1117]" />
          ))}
        </div>
      ) : models.length > 0 ? (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {models.map((m) => (
            <ModelCard key={m.id} model={m} />
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] py-16 text-center">
          <p className="text-[#4a5568]">No models found</p>
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
