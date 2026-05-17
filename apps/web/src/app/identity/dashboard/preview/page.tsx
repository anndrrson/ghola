"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { getProfile } from "@/lib/api";
import type { BusinessProfile, ServiceDefinition } from "@/lib/types";
import {
  Eye,
  Copy,
  Check,
  Globe,
  ShieldCheck,
  ShieldOff,
  Clock,
  FileText,
  Zap,
  Search,
  Tag,
  ExternalLink,
} from "lucide-react";

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_KEYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

const METHOD_COLORS: Record<string, string> = {
  GET: "bg-green-600/20 text-green-400 border-green-600/30",
  POST: "bg-blue-600/20 text-blue-400 border-blue-600/30",
  PUT: "bg-yellow-600/20 text-yellow-400 border-yellow-600/30",
  PATCH: "bg-orange-600/20 text-orange-400 border-orange-600/30",
  DELETE: "bg-red-600/20 text-red-400 border-red-600/30",
};

function truncateDid(did: string): string {
  if (did.length <= 24) return did;
  return `${did.slice(0, 16)}...${did.slice(-8)}`;
}

export default function PreviewPage() {
  const { authenticated, loading: authLoading } = useAuth();
  const router = useRouter();

  const [profile, setProfile] = useState<BusinessProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedDid, setCopiedDid] = useState(false);
  const [query, setQuery] = useState("");
  const [openPolicies, setOpenPolicies] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (!authLoading && !authenticated) {
      router.push("/identity/login");
    }
  }, [authLoading, authenticated, router]);

  useEffect(() => {
    if (!authenticated) return;
    setLoading(true);
    getProfile()
      .then(setProfile)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [authenticated]);

  const matchedServices = useMemo(() => {
    if (!profile || !query.trim()) return [];
    const q = query.toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    return profile.services.filter((svc) => {
      const haystack = `${svc.name} ${svc.description}`.toLowerCase();
      return words.some((w) => haystack.includes(w));
    });
  }, [profile, query]);

  const matchedEndpoints = useMemo(() => {
    if (!profile || !query.trim()) return [];
    const q = query.toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    return profile.api_endpoints.filter((ep) => {
      const haystack = `${ep.name} ${ep.description} ${ep.url}`.toLowerCase();
      return words.some((w) => haystack.includes(w));
    });
  }, [profile, query]);

  const handleCopyDid = async () => {
    if (!profile) return;
    await navigator.clipboard.writeText(profile.did);
    setCopiedDid(true);
    setTimeout(() => setCopiedDid(false), 2000);
  };

  const togglePolicy = (idx: number) => {
    setOpenPolicies((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  if (authLoading || !authenticated) {
    return (
      <div className="flex h-screen items-center justify-center pt-16">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#3da8ff] border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-24 sm:px-6 lg:px-8">
      <div className="mb-8">
        <div className="flex items-center gap-2">
          <Eye className="h-6 w-6 text-[#3da8ff]" />
          <h1 className="font-display text-2xl font-medium text-[#eef1f8]">What Agents See</h1>
        </div>
        <p className="mt-1 text-[#8b95a8]">
          Preview how AI agents will perceive your business identity
        </p>
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-red-600/30 bg-red-900/20 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {loading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-40 animate-pulse rounded-lg bg-[#161822]"
            />
          ))}
        </div>
      ) : profile ? (
        <div className="space-y-6">
          {/* Agent View Card */}
          <div className="rounded-xl border border-[#1e2a3a]/50 bg-[#161822] shadow-lg overflow-hidden"
               style={{ backgroundColor: "rgb(24, 28, 35)" }}>
            {/* Header strip */}
            <div className="bg-[#0a1929]/30 border-b border-[#1e2a3a]/50 px-6 py-3">
              <span className="text-xs font-mono text-[#3da8ff] uppercase tracking-wider">
                ghola identity resolution
              </span>
            </div>

            {/* Identity Section */}
            <div className="px-6 py-5 border-b border-[#1e2a3a]">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-[#4a5568] mb-3">
                Identity
              </h2>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[#4a5568] w-16">DID</span>
                  <code className="text-sm text-[#8b95a8] font-mono">
                    {truncateDid(profile.did)}
                  </code>
                  <button
                    onClick={handleCopyDid}
                    className="p-1 text-[#4a5568] hover:text-[#8b95a8] transition-colors cursor-pointer"
                    title="Copy full DID"
                  >
                    {copiedDid ? (
                      <Check className="h-3.5 w-3.5 text-green-400" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
                {profile.handle && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-[#4a5568] w-16">Handle</span>
                    <span className="text-sm text-[#eef1f8]">
                      @{profile.handle}
                    </span>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[#4a5568] w-16">Domain</span>
                  {profile.verified_domain ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-green-600/15 border border-green-600/25 px-2.5 py-0.5 text-xs font-medium text-green-400">
                      <ShieldCheck className="h-3 w-3" />
                      {profile.verified_domain}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-[#1c1f2e]/50 border border-[#1e2a3a]/30 px-2.5 py-0.5 text-xs font-medium text-[#8b95a8]">
                      <ShieldOff className="h-3 w-3" />
                      Not verified
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Business Section */}
            <div className="px-6 py-5 border-b border-[#1e2a3a]">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-[#4a5568] mb-3">
                Business
              </h2>
              <div className="space-y-2">
                <h3 className="text-lg font-semibold text-[#eef1f8]">
                  {profile.business_name}
                </h3>
                <span className="inline-block rounded-full bg-[#2b96f0]/15 border border-[#2b96f0]/25 px-2.5 py-0.5 text-xs font-medium text-[#3da8ff]">
                  {profile.category}
                </span>
                {profile.description && (
                  <p className="text-sm text-[#8b95a8] leading-relaxed mt-2">
                    {profile.description}
                  </p>
                )}
                {profile.website && (
                  <div className="flex items-center gap-1.5 text-sm text-[#8b95a8] mt-1">
                    <Globe className="h-3.5 w-3.5" />
                    <a
                      href={profile.website}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:text-[#3da8ff] transition-colors"
                    >
                      {profile.website}
                    </a>
                  </div>
                )}
              </div>
            </div>

            {/* Services Section */}
            {profile.services.length > 0 && (
              <div className="px-6 py-5 border-b border-[#1e2a3a]">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-[#4a5568] mb-3">
                  Services ({profile.services.length})
                </h2>
                <div className="space-y-3">
                  {profile.services.map((svc, i) => (
                    <ServiceCard key={i} service={svc} />
                  ))}
                </div>
              </div>
            )}

            {/* Operating Hours */}
            {profile.operating_hours &&
              Object.keys(profile.operating_hours).length > 0 && (
                <div className="px-6 py-5 border-b border-[#1e2a3a]">
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-[#4a5568] mb-3">
                    <Clock className="inline h-3.5 w-3.5 mr-1 -mt-0.5" />
                    Operating Hours
                  </h2>
                  <div className="space-y-1.5">
                    {DAY_KEYS.map((key, i) => {
                      const value = profile.operating_hours?.[key];
                      const isOpen = value && value.toLowerCase() !== "closed";
                      return (
                        <div
                          key={key}
                          className="flex items-center gap-3 text-sm"
                        >
                          <span className="w-10 text-[#4a5568] text-xs font-medium">
                            {DAY_LABELS[i]}
                          </span>
                          <div className="flex-1 h-5 rounded-full bg-[#161822] overflow-hidden relative">
                            {isOpen && (
                              <div className="h-full rounded-full bg-[#2b96f0]/40 border border-[#3da8ff]/30 flex items-center px-2"
                                   style={{ width: "100%" }}>
                                <span className="text-xs text-[#5bb8ff] truncate">
                                  {value}
                                </span>
                              </div>
                            )}
                            {!isOpen && (
                              <div className="h-full flex items-center px-2">
                                <span className="text-xs text-[#4a5568]">
                                  {value || "Not set"}
                                </span>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

            {/* Policies */}
            {profile.policies.length > 0 && (
              <div className="px-6 py-5 border-b border-[#1e2a3a]">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-[#4a5568] mb-3">
                  <FileText className="inline h-3.5 w-3.5 mr-1 -mt-0.5" />
                  Policies ({profile.policies.length})
                </h2>
                <div className="space-y-2">
                  {profile.policies.map((policy, i) => (
                    <div
                      key={i}
                      className="rounded-lg border border-[#1e2a3a]/50 bg-[#0f1117]"
                    >
                      <button
                        onClick={() => togglePolicy(i)}
                        className="flex w-full items-center justify-between px-3 py-2 text-left cursor-pointer"
                      >
                        <span className="text-sm font-medium text-[#8b95a8]">
                          {policy.name}
                        </span>
                        <span className="text-xs text-[#4a5568]">
                          {openPolicies.has(i) ? "collapse" : "expand"}
                        </span>
                      </button>
                      {openPolicies.has(i) && (
                        <div className="border-t border-[#1e2a3a] px-3 py-2">
                          <p className="text-sm text-[#8b95a8] whitespace-pre-wrap">
                            {policy.content}
                          </p>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* API Endpoints */}
            {profile.api_endpoints.length > 0 && (
              <div className="px-6 py-5">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-[#4a5568] mb-3">
                  <Zap className="inline h-3.5 w-3.5 mr-1 -mt-0.5" />
                  API Endpoints ({profile.api_endpoints.length})
                </h2>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[#1e2a3a]">
                        <th className="py-2 pr-3 text-left text-xs font-medium text-[#4a5568]">
                          Name
                        </th>
                        <th className="py-2 pr-3 text-left text-xs font-medium text-[#4a5568]">
                          Method
                        </th>
                        <th className="py-2 pr-3 text-left text-xs font-medium text-[#4a5568]">
                          URL
                        </th>
                        <th className="py-2 text-left text-xs font-medium text-[#4a5568]">
                          Auth
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {profile.api_endpoints.map((ep, i) => (
                        <tr
                          key={i}
                          className="border-b border-[#1e2a3a]/50 last:border-0"
                        >
                          <td className="py-2 pr-3 text-[#eef1f8]">
                            {ep.name}
                          </td>
                          <td className="py-2 pr-3">
                            <span
                              className={`inline-block rounded px-1.5 py-0.5 text-xs font-mono font-medium border ${
                                METHOD_COLORS[ep.method.toUpperCase()] ||
                                "bg-[#1c1f2e] text-[#8b95a8] border-[#1e2a3a]"
                              }`}
                            >
                              {ep.method.toUpperCase()}
                            </span>
                          </td>
                          <td className="py-2 pr-3">
                            <code className="text-xs text-[#8b95a8] font-mono">
                              {ep.url}
                            </code>
                          </td>
                          <td className="py-2 text-xs text-[#8b95a8]">
                            {ep.auth_type}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          {/* Simulated Agent Query */}
          <div className="rounded-xl border border-[#1e2a3a] bg-[#161822] p-6">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-[#eef1f8] mb-1">
              <Search className="h-5 w-5 text-[#3da8ff]" />
              Simulated Agent Query
            </h2>
            <p className="text-sm text-[#8b95a8] mb-4">
              Type a query to see which services and endpoints would match
            </p>
            <div className="relative">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder='e.g. "Book a table for 2 at 7pm"'
                className="w-full rounded-lg border border-[#1e2a3a] bg-[#0f1117] px-4 py-3 pl-10 text-sm text-[#eef1f8] placeholder-[#4a5568] focus:border-[#3da8ff] focus:outline-none focus:ring-1 focus:ring-[#3da8ff] transition-colors"
              />
              <Search className="absolute left-3 top-3.5 h-4 w-4 text-[#4a5568]" />
            </div>

            {query.trim() && (
              <div className="mt-4 space-y-3">
                {matchedServices.length > 0 ? (
                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-[#4a5568] mb-2">
                      Matching Services
                    </h3>
                    {matchedServices.map((svc, i) => (
                      <div
                        key={i}
                        className="rounded-lg border border-[#2b96f0]/20 bg-[#0a1929]/10 px-3 py-2 mb-2"
                      >
                        <span className="text-sm font-medium text-[#5bb8ff]">
                          {svc.name}
                        </span>
                        <p className="text-xs text-[#8b95a8] mt-0.5">
                          {svc.description}
                        </p>
                        {svc.api_endpoint && (
                          <div className="flex items-center gap-1 mt-1 text-xs text-[#4a5568]">
                            <ExternalLink className="h-3 w-3" />
                            {svc.api_endpoint}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ) : null}

                {matchedEndpoints.length > 0 ? (
                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-[#4a5568] mb-2">
                      Matching Endpoints
                    </h3>
                    {matchedEndpoints.map((ep, i) => (
                      <div
                        key={i}
                        className="rounded-lg border border-[#2b96f0]/20 bg-[#0a1929]/10 px-3 py-2 mb-2"
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className={`inline-block rounded px-1.5 py-0.5 text-xs font-mono font-medium border ${
                              METHOD_COLORS[ep.method.toUpperCase()] ||
                              "bg-[#1c1f2e] text-[#8b95a8] border-[#1e2a3a]"
                            }`}
                          >
                            {ep.method.toUpperCase()}
                          </span>
                          <span className="text-sm font-medium text-[#5bb8ff]">
                            {ep.name}
                          </span>
                        </div>
                        <p className="text-xs text-[#8b95a8] mt-0.5">
                          {ep.description}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : null}

                {matchedServices.length === 0 &&
                  matchedEndpoints.length === 0 && (
                    <div className="rounded-lg border border-[#1e2a3a] bg-[#0f1117] px-4 py-6 text-center">
                      <Search className="mx-auto h-8 w-8 text-[#4a5568] mb-2" />
                      <p className="text-sm text-[#8b95a8]">
                        No matching services or endpoints found for this query
                      </p>
                    </div>
                  )}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ServiceCard({ service }: { service: ServiceDefinition }) {
  return (
    <div className="rounded-lg border border-[#1e2a3a]/50 bg-[#0f1117] px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-[#eef1f8]">{service.name}</h3>
          <p className="text-xs text-[#8b95a8] mt-0.5">{service.description}</p>
        </div>
        {service.price && (
          <span className="flex-shrink-0 rounded-md bg-[#161822] border border-[#1e2a3a] px-2 py-0.5 text-xs font-medium text-[#8b95a8]">
            {service.price}
          </span>
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {service.availability && (
          <span className="inline-flex items-center gap-1 text-xs text-[#4a5568]">
            <Clock className="h-3 w-3" />
            {service.availability}
          </span>
        )}
        {service.api_endpoint && (
          <span className="inline-flex items-center gap-1 text-xs text-[#4a5568]">
            <Zap className="h-3 w-3" />
            {service.api_endpoint}
          </span>
        )}
        {service.booking_url && (
          <span className="inline-flex items-center gap-1 text-xs text-[#4a5568]">
            <ExternalLink className="h-3 w-3" />
            Book online
          </span>
        )}
      </div>
    </div>
  );
}
