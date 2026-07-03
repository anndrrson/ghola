"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { registerService } from "@/lib/api";
import { SERVICE_CATEGORIES } from "@/lib/types";
import {
  ArrowLeft,
  Info,
  Globe,
  DollarSign,
  Wallet,
  Loader2,
} from "lucide-react";
import Link from "next/link";

const AUTH_TYPES = ["none", "api_key", "ucan", "oauth2", "said_verify"];
const PRICING_MODELS = ["per_request", "per_minute", "per_token", "flat_monthly", "free"];

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

const inputCls =
  "w-full rounded-lg border border-[#1e2a3a] bg-[#0f1117] px-3 py-2 text-[#eef1f8] placeholder-[#4a5568] focus:border-[#3da8ff] focus:outline-none transition-colors";
const labelCls = "mb-1 block text-sm font-medium text-[#eef1f8]";
const hintCls = "mt-1 text-xs text-[#8b95a8]";

export default function RegisterServicePage() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  // Basic info
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("general");
  const [tags, setTags] = useState("");

  // API config
  const [baseUrl, setBaseUrl] = useState("");
  const [healthCheckUrl, setHealthCheckUrl] = useState("");
  const [openapiUrl, setOpenapiUrl] = useState("");
  const [authType, setAuthType] = useState("none");

  // Pricing
  const [pricingModel, setPricingModel] = useState("per_request");
  const [priceUsdc, setPriceUsdc] = useState("");
  const [freeTierRequests, setFreeTierRequests] = useState("");

  // Payment
  const [receiveAddress, setReceiveAddress] = useState("");

  useEffect(() => {
    // SECURITY: pre-migration this guarded the page by reading
    // `localStorage["ghola_token"]`. The JWT is now in an HttpOnly cookie
    // unreadable from JS; submission failures will surface 401 →
    // "Please sign in" naturally via the API error path below.
    void router;
  }, [router]);

  useEffect(() => {
    setSlug(slugify(name));
  }, [name]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!name.trim() || !baseUrl.trim()) {
      setError("Name and Base URL are required.");
      return;
    }
    setSubmitting(true);
    try {
      const priceMicro = pricingModel === "free" ? 0 : Math.round(parseFloat(priceUsdc || "0") * 1_000_000);
      const data: Record<string, unknown> = {
        name: name.trim(),
        slug: slug.trim(),
        description: description.trim(),
        category,
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
        base_url: baseUrl.trim(),
        auth_type: authType,
        pricing_model: pricingModel,
        price_micro_usdc: priceMicro,
      };
      if (healthCheckUrl.trim()) data.health_check_url = healthCheckUrl.trim();
      if (openapiUrl.trim()) data.openapi_url = openapiUrl.trim();
      if (freeTierRequests) data.free_tier_requests = parseInt(freeTierRequests, 10);
      if (receiveAddress.trim()) data.receive_address = receiveAddress.trim();

      const svc = await registerService(data);
      router.push(`/marketplace/${svc.slug}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to register service.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#08090d]">
      <div className="mx-auto max-w-2xl px-4 py-10">
        <Link href="/merchant" className="mb-6 inline-flex items-center gap-1 text-sm text-[#8b95a8] hover:text-[#3da8ff] transition-colors">
          <ArrowLeft className="h-4 w-4" /> Back to dashboard
        </Link>

        <h1 className="mb-2 text-2xl font-bold text-[#eef1f8]">Register Service</h1>
        <p className="mb-8 text-[#8b95a8]">Publish a headless merchant service to the marketplace.</p>

        {error && (
          <div className="mb-6 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-8">
          {/* Section: Basic Info */}
          <section className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
            <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-[#eef1f8]">
              <Info className="h-4 w-4 text-[#3da8ff]" /> Basic Info
            </h2>
            <div className="space-y-4">
              <div>
                <label className={labelCls}>Service Name</label>
                <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="My API Service" className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Slug</label>
                <input type="text" value={slug} onChange={(e) => setSlug(e.target.value)} className={inputCls} />
                <p className={hintCls}>URL-friendly identifier. Auto-generated from name.</p>
              </div>
              <div>
                <label className={labelCls}>Description</label>
                <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="What does your service do?" className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Category</label>
                <select value={category} onChange={(e) => setCategory(e.target.value)} className={inputCls}>
                  {SERVICE_CATEGORIES.map((c) => (
                    <option key={c} value={c}>{c.replace("-", " ")}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelCls}>Tags</label>
                <input type="text" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="ai, nlp, embeddings" className={inputCls} />
                <p className={hintCls}>Comma-separated tags for discoverability.</p>
              </div>
            </div>
          </section>

          {/* Section: API Configuration */}
          <section className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
            <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-[#eef1f8]">
              <Globe className="h-4 w-4 text-[#3da8ff]" /> API Configuration
            </h2>
            <div className="space-y-4">
              <div>
                <label className={labelCls}>Base URL</label>
                <input type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com" className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Health Check URL <span className="text-[#8b95a8]">(optional)</span></label>
                <input type="url" value={healthCheckUrl} onChange={(e) => setHealthCheckUrl(e.target.value)} placeholder="https://api.example.com/health" className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>OpenAPI Spec URL <span className="text-[#8b95a8]">(optional)</span></label>
                <input type="url" value={openapiUrl} onChange={(e) => setOpenapiUrl(e.target.value)} placeholder="https://api.example.com/openapi.json" className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Auth Type</label>
                <select value={authType} onChange={(e) => setAuthType(e.target.value)} className={inputCls}>
                  {AUTH_TYPES.map((a) => (
                    <option key={a} value={a}>{a.replace("_", " ")}</option>
                  ))}
                </select>
              </div>
            </div>
          </section>

          {/* Section: Pricing */}
          <section className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
            <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-[#eef1f8]">
              <DollarSign className="h-4 w-4 text-[#3da8ff]" /> Pricing
            </h2>
            <div className="space-y-4">
              <div>
                <label className={labelCls}>Pricing Model</label>
                <select value={pricingModel} onChange={(e) => setPricingModel(e.target.value)} className={inputCls}>
                  {PRICING_MODELS.map((m) => (
                    <option key={m} value={m}>{m.replace("_", " ")}</option>
                  ))}
                </select>
              </div>
              {pricingModel !== "free" && (
                <div>
                  <label className={labelCls}>Price (USDC)</label>
                  <input type="number" step="0.0001" min="0" value={priceUsdc} onChange={(e) => setPriceUsdc(e.target.value)} placeholder="0.01" className={inputCls} />
                </div>
              )}
              <div>
                <label className={labelCls}>Free Tier Requests <span className="text-[#8b95a8]">(optional)</span></label>
                <input type="number" min="0" value={freeTierRequests} onChange={(e) => setFreeTierRequests(e.target.value)} placeholder="100" className={inputCls} />
              </div>
            </div>
          </section>

          {/* Section: Payment */}
          <section className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
            <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-[#eef1f8]">
              <Wallet className="h-4 w-4 text-[#3da8ff]" /> Payment
            </h2>
            <div>
              <label className={labelCls}>Receive Address <span className="text-[#8b95a8]">(Solana)</span></label>
              <input type="text" value={receiveAddress} onChange={(e) => setReceiveAddress(e.target.value)} placeholder="Your Solana wallet address" className={inputCls} />
              <p className={hintCls}>USDC payments will be sent to this address.</p>
            </div>
          </section>

          {/* Submit */}
          <button
            type="submit"
            disabled={submitting}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#3da8ff] px-4 py-3 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] transition-colors disabled:opacity-50"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {submitting ? "Registering..." : "Register Service"}
          </button>
        </form>
      </div>
    </div>
  );
}
