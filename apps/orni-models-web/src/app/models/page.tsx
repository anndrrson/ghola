"use client";

import { useEffect, useState, useCallback } from "react";
import { getModels, getFeaturedModels, type Model } from "@/lib/api";
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
  const [featured, setFeatured] = useState<Model[]>([]);

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
    getFeaturedModels().then(setFeatured).catch(() => {});
  }, []);

  useEffect(() => {
    setPage(1);
  }, [search, category, sort]);

  const totalPages = Math.ceil(total / PER_PAGE) || 1;

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <h1 className="mb-6 text-3xl font-medium text-[#fafafa]">Browse Models</h1>

      {/* Featured Models */}
      {featured.length > 0 && (
        <div className="mb-10">
          <h2 className="mb-4 text-xl font-medium text-[#fafafa]">Featured Models</h2>
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {featured.map((m) => (
              <ModelCard key={m.id} model={m} />
            ))}
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="mb-8 flex flex-col gap-4 md:flex-row md:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#666]" />
          <input
            type="text"
            placeholder="Search models..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg bg-[#141414] border border-[#262626] py-2.5 pl-10 pr-4 text-sm text-[#fafafa] placeholder-[#666] outline-none transition-colors focus:border-[#444]"
          />
        </div>
        <div className="flex gap-2 overflow-x-auto">
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              onClick={() => setCategory(cat)}
              className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium transition-colors active:scale-[0.98] ${
                category === cat
                  ? "bg-[#fafafa] text-[#0a0a0a]"
                  : "bg-[#141414] text-[#a1a1a1] hover:text-[#fafafa] border border-[#262626] hover:border-[#333]"
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value)}
          className="rounded-lg bg-[#141414] border border-[#262626] px-3 py-2.5 text-sm text-[#a1a1a1] outline-none transition-colors focus:border-[#444]"
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
            <div key={i} className="h-48 animate-pulse rounded-lg bg-[#141414]" />
          ))}
        </div>
      ) : models.length > 0 ? (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {models.map((m) => (
            <ModelCard key={m.id} model={m} />
          ))}
        </div>
      ) : (
        <div className="rounded-lg bg-[#141414] border border-[#262626] py-16 text-center">
          <p className="text-[#666]">No models found</p>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-8 flex items-center justify-center gap-4">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="rounded-lg bg-[#141414] border border-[#262626] p-2 text-[#a1a1a1] transition-colors hover:border-[#333] disabled:opacity-50 active:scale-[0.98]"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-sm text-[#a1a1a1]">
            Page {page} of {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="rounded-lg bg-[#141414] border border-[#262626] p-2 text-[#a1a1a1] transition-colors hover:border-[#333] disabled:opacity-50 active:scale-[0.98]"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}
