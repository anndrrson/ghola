import Link from "next/link";
import { ArrowUpRight, MessageSquare } from "lucide-react";
import type { Model } from "@/lib/types";
import ProviderMark from "./ProviderMark";

// Editorial spec-sheet aesthetic — model name as display headline, technical
// metadata in mono labels with sharp rules between rows, lineage mark sets
// the tone in the top-left, price as the closing line. Hover lifts the card
// and tints the lineage mark + name to cyan.

const formatPrice = (microUsdc: number) => {
  const usd = microUsdc / 1_000_000;
  if (usd === 0) return "Free";
  if (usd < 0.001) return `$${(usd * 1000).toFixed(2)}m`; // milli-cents
  if (usd < 1) return `$${usd.toFixed(usd < 0.01 ? 4 : 3)}`;
  return `$${usd.toFixed(2)}`;
};

const formatContext = (ctx?: number) => {
  if (!ctx) return "—";
  if (ctx >= 1_000_000) return `${(ctx / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (ctx >= 1000) return `${(ctx / 1000).toFixed(0)}K`;
  return `${ctx}`;
};

const formatParams = (params_b?: number, active_params_b?: number) => {
  if (!params_b) return "—";
  const total = params_b >= 100 ? `${Math.round(params_b)}B` : `${params_b}B`;
  if (active_params_b && active_params_b !== params_b) {
    const active =
      active_params_b >= 100 ? `${Math.round(active_params_b)}B` : `${active_params_b}B`;
    return `${total} · ${active} active`;
  }
  return total;
};

const formatLicense = (license?: string) => {
  if (!license) return "—";
  return license
    .replace(/^llama-/, "Llama ")
    .replace(/-community$/, " Community")
    .replace(/^apache-2\.0$/i, "Apache 2.0")
    .replace(/^mit$/i, "MIT")
    .replace(/^cc-by-nc-4\.0$/i, "CC-BY-NC 4.0")
    .replace(/^mistral-research$/, "Mistral Research")
    .replace(/^gemma$/i, "Gemma")
    .replace(/^deepseek$/i, "DeepSeek")
    .replace(/^command-r$/i, "Cohere CC-BY-NC")
    .replace(/^qwen$/i, "Qwen");
};

export default function ModelCard({ model }: { model: Model }) {
  const featured = model.is_foundation || model.is_featured;
  const awaiting = model.awaiting_host;

  return (
    <Link
      href={`/models/${model.slug}`}
      className="group relative flex flex-col rounded-2xl border border-[#1e2a3a] bg-[#0c0e14] p-6 transition-all duration-300 hover:border-[#3da8ff]/45 hover:bg-[#0f1117] hover:shadow-[0_0_0_1px_rgba(61,168,255,0.15),0_24px_60px_-30px_rgba(61,168,255,0.4)]"
    >
      {/* Top row: provider mark + status */}
      <div className="mb-7 flex items-center justify-between">
        <ProviderMark
          developer={model.developer}
          slug={model.slug}
          size={26}
          className="group-hover:text-[#3da8ff]"
        />
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em]">
          {awaiting && (
            <span className="rounded-sm border border-[#fbbf24]/40 bg-[#fbbf24]/5 px-1.5 py-0.5 text-[#fbbf24]">
              Awaiting host
            </span>
          )}
          {featured && !awaiting && (
            <span className="flex items-center gap-1.5 text-[#3da8ff]">
              <span className="h-1 w-1 rounded-full bg-[#3da8ff]" />
              Foundation
            </span>
          )}
          {model.category && model.category !== "Other" && (
            <span className="text-[#4a5568]">{model.category}</span>
          )}
        </div>
      </div>

      {/* Headline + description */}
      <div className="mb-7">
        <h3 className="font-display text-2xl font-medium leading-[1.05] text-[#eef1f8] transition-colors group-hover:text-[#3da8ff]">
          {model.name}
        </h3>
        {model.developer && (
          <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.18em] text-[#4a5568]">
            {model.developer}
          </p>
        )}
        {model.description && (
          <p className="mt-4 line-clamp-2 text-[13.5px] leading-[1.55] text-[#8b95a8]">
            {model.description}
          </p>
        )}
      </div>

      {/* Spec rows */}
      <div className="space-y-px overflow-hidden rounded-md border border-[#162033] bg-[#08090d]">
        <SpecRow label="Params" value={formatParams(model.params_b, model.active_params_b)} />
        <SpecRow label="Context" value={formatContext(model.context_window)} />
        <SpecRow label="License" value={formatLicense(model.license)} />
        {model.modality && model.modality.length > 0 && (
          <SpecRow label="Modality" value={model.modality.join(" · ")} />
        )}
      </div>

      {/* Bottom row: usage + price */}
      <div className="mt-6 flex items-end justify-between">
        <div className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-[#4a5568]">
          <MessageSquare className="h-3 w-3" />
          {model.total_queries.toLocaleString()} sessions
        </div>
        <div className="text-right">
          <div className="font-display text-xl text-[#eef1f8]">
            {formatPrice(model.price_per_query)}
          </div>
          <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#4a5568]">
            per query
          </div>
        </div>
      </div>

      {/* Hover affordance */}
      <ArrowUpRight className="pointer-events-none absolute right-5 top-5 h-4 w-4 -translate-y-0.5 translate-x-0.5 text-[#4a5568] opacity-0 transition-all duration-300 group-hover:translate-x-0 group-hover:translate-y-0 group-hover:text-[#3da8ff] group-hover:opacity-100" />
    </Link>
  );
}

function SpecRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[80px_1fr] gap-3 border-b border-[#162033] px-3 py-2 font-mono text-[11px] last:border-b-0">
      <span className="uppercase tracking-[0.18em] text-[#4a5568]">{label}</span>
      <span className="truncate text-[#cfd4dd]">{value}</span>
    </div>
  );
}
