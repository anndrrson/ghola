"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { listAgentServices, createAgentService } from "@/lib/api";
import type { ServiceListingResponse } from "@/lib/types";
import { Plus, Loader2, Wrench, ExternalLink, Activity } from "lucide-react";

function formatPrice(micro: number, model: string): string {
  if (model === "free") return "Free";
  const usdc = micro / 1_000_000;
  const suffix =
    model === "flat_monthly"
      ? "/mo"
      : model === "per_minute"
      ? "/min"
      : "/req";
  return `$${usdc.toFixed(usdc < 0.01 ? 4 : 2)}${suffix}`;
}

export default function AgentServicesPage() {
  const params = useParams<{ id: string }>();
  const [services, setServices] = useState<ServiceListingResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [priceCents, setPriceCents] = useState("0");

  useEffect(() => {
    if (!params.id) return;
    listAgentServices(params.id)
      .then(setServices)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [params.id]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!params.id) return;
    setError(null);
    setSubmitting(true);
    try {
      const microUsdc = Math.round(parseFloat(priceCents || "0") * 10000);
      const created = await createAgentService(params.id, {
        name,
        slug,
        description: description || undefined,
        base_url: baseUrl,
        price_micro_usdc: microUsdc,
        pricing_model: microUsdc > 0 ? "per_request" : "free",
      });
      // The API returns a json blob; rebuild list
      setServices((prev) => [
        created as unknown as ServiceListingResponse,
        ...prev,
      ]);
      setShowForm(false);
      setName("");
      setSlug("");
      setDescription("");
      setBaseUrl("");
      setPriceCents("0");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create service");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-[#eef1f8]">Services</h1>
          <p className="mt-1 text-[#8b95a8]">
            API endpoints this agent offers. Other agents discover and pay
            them via x402 + the marketplace.
          </p>
        </div>
        {!showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="inline-flex items-center gap-2 rounded-xl bg-[#3da8ff] px-5 py-2.5 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] transition-colors cursor-pointer"
          >
            <Plus className="h-4 w-4" />
            Register service
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {showForm && (
        <form
          onSubmit={handleSubmit}
          className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5 space-y-4"
        >
          <h2 className="text-sm font-medium text-[#eef1f8]">New service</h2>

          <div>
            <label className="block text-xs text-[#8b95a8] mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="Image generation"
              className="w-full rounded-lg border border-[#1e2a3a] bg-[#08090d] px-3 py-2 text-[#eef1f8] placeholder-[#4a5568] focus:border-[#3da8ff] focus:outline-none transition-colors"
            />
          </div>
          <div>
            <label className="block text-xs text-[#8b95a8] mb-1">Slug</label>
            <input
              type="text"
              value={slug}
              onChange={(e) =>
                setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))
              }
              required
              placeholder="image-gen"
              className="w-full rounded-lg border border-[#1e2a3a] bg-[#08090d] px-3 py-2 text-[#eef1f8] placeholder-[#4a5568] focus:border-[#3da8ff] focus:outline-none transition-colors font-mono text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-[#8b95a8] mb-1">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="What does this service do?"
              className="w-full rounded-lg border border-[#1e2a3a] bg-[#08090d] px-3 py-2 text-[#eef1f8] placeholder-[#4a5568] focus:border-[#3da8ff] focus:outline-none transition-colors resize-none"
            />
          </div>
          <div>
            <label className="block text-xs text-[#8b95a8] mb-1">
              Base URL
            </label>
            <input
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              required
              placeholder="https://api.example.com"
              className="w-full rounded-lg border border-[#1e2a3a] bg-[#08090d] px-3 py-2 text-[#eef1f8] placeholder-[#4a5568] focus:border-[#3da8ff] focus:outline-none transition-colors font-mono text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-[#8b95a8] mb-1">
              Price per request (USDC, 4 decimals — use 0 for free)
            </label>
            <input
              type="number"
              step="0.0001"
              min="0"
              value={priceCents}
              onChange={(e) => setPriceCents(e.target.value)}
              className="w-full rounded-lg border border-[#1e2a3a] bg-[#08090d] px-3 py-2 text-[#eef1f8] focus:border-[#3da8ff] focus:outline-none transition-colors font-mono text-sm"
            />
          </div>

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-2 rounded-lg bg-[#3da8ff] px-4 py-2 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] disabled:opacity-60 disabled:cursor-not-allowed transition-all cursor-pointer"
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              Create
            </button>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="rounded-lg border border-[#1e2a3a] px-4 py-2 text-sm font-medium text-[#8b95a8] hover:text-[#eef1f8] hover:border-[#2a3a50] transition-colors cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <div
              key={i}
              className="h-24 animate-pulse rounded-xl bg-[#161822]"
            />
          ))}
        </div>
      ) : services.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[#1e2a3a] bg-[#0f1117] py-16 text-center">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-[#3da8ff]/10 mb-4">
            <Wrench className="h-6 w-6 text-[#3da8ff]" />
          </div>
          <h2 className="text-lg font-medium text-[#eef1f8] mb-2">
            No services yet
          </h2>
          <p className="text-[#8b95a8] text-sm">
            Register an API endpoint other agents can hire.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {services.map((svc) => (
            <div
              key={svc.id}
              className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h3 className="font-semibold text-[#eef1f8] flex items-center gap-2">
                    {svc.name}
                    <span className="text-xs font-normal text-[#4a5568]">
                      /{svc.slug}
                    </span>
                  </h3>
                  {svc.description && (
                    <p className="mt-1 text-sm text-[#8b95a8] line-clamp-1">
                      {svc.description}
                    </p>
                  )}
                  <div className="mt-3 flex items-center gap-4 text-xs text-[#8b95a8]">
                    <span className="font-medium text-[#eef1f8]">
                      {formatPrice(svc.price_micro_usdc, svc.pricing_model)}
                    </span>
                    <span className="flex items-center gap-1">
                      <Activity className="h-3 w-3 text-green-500" />
                      {svc.uptime_percent.toFixed(1)}%
                    </span>
                    <span>{svc.total_requests.toLocaleString()} reqs</span>
                  </div>
                </div>
                <a
                  href={`/marketplace/${svc.slug}`}
                  className="text-xs text-[#3da8ff] hover:text-[#5bb8ff] inline-flex items-center gap-1 shrink-0"
                >
                  View <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
