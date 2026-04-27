"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { getProfile, updateProfile } from "@/lib/api";
import { JsonEditor } from "@/components/JsonEditor";
import type {
  ServiceDefinition,
  ApiEndpoint,
  PolicyDefinition,
} from "@/lib/types";

type Tab = "services" | "endpoints" | "policies";

const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH"] as const;
const AUTH_TYPES = ["none", "api_key", "ucan", "oauth2"] as const;
const POLICY_NAMES = [
  "cancellation",
  "refund",
  "privacy",
  "terms",
  "custom",
] as const;

// ---------------------------------------------------------------------------
// Empty factories
// ---------------------------------------------------------------------------

function emptyService(): ServiceDefinition {
  return {
    name: "",
    description: "",
    price: undefined,
    availability: undefined,
    booking_url: undefined,
    api_endpoint: undefined,
    parameters: {},
  };
}

function emptyEndpoint(): ApiEndpoint {
  return {
    name: "",
    url: "",
    method: "GET",
    auth_type: "none",
    description: "",
    request_schema: {},
    response_schema: {},
  };
}

function emptyPolicy(): PolicyDefinition {
  return { name: "cancellation", content: "", machine_readable: {} };
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function Skeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          className="h-28 rounded-lg bg-[#161822] border border-[#1e2a3a]"
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ServicesPage() {
  const { authenticated, loading: authLoading } = useAuth();
  const router = useRouter();

  const [activeTab, setActiveTab] = useState<Tab>("services");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Data
  const [services, setServices] = useState<ServiceDefinition[]>([]);
  const [endpoints, setEndpoints] = useState<ApiEndpoint[]>([]);
  const [policies, setPolicies] = useState<PolicyDefinition[]>([]);

  // Editing indices (-1 = none, -2 = adding new)
  const [editingService, setEditingService] = useState(-1);
  const [editingEndpoint, setEditingEndpoint] = useState(-1);
  const [editingPolicy, setEditingPolicy] = useState(-1);

  // Draft values for the form currently being edited
  const [draftService, setDraftService] = useState<ServiceDefinition>(
    emptyService()
  );
  const [draftEndpoint, setDraftEndpoint] = useState<ApiEndpoint>(
    emptyEndpoint()
  );
  const [draftPolicy, setDraftPolicy] = useState<PolicyDefinition>(
    emptyPolicy()
  );

  // ------------------------------- fetch -----------------------------------

  const fetchProfile = useCallback(async () => {
    try {
      setLoading(true);
      const profile = await getProfile();
      setServices(profile.services || []);
      setEndpoints(profile.api_endpoints || []);
      setPolicies(profile.policies || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load profile");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!authenticated) {
      router.push("/identity/login");
      return;
    }
    fetchProfile();
  }, [authenticated, authLoading, router, fetchProfile]);

  // ------------------------------- save helpers ----------------------------

  function flash(msg: string) {
    setSuccess(msg);
    setTimeout(() => setSuccess(null), 2500);
  }

  async function saveServices(next: ServiceDefinition[]) {
    setSaving(true);
    setError(null);
    try {
      await updateProfile({ services: next });
      setServices(next);
      flash("Services saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function saveEndpoints(next: ApiEndpoint[]) {
    setSaving(true);
    setError(null);
    try {
      await updateProfile({ api_endpoints: next });
      setEndpoints(next);
      flash("Endpoints saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function savePolicies(next: PolicyDefinition[]) {
    setSaving(true);
    setError(null);
    try {
      await updateProfile({ policies: next });
      setPolicies(next);
      flash("Policies saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  // ------------------------------- service CRUD ----------------------------

  function startAddService() {
    setDraftService(emptyService());
    setEditingService(-2);
  }

  function startEditService(idx: number) {
    setDraftService({ ...services[idx] });
    setEditingService(idx);
  }

  async function commitService() {
    if (!draftService.name.trim()) return;
    let next: ServiceDefinition[];
    if (editingService === -2) {
      next = [...services, draftService];
    } else {
      next = services.map((s, i) => (i === editingService ? draftService : s));
    }
    await saveServices(next);
    setEditingService(-1);
  }

  async function deleteService(idx: number) {
    const next = services.filter((_, i) => i !== idx);
    await saveServices(next);
    if (editingService === idx) setEditingService(-1);
  }

  // ------------------------------- endpoint CRUD ---------------------------

  function startAddEndpoint() {
    setDraftEndpoint(emptyEndpoint());
    setEditingEndpoint(-2);
  }

  function startEditEndpoint(idx: number) {
    setDraftEndpoint({ ...endpoints[idx] });
    setEditingEndpoint(idx);
  }

  async function commitEndpoint() {
    if (!draftEndpoint.name.trim() || !draftEndpoint.url.trim()) return;
    let next: ApiEndpoint[];
    if (editingEndpoint === -2) {
      next = [...endpoints, draftEndpoint];
    } else {
      next = endpoints.map((e, i) =>
        i === editingEndpoint ? draftEndpoint : e
      );
    }
    await saveEndpoints(next);
    setEditingEndpoint(-1);
  }

  async function deleteEndpoint(idx: number) {
    const next = endpoints.filter((_, i) => i !== idx);
    await saveEndpoints(next);
    if (editingEndpoint === idx) setEditingEndpoint(-1);
  }

  // ------------------------------- policy CRUD -----------------------------

  function startAddPolicy() {
    setDraftPolicy(emptyPolicy());
    setEditingPolicy(-2);
  }

  function startEditPolicy(idx: number) {
    setDraftPolicy({ ...policies[idx] });
    setEditingPolicy(idx);
  }

  async function commitPolicy() {
    if (!draftPolicy.content.trim()) return;
    let next: PolicyDefinition[];
    if (editingPolicy === -2) {
      next = [...policies, draftPolicy];
    } else {
      next = policies.map((p, i) => (i === editingPolicy ? draftPolicy : p));
    }
    await savePolicies(next);
    setEditingPolicy(-1);
  }

  async function deletePolicy(idx: number) {
    const next = policies.filter((_, i) => i !== idx);
    await savePolicies(next);
    if (editingPolicy === idx) setEditingPolicy(-1);
  }

  // ------------------------------- shared UI helpers -----------------------

  const inputClass =
    "w-full rounded-md bg-[#0f1117] px-3 py-2 text-sm text-[#eef1f8] placeholder-[#4a5568] border border-[#1e2a3a] focus:outline-none focus:ring-1 focus:ring-[#3da8ff] focus:border-[#3da8ff]";
  const selectClass =
    "w-full rounded-md bg-[#0f1117] px-3 py-2 text-sm text-[#eef1f8] border border-[#1e2a3a] focus:outline-none focus:ring-1 focus:ring-[#3da8ff] focus:border-[#3da8ff]";
  const btnPrimary =
    "rounded-md bg-[#2b96f0] px-4 py-2 text-sm font-medium text-[#eef1f8] hover:bg-[#5bb8ff] transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer";
  const btnSecondary =
    "rounded-md border border-[#1e2a3a] px-4 py-2 text-sm font-medium text-[#8b95a8] hover:bg-[#161822] transition-colors cursor-pointer";
  const btnDanger =
    "rounded-md border border-red-700 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-900/30 transition-colors cursor-pointer";

  // ------------------------------- form renderers --------------------------

  function renderServiceForm() {
    return (
      <div className="space-y-3">
        <div>
          <label className="block text-sm font-medium text-[#8b95a8] mb-1">
            Name *
          </label>
          <input
            className={inputClass}
            placeholder="e.g. Haircut & Styling"
            value={draftService.name}
            onChange={(e) =>
              setDraftService({ ...draftService, name: e.target.value })
            }
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-[#8b95a8] mb-1">
            Description *
          </label>
          <textarea
            className={inputClass}
            rows={3}
            placeholder="What does this service offer?"
            value={draftService.description}
            onChange={(e) =>
              setDraftService({ ...draftService, description: e.target.value })
            }
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-[#8b95a8] mb-1">
              Price
            </label>
            <input
              className={inputClass}
              placeholder="e.g. $50/session"
              value={draftService.price || ""}
              onChange={(e) =>
                setDraftService({
                  ...draftService,
                  price: e.target.value || undefined,
                })
              }
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-[#8b95a8] mb-1">
              Availability
            </label>
            <input
              className={inputClass}
              placeholder="e.g. Mon-Fri 9am-5pm"
              value={draftService.availability || ""}
              onChange={(e) =>
                setDraftService({
                  ...draftService,
                  availability: e.target.value || undefined,
                })
              }
            />
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-[#8b95a8] mb-1">
              Booking URL
            </label>
            <input
              type="url"
              className={inputClass}
              placeholder="https://..."
              value={draftService.booking_url || ""}
              onChange={(e) =>
                setDraftService({
                  ...draftService,
                  booking_url: e.target.value || undefined,
                })
              }
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-[#8b95a8] mb-1">
              API Endpoint
            </label>
            <input
              type="url"
              className={inputClass}
              placeholder="https://api.example.com/..."
              value={draftService.api_endpoint || ""}
              onChange={(e) =>
                setDraftService({
                  ...draftService,
                  api_endpoint: e.target.value || undefined,
                })
              }
            />
          </div>
        </div>
        <div className="flex gap-2 pt-2">
          <button
            className={btnPrimary}
            disabled={saving || !draftService.name.trim()}
            onClick={commitService}
          >
            {saving ? "Saving..." : "Save"}
          </button>
          <button
            className={btnSecondary}
            onClick={() => setEditingService(-1)}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  function renderEndpointForm() {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-[#8b95a8] mb-1">
              Name *
            </label>
            <input
              className={inputClass}
              placeholder="e.g. Create Booking"
              value={draftEndpoint.name}
              onChange={(e) =>
                setDraftEndpoint({ ...draftEndpoint, name: e.target.value })
              }
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-[#8b95a8] mb-1">
              URL *
            </label>
            <input
              type="url"
              className={inputClass}
              placeholder="https://api.example.com/v1/bookings"
              value={draftEndpoint.url}
              onChange={(e) =>
                setDraftEndpoint({ ...draftEndpoint, url: e.target.value })
              }
            />
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-[#8b95a8] mb-1">
              Method
            </label>
            <select
              className={selectClass}
              value={draftEndpoint.method}
              onChange={(e) =>
                setDraftEndpoint({ ...draftEndpoint, method: e.target.value })
              }
            >
              {HTTP_METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-[#8b95a8] mb-1">
              Auth Type
            </label>
            <select
              className={selectClass}
              value={draftEndpoint.auth_type}
              onChange={(e) =>
                setDraftEndpoint({
                  ...draftEndpoint,
                  auth_type: e.target.value,
                })
              }
            >
              {AUTH_TYPES.map((a) => (
                <option key={a} value={a}>
                  {a === "api_key"
                    ? "API Key"
                    : a === "ucan"
                    ? "Delegated"
                    : a === "oauth2"
                    ? "OAuth2"
                    : "None"}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-[#8b95a8] mb-1">
            Description
          </label>
          <textarea
            className={inputClass}
            rows={2}
            placeholder="What does this endpoint do?"
            value={draftEndpoint.description}
            onChange={(e) =>
              setDraftEndpoint({
                ...draftEndpoint,
                description: e.target.value,
              })
            }
          />
        </div>
        <JsonEditor
          label="Request Schema"
          value={draftEndpoint.request_schema}
          onChange={(v) =>
            setDraftEndpoint({ ...draftEndpoint, request_schema: v })
          }
          placeholder='{ "type": "object", "properties": { ... } }'
        />
        <JsonEditor
          label="Response Schema"
          value={draftEndpoint.response_schema}
          onChange={(v) =>
            setDraftEndpoint({ ...draftEndpoint, response_schema: v })
          }
          placeholder='{ "type": "object", "properties": { ... } }'
        />
        <div className="flex gap-2 pt-2">
          <button
            className={btnPrimary}
            disabled={
              saving ||
              !draftEndpoint.name.trim() ||
              !draftEndpoint.url.trim()
            }
            onClick={commitEndpoint}
          >
            {saving ? "Saving..." : "Save"}
          </button>
          <button
            className={btnSecondary}
            onClick={() => setEditingEndpoint(-1)}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  function renderPolicyForm() {
    return (
      <div className="space-y-3">
        <div>
          <label className="block text-sm font-medium text-[#8b95a8] mb-1">
            Policy Type
          </label>
          <select
            className={selectClass}
            value={draftPolicy.name}
            onChange={(e) =>
              setDraftPolicy({ ...draftPolicy, name: e.target.value })
            }
          >
            {POLICY_NAMES.map((p) => (
              <option key={p} value={p}>
                {p.charAt(0).toUpperCase() + p.slice(1)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-[#8b95a8] mb-1">
            Content *
          </label>
          <textarea
            className={inputClass}
            rows={5}
            placeholder="Human-readable policy text..."
            value={draftPolicy.content}
            onChange={(e) =>
              setDraftPolicy({ ...draftPolicy, content: e.target.value })
            }
          />
        </div>
        <JsonEditor
          label="Machine Readable"
          value={draftPolicy.machine_readable}
          onChange={(v) =>
            setDraftPolicy({ ...draftPolicy, machine_readable: v })
          }
          placeholder='{ "refund_window_days": 30, "conditions": [...] }'
        />
        <div className="flex gap-2 pt-2">
          <button
            className={btnPrimary}
            disabled={saving || !draftPolicy.content.trim()}
            onClick={commitPolicy}
          >
            {saving ? "Saving..." : "Save"}
          </button>
          <button
            className={btnSecondary}
            onClick={() => setEditingPolicy(-1)}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // ------------------------------- tabs ------------------------------------

  const tabs: { key: Tab; label: string }[] = [
    { key: "services", label: "Services" },
    { key: "endpoints", label: "API Endpoints" },
    { key: "policies", label: "Policies" },
  ];

  // ------------------------------- render ----------------------------------

  if (authLoading) {
    return (
      <div className="mx-auto max-w-4xl px-4 pt-24">
        <Skeleton />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 pt-24 pb-16">
      <h1 className="font-display text-2xl font-medium text-[#eef1f8] mb-6">
        Services &amp; Endpoints
      </h1>

      {/* Notifications */}
      {error && (
        <div className="mb-4 rounded-md bg-red-900/40 border border-red-700 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}
      {success && (
        <div className="mb-4 rounded-md bg-green-900/40 border border-green-700 px-4 py-3 text-sm text-green-300">
          {success}
        </div>
      )}

      {/* Tab bar */}
      <div className="flex border-b border-[#1e2a3a] mb-6">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={`px-4 py-2.5 text-sm font-medium transition-colors cursor-pointer ${
              activeTab === t.key
                ? "text-[#3da8ff] border-b-2 border-[#3da8ff]"
                : "text-[#8b95a8] hover:text-[#eef1f8]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <Skeleton />
      ) : (
        <>
          {/* ==================== SERVICES TAB ==================== */}
          {activeTab === "services" && (
            <div className="space-y-4">
              {services.length === 0 && editingService === -1 && (
                <div className="rounded-lg bg-[#0f1117] border border-[#1e2a3a] p-8 text-center">
                  <p className="text-[#8b95a8]">
                    No services yet. Add your first service to help AI agents
                    discover what you offer.
                  </p>
                </div>
              )}

              {services.map((svc, idx) =>
                editingService === idx ? (
                  <div
                    key={idx}
                    className="rounded-lg bg-[#161822] border border-[#2b96f0] p-4"
                  >
                    {renderServiceForm()}
                  </div>
                ) : (
                  <div
                    key={idx}
                    className="rounded-lg bg-[#161822] border border-[#1e2a3a] p-4"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <h3 className="text-base font-semibold text-[#eef1f8] truncate">
                          {svc.name}
                        </h3>
                        <p className="mt-1 text-sm text-[#8b95a8] line-clamp-2">
                          {svc.description}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-3 text-xs text-[#4a5568]">
                          {svc.price && <span>Price: {svc.price}</span>}
                          {svc.availability && (
                            <span>Availability: {svc.availability}</span>
                          )}
                          {svc.booking_url && <span>Has booking URL</span>}
                          {svc.api_endpoint && <span>Has API endpoint</span>}
                        </div>
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <button
                          className={btnSecondary}
                          onClick={() => startEditService(idx)}
                        >
                          Edit
                        </button>
                        <button
                          className={btnDanger}
                          onClick={() => deleteService(idx)}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                )
              )}

              {editingService === -2 && (
                <div className="rounded-lg bg-[#161822] border border-[#2b96f0] p-4">
                  {renderServiceForm()}
                </div>
              )}

              {editingService === -1 && (
                <button className={btnPrimary} onClick={startAddService}>
                  Add Service
                </button>
              )}
            </div>
          )}

          {/* ==================== ENDPOINTS TAB ==================== */}
          {activeTab === "endpoints" && (
            <div className="space-y-4">
              {endpoints.length === 0 && editingEndpoint === -1 && (
                <div className="rounded-lg bg-[#0f1117] border border-[#1e2a3a] p-8 text-center">
                  <p className="text-[#8b95a8]">
                    No API endpoints yet. Add endpoints so AI agents can
                    interact with your services programmatically.
                  </p>
                </div>
              )}

              {endpoints.map((ep, idx) =>
                editingEndpoint === idx ? (
                  <div
                    key={idx}
                    className="rounded-lg bg-[#161822] border border-[#2b96f0] p-4"
                  >
                    {renderEndpointForm()}
                  </div>
                ) : (
                  <div
                    key={idx}
                    className="rounded-lg bg-[#161822] border border-[#1e2a3a] p-4"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="inline-block rounded bg-[#1c1f2e] px-2 py-0.5 text-xs font-mono text-[#5bb8ff]">
                            {ep.method}
                          </span>
                          <h3 className="text-base font-semibold text-[#eef1f8] truncate">
                            {ep.name}
                          </h3>
                        </div>
                        <p className="mt-1 text-sm text-[#4a5568] font-mono truncate">
                          {ep.url}
                        </p>
                        {ep.description && (
                          <p className="mt-1 text-sm text-[#8b95a8] line-clamp-2">
                            {ep.description}
                          </p>
                        )}
                        <div className="mt-2 flex flex-wrap gap-3 text-xs text-[#4a5568]">
                          <span>
                            Auth:{" "}
                            {ep.auth_type === "api_key"
                              ? "API Key"
                              : ep.auth_type === "ucan"
                              ? "Delegated"
                              : ep.auth_type === "oauth2"
                              ? "OAuth2"
                              : "None"}
                          </span>
                          {Object.keys(ep.request_schema).length > 0 && (
                            <span>Has request schema</span>
                          )}
                          {Object.keys(ep.response_schema).length > 0 && (
                            <span>Has response schema</span>
                          )}
                        </div>
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <button
                          className={btnSecondary}
                          onClick={() => startEditEndpoint(idx)}
                        >
                          Edit
                        </button>
                        <button
                          className={btnDanger}
                          onClick={() => deleteEndpoint(idx)}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                )
              )}

              {editingEndpoint === -2 && (
                <div className="rounded-lg bg-[#161822] border border-[#2b96f0] p-4">
                  {renderEndpointForm()}
                </div>
              )}

              {editingEndpoint === -1 && (
                <button className={btnPrimary} onClick={startAddEndpoint}>
                  Add Endpoint
                </button>
              )}
            </div>
          )}

          {/* ==================== POLICIES TAB ==================== */}
          {activeTab === "policies" && (
            <div className="space-y-4">
              {policies.length === 0 && editingPolicy === -1 && (
                <div className="rounded-lg bg-[#0f1117] border border-[#1e2a3a] p-8 text-center">
                  <p className="text-[#8b95a8]">
                    No policies yet. Define cancellation, refund, privacy, or
                    custom policies for AI agents to reference.
                  </p>
                </div>
              )}

              {policies.map((pol, idx) =>
                editingPolicy === idx ? (
                  <div
                    key={idx}
                    className="rounded-lg bg-[#161822] border border-[#2b96f0] p-4"
                  >
                    {renderPolicyForm()}
                  </div>
                ) : (
                  <div
                    key={idx}
                    className="rounded-lg bg-[#161822] border border-[#1e2a3a] p-4"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <h3 className="text-base font-semibold text-[#eef1f8]">
                          {pol.name.charAt(0).toUpperCase() + pol.name.slice(1)}
                        </h3>
                        <p className="mt-1 text-sm text-[#8b95a8] line-clamp-3 whitespace-pre-wrap">
                          {pol.content}
                        </p>
                        {Object.keys(pol.machine_readable).length > 0 && (
                          <p className="mt-2 text-xs text-[#4a5568]">
                            Has machine-readable data
                          </p>
                        )}
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <button
                          className={btnSecondary}
                          onClick={() => startEditPolicy(idx)}
                        >
                          Edit
                        </button>
                        <button
                          className={btnDanger}
                          onClick={() => deletePolicy(idx)}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                )
              )}

              {editingPolicy === -2 && (
                <div className="rounded-lg bg-[#161822] border border-[#2b96f0] p-4">
                  {renderPolicyForm()}
                </div>
              )}

              {editingPolicy === -1 && (
                <button className={btnPrimary} onClick={startAddPolicy}>
                  Add Policy
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
