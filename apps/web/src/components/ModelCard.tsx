import Link from "next/link";
import { MessageSquare, Star, ShieldCheck } from "lucide-react";
import type { Model } from "@/lib/types";

export default function ModelCard({ model }: { model: Model }) {
  return (
    <Link href={`/models/${model.slug}`}>
      <div className="group rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5 transition hover:border-[#D4A04A]/50 hover:shadow-lg hover:shadow-[#D4A04A]/5">
        <div className="mb-3 flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#D4A04A] text-sm font-bold text-[#eef1f8]">
              {model.creator_name?.[0]?.toUpperCase() || "?"}
            </div>
            <div>
              <h3 className="font-semibold text-[#eef1f8] group-hover:text-[#D4A04A] transition">
                {model.name}
              </h3>
              <p className="flex items-center gap-1 text-xs text-[#4a5568]">
                {model.creator_name}
                {model.creator_verified && (
                  <span title="Verified Identity">
                    <ShieldCheck className="h-3.5 w-3.5 text-[#3da8ff]" />
                  </span>
                )}
              </p>
            </div>
          </div>
          <span className="rounded-full bg-[#D4A04A]/10 px-2.5 py-0.5 text-xs font-medium text-[#D4A04A]">
            {model.category}
          </span>
        </div>
        <p className="mb-4 line-clamp-2 text-sm text-[#8b95a8]">
          {model.description}
        </p>
        <div className="flex items-center justify-between text-xs text-[#4a5568]">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <MessageSquare className="h-3.5 w-3.5" />
              {model.total_queries.toLocaleString()}
            </span>
          </div>
          <span className="font-medium text-[#D4A04A]">
            ${model.price_per_query.toFixed(2)}/query
          </span>
        </div>
      </div>
    </Link>
  );
}
