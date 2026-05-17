"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { getModel, getBalance } from "@/lib/api";
import type { Model } from "@/lib/types";
import { useWalletAuth } from "@/lib/wallet-provider";
import { useThumperAuth } from "@/lib/thumper-auth-context";
import ChatInterface from "@/components/ChatInterface";
import ProviderMark from "@/components/ProviderMark";
import { ArrowLeft, MessageSquare, ShieldCheck } from "lucide-react";
import Link from "next/link";

const formatPrice = (microUsdc: number) => {
  const usd = microUsdc / 1_000_000;
  if (usd === 0) return "Free";
  if (usd < 0.001) return `$${(usd * 1000).toFixed(2)}m`;
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

const formatDate = (iso: string) => {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
};

export default function ModelDetailPage() {
  const params = useParams();
  const slug = params.slug as string;
  const { authenticated } = useWalletAuth();
  const thumperAuth = useThumperAuth();
  const [model, setModel] = useState<Model | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchBalance = useCallback(() => {
    if (authenticated) {
      getBalance()
        .then((b) => setBalance(b.balance))
        .catch(() => setBalance(null));
    }
  }, [authenticated]);

  useEffect(() => {
    getModel(slug)
      .then(setModel)
      .catch(() => setError("Model not found"))
      .finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => {
    fetchBalance();
  }, [fetchBalance]);

  if (loading) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="h-12 w-64 animate-pulse rounded bg-[#0f1117]" />
        <div className="mt-8 grid gap-6 lg:grid-cols-[340px_1fr]">
          <div className="h-96 animate-pulse rounded-2xl bg-[#0f1117]" />
          <div className="h-[calc(100vh-12rem)] animate-pulse rounded-2xl bg-[#0f1117]" />
        </div>
      </div>
    );
  }

  if (error || !model) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-24 text-center sm:px-6">
        <h1 className="font-display text-3xl font-medium text-[#eef1f8]">
          Model not found
        </h1>
        <p className="mt-3 text-sm text-[#8b95a8]">
          The model you're looking for doesn't exist or has been removed.
        </p>
        <Link
          href="/models"
          className="mt-8 inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-[#3da8ff] hover:text-[#5bb8ff]"
        >
          <ArrowLeft className="h-3 w-3" />
          Back to catalog
        </Link>
      </div>
    );
  }

  const featured = model.is_foundation || model.is_featured;
  const awaiting = model.awaiting_host;

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
      {/* Breadcrumb */}
      <Link
        href="/models"
        className="inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-[#4a5568] transition-colors hover:text-[#8b95a8]"
      >
        <ArrowLeft className="h-3 w-3" />
        Catalog
      </Link>

      {/* Hero */}
      <div className="mt-6 flex items-start justify-between gap-6 border-b border-[#1e2a3a] pb-10">
        <div className="flex min-w-0 items-start gap-5">
          <div className="shrink-0 pt-1">
            <ProviderMark
              developer={model.developer}
              slug={model.slug}
              size={56}
              className="text-[#cfd4dd]"
            />
          </div>
          <div className="min-w-0">
            <h1 className="font-display text-4xl font-medium leading-[1.05] text-[#eef1f8] sm:text-5xl">
              {model.name}
            </h1>
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-[#4a5568]">
              {model.developer && (
                <span className="text-[#8b95a8]">{model.developer}</span>
              )}
              {model.license && (
                <>
                  <span className="text-[#1e2a3a]">/</span>
                  <span>{formatLicense(model.license)}</span>
                </>
              )}
              {model.architecture && (
                <>
                  <span className="text-[#1e2a3a]">/</span>
                  <span>{model.architecture}</span>
                </>
              )}
            </div>
            {model.description && (
              <p className="mt-5 max-w-2xl text-[15px] leading-[1.6] text-[#cfd4dd]">
                {model.description}
              </p>
            )}
            {model.creator_verified && model.creator_name && (
              <div className="mt-4 inline-flex items-center gap-1.5 rounded-sm border border-[#3da8ff]/30 bg-[#3da8ff]/5 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-[#3da8ff]">
                <ShieldCheck className="h-3 w-3" />
                Verified · {model.creator_name}
              </div>
            )}
          </div>
        </div>
        <div className="hidden shrink-0 flex-col items-end gap-2 font-mono text-[10px] uppercase tracking-[0.22em] sm:flex">
          {awaiting && (
            <span className="rounded-sm border border-[#fbbf24]/40 bg-[#fbbf24]/5 px-2 py-1 text-[#fbbf24]">
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

      {/* Body */}
      <div className="mt-10 grid gap-8 lg:grid-cols-[320px_1fr]">
        {/* Spec rail */}
        <aside className="space-y-6 lg:sticky lg:top-24 lg:self-start">
          {/* Spec sheet */}
          <div className="overflow-hidden rounded-md border border-[#162033] bg-[#08090d]">
            <SpecRow label="Params" value={formatParams(model.params_b, model.active_params_b)} />
            <SpecRow label="Context" value={formatContext(model.context_window)} />
            <SpecRow label="License" value={formatLicense(model.license)} />
            {model.modality && model.modality.length > 0 && (
              <SpecRow label="Modality" value={model.modality.join(" · ")} />
            )}
            {model.recommended_vram_gb && (
              <SpecRow label="VRAM" value={`${model.recommended_vram_gb} GB`} />
            )}
            {model.hf_id && <SpecRow label="HF" value={model.hf_id} />}
            <SpecRow label="Released" value={formatDate(model.release_date || model.created_at)} />
          </div>

          {/* Price + usage block */}
          <div className="rounded-md border border-[#162033] bg-[#08090d] p-5">
            <div className="flex items-end justify-between">
              <div>
                <div className="font-display text-3xl text-[#eef1f8]">
                  {formatPrice(model.price_per_query)}
                </div>
                <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.22em] text-[#4a5568]">
                  per query
                </div>
              </div>
              <div className="text-right">
                <div className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-[#8b95a8]">
                  <MessageSquare className="h-3 w-3" />
                  {model.total_queries.toLocaleString()}
                </div>
                <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.22em] text-[#4a5568]">
                  sessions
                </div>
              </div>
            </div>
          </div>

          {/* Balance (authenticated only) */}
          {authenticated && (
            <div className="rounded-md border border-[#162033] bg-[#08090d] p-5">
              <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#4a5568]">
                Your balance
              </div>
              <div className="mt-2 flex items-end justify-between">
                <div className="font-display text-2xl text-[#eef1f8]">
                  ${balance !== null ? balance.toFixed(2) : "—"}
                </div>
                <Link
                  href="/models/account"
                  className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#3da8ff] hover:text-[#5bb8ff]"
                >
                  Add funds →
                </Link>
              </div>
            </div>
          )}
        </aside>

        {/* Chat panel */}
        <div className="flex h-[calc(100vh-13rem)] min-h-[520px] flex-col overflow-hidden rounded-md border border-[#162033] bg-[#0c0e14]">
          {authenticated ? (
            <ChatInterface
              slug={slug}
              pricePerQuery={model.price_per_query}
              balance={balance}
              onBalanceUpdate={fetchBalance}
            />
          ) : (
            <div className="flex h-full items-center justify-center px-6">
              <div className="max-w-sm text-center">
                {thumperAuth.authenticated ? (
                  <>
                    <p className="font-display text-xl text-[#eef1f8]">
                      Setting up your wallet
                    </p>
                    <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.22em] text-[#4a5568]">
                      One moment
                    </p>
                  </>
                ) : (
                  <>
                    <p className="font-display text-2xl text-[#eef1f8]">
                      Sign in to start chatting
                    </p>
                    <p className="mt-3 text-sm text-[#8b95a8]">
                      No account, no trail. Pay {formatPrice(model.price_per_query)} per
                      query in stablecoins — only when you actually call the model.
                    </p>
                    <Link
                      href="/signup"
                      className="mt-6 inline-flex items-center gap-2 rounded-md bg-[#3da8ff] px-5 py-2.5 text-sm font-medium text-[#08090d] transition-colors hover:bg-[#5bb8ff]"
                    >
                      Get started free
                    </Link>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SpecRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[88px_1fr] gap-3 border-b border-[#162033] px-4 py-2.5 font-mono text-[11px] last:border-b-0">
      <span className="uppercase tracking-[0.18em] text-[#4a5568]">{label}</span>
      <span className="truncate text-[#cfd4dd]">{value}</span>
    </div>
  );
}
