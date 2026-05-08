import Link from "next/link";
import { MessageSquare, Star } from "lucide-react";
import type { Model } from "@/lib/api";

export default function ModelCard({ model }: { model: Model }) {
  return (
    <Link href={`/models/${model.slug}`}>
      <div className="group rounded-lg bg-[#141414] border border-[#262626] p-5 transition-colors duration-150 hover:border-[#333]">
        <div className="mb-3 flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#222] text-sm font-medium text-[#fafafa]">
              {model.creator_name?.[0]?.toUpperCase() || "?"}
            </div>
            <div>
              <h3 className="font-medium text-[#fafafa] group-hover:text-[#fafafa] transition-colors">
                {model.name}
              </h3>
              <p className="text-xs text-[#666]">{model.creator_name}</p>
            </div>
          </div>
          <div className="flex flex-col items-end gap-1">
            <span className="rounded-full bg-[#222] px-2.5 py-0.5 text-xs font-medium text-[#a1a1a1] border border-[#333]">
              {model.category}
            </span>
            {model.free_queries_per_day && model.free_queries_per_day > 0 && (
              <span className="rounded-full bg-[#00E5A0]/10 px-2.5 py-0.5 text-xs font-medium text-[#00E5A0] border border-[#00E5A0]/20">
                {model.free_queries_per_day} free/day
              </span>
            )}
          </div>
        </div>
        <p className="mb-4 line-clamp-2 text-sm text-[#a1a1a1]">
          {model.description}
        </p>
        <div className="flex items-center justify-between text-xs text-[#666]">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <MessageSquare className="h-3.5 w-3.5" />
              {model.total_queries.toLocaleString()}
            </span>
            {model.avg_rating > 0 && (
              <span className="flex items-center gap-1">
                <Star className="h-3.5 w-3.5 text-yellow-400 fill-yellow-400" />
                {model.avg_rating.toFixed(1)}
                {model.review_count > 0 && (
                  <span className="text-[#666]">({model.review_count})</span>
                )}
              </span>
            )}
          </div>
          <span className="font-medium text-[#00E5A0]">
            {model.free_queries_per_day && model.free_queries_per_day > 0
              ? `${model.free_queries_per_day} free/day`
              : `$${(model.price_per_query / 1_000_000).toFixed(2)}/query`}
          </span>
        </div>
      </div>
    </Link>
  );
}
