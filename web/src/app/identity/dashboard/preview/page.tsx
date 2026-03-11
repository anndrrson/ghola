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
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-said-500 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-24 sm:px-6 lg:px-8">
      <div className="mb-8">
        <div className="flex items-center gap-2">
          <Eye className="h-6 w-6 text-said-400" />
          <h1 className="text-2xl font-bold text-white">What Agents See</h1>
        </div>
        <p className="mt-1 text-gray-400">
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
              className="h-40 animate-pulse rounded-lg bg-gray-800"
            />
          ))}
        </div>
      ) : profile ? (
        <div className="space-y-6">
          {/* Agent View Card */}
          <div className="rounded-xl border border-gray-700/50 bg-gray-850 shadow-lg overflow-hidden"
               style={{ backgroundColor: "rgb(24, 28, 35)" }}>
            {/* Header strip */}
            <div className="bg-said-900/30 border-b border-gray-700/50 px-6 py-3">
              <span className="text-xs font-mono text-said-400 uppercase tracking-wider">
                SAID Identity Resolution
              </span>
            </div>

            {/* Identity Section */}
            <div className="px-6 py-5 border-b border-gray-800">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-3">
                Identity
              </h2>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500 w-16">DID</span>
                  <code className="text-sm text-gray-300 font-mono">
                    {truncateDid(profile.did)}
                  </code>
                  <button
                    onClick={handleCopyDid}
                    className="p-1 text-gray-500 hover:text-gray-300 transition-colors cursor-pointer"
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
                    <span className="text-xs text-gray-500 w-16">Handle</span>
                    <span className="text-sm text-gray-200">
                      @{profile.handle}
                    </span>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500 w-16">Domain</span>
                  {profile.verified_domain ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-green-600/15 border border-green-600/25 px-2.5 py-0.5 text-xs font-medium text-green-400">
                      <ShieldCheck className="h-3 w-3" />
                      {profile.verified_domain}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-700/50 border border-gray-600/30 px-2.5 py-0.5 text-xs font-medium text-gray-400">
                      <ShieldOff className="h-3 w-3" />
                      Not verified
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Business Section */}
            <div className="px-6 py-5 border-b border-gray-800">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-3">
                Business
              </h2>
              <div className="space-y-2">
                <h3 className="text-lg font-semibold text-white">
                  {profile.business_name}
                </h3>
                <span className="inline-block rounded-full bg-said-600/15 border border-said-600/25 px-2.5 py-0.5 text-xs font-medium text-said-400">
                  {profile.category}
                </span>
                {profile.description && (
                  <p className="text-sm text-gray-300 leading-relaxed mt-2">
                    {profile.description}
                  </p>
                )}
                {profile.website && (
                  <div className="flex items-center gap-1.5 text-sm text-gray-400 mt-1">
                    <Globe className="h-3.5 w-3.5" />
                    <a
                      href={profile.website}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:text-said-400 transition-colors"
                    >
                      {profile.website}
                    </a>
                  </div>
                )}
              </div>
            </div>

            {/* Services Section */}
            {profile.services.length > 0 && (
              <div className="px-6 py-5 border-b border-gray-800">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-3">
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
                <div className="px-6 py-5 border-b border-gray-800">
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-3">
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
                          <span className="w-10 text-gray-500 text-xs font-medium">
                            {DAY_LABELS[i]}
                          </span>
                          <div className="flex-1 h-5 rounded-full bg-gray-800 overflow-hidden relative">
                            {isOpen && (
                              <div className="h-full rounded-full bg-said-600/40 border border-said-500/30 flex items-center px-2"
                                   style={{ width: "100%" }}>
                                <span className="text-xs text-said-300 truncate">
                                  {value}
                                </span>
                              </div>
                            )}
                            {!isOpen && (
                              <div className="h-full flex items-center px-2">
                                <span className="text-xs text-gray-600">
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
              <div className="px-6 py-5 border-b border-gray-800">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-3">
                  <FileText className="inline h-3.5 w-3.5 mr-1 -mt-0.5" />
                  Policies ({profile.policies.length})
                </h2>
                <div className="space-y-2">
                  {profile.policies.map((policy, i) => (
                    <div
                      key={i}
                      className="rounded-lg border border-gray-700/50 bg-gray-900/50"
                    >
                      <button
                        onClick={() => togglePolicy(i)}
                        className="flex w-full items-center justify-between px-3 py-2 text-left cursor-pointer"
                      >
                        <span className="text-sm font-medium text-gray-300">
                          {policy.name}
                        </span>
                        <span className="text-xs text-gray-600">
                          {openPolicies.has(i) ? "collapse" : "expand"}
                        </span>
                      </button>
                      {openPolicies.has(i) && (
                        <div className="border-t border-gray-800 px-3 py-2">
                          <p className="text-sm text-gray-400 whitespace-pre-wrap">
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
                <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-3">
                  <Zap className="inline h-3.5 w-3.5 mr-1 -mt-0.5" />
                  API Endpoints ({profile.api_endpoints.length})
                </h2>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-800">
                        <th className="py-2 pr-3 text-left text-xs font-medium text-gray-500">
                          Name
                        </th>
                        <th className="py-2 pr-3 text-left text-xs font-medium text-gray-500">
                          Method
                        </th>
                        <th className="py-2 pr-3 text-left text-xs font-medium text-gray-500">
                          URL
                        </th>
                        <th className="py-2 text-left text-xs font-medium text-gray-500">
                          Auth
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {profile.api_endpoints.map((ep, i) => (
                        <tr
                          key={i}
                          className="border-b border-gray-800/50 last:border-0"
                        >
                          <td className="py-2 pr-3 text-gray-200">
                            {ep.name}
                          </td>
                          <td className="py-2 pr-3">
                            <span
                              className={`inline-block rounded px-1.5 py-0.5 text-xs font-mono font-medium border ${
                                METHOD_COLORS[ep.method.toUpperCase()] ||
                                "bg-gray-700 text-gray-300 border-gray-600"
                              }`}
                            >
                              {ep.method.toUpperCase()}
                            </span>
                          </td>
                          <td className="py-2 pr-3">
                            <code className="text-xs text-gray-400 font-mono">
                              {ep.url}
                            </code>
                          </td>
                          <td className="py-2 text-xs text-gray-400">
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
          <div className="rounded-xl border border-gray-700 bg-gray-800 p-6">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-white mb-1">
              <Search className="h-5 w-5 text-said-400" />
              Simulated Agent Query
            </h2>
            <p className="text-sm text-gray-400 mb-4">
              Type a query to see which services and endpoints would match
            </p>
            <div className="relative">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder='e.g. "Book a table for 2 at 7pm"'
                className="w-full rounded-lg border border-gray-600 bg-gray-900 px-4 py-3 pl-10 text-sm text-gray-200 placeholder-gray-500 focus:border-said-500 focus:outline-none focus:ring-1 focus:ring-said-500 transition-colors"
              />
              <Search className="absolute left-3 top-3.5 h-4 w-4 text-gray-500" />
            </div>

            {query.trim() && (
              <div className="mt-4 space-y-3">
                {matchedServices.length > 0 ? (
                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">
                      Matching Services
                    </h3>
                    {matchedServices.map((svc, i) => (
                      <div
                        key={i}
                        className="rounded-lg border border-said-600/20 bg-said-900/10 px-3 py-2 mb-2"
                      >
                        <span className="text-sm font-medium text-said-300">
                          {svc.name}
                        </span>
                        <p className="text-xs text-gray-400 mt-0.5">
                          {svc.description}
                        </p>
                        {svc.api_endpoint && (
                          <div className="flex items-center gap-1 mt-1 text-xs text-gray-500">
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
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">
                      Matching Endpoints
                    </h3>
                    {matchedEndpoints.map((ep, i) => (
                      <div
                        key={i}
                        className="rounded-lg border border-said-600/20 bg-said-900/10 px-3 py-2 mb-2"
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className={`inline-block rounded px-1.5 py-0.5 text-xs font-mono font-medium border ${
                              METHOD_COLORS[ep.method.toUpperCase()] ||
                              "bg-gray-700 text-gray-300 border-gray-600"
                            }`}
                          >
                            {ep.method.toUpperCase()}
                          </span>
                          <span className="text-sm font-medium text-said-300">
                            {ep.name}
                          </span>
                        </div>
                        <p className="text-xs text-gray-400 mt-0.5">
                          {ep.description}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : null}

                {matchedServices.length === 0 &&
                  matchedEndpoints.length === 0 && (
                    <div className="rounded-lg border border-gray-700 bg-gray-900 px-4 py-6 text-center">
                      <Search className="mx-auto h-8 w-8 text-gray-600 mb-2" />
                      <p className="text-sm text-gray-400">
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
    <div className="rounded-lg border border-gray-700/50 bg-gray-900/50 px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-gray-200">{service.name}</h3>
          <p className="text-xs text-gray-400 mt-0.5">{service.description}</p>
        </div>
        {service.price && (
          <span className="flex-shrink-0 rounded-md bg-gray-800 border border-gray-700 px-2 py-0.5 text-xs font-medium text-gray-300">
            {service.price}
          </span>
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {service.availability && (
          <span className="inline-flex items-center gap-1 text-xs text-gray-500">
            <Clock className="h-3 w-3" />
            {service.availability}
          </span>
        )}
        {service.api_endpoint && (
          <span className="inline-flex items-center gap-1 text-xs text-gray-500">
            <Zap className="h-3 w-3" />
            {service.api_endpoint}
          </span>
        )}
        {service.booking_url && (
          <span className="inline-flex items-center gap-1 text-xs text-gray-500">
            <ExternalLink className="h-3 w-3" />
            Book online
          </span>
        )}
      </div>
    </div>
  );
}
