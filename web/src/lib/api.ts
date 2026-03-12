import type {
  BusinessProfile,
  PublicProfile,
  AnalyticsSummary,
  DomainVerification,
  BillingStatus,
  AnalyticsTimeline,
  AgentStats,
  DiscoveryFunnel,
  InferenceNode,
  NodeHeartbeat,
  Model,
  ModelsResponse,
  CreatorStats,
  Balance,
} from "./types";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080/v1";

function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("ghola_token");
}

export function setToken(token: string) {
  localStorage.setItem("ghola_token", token);
}

export function clearToken() {
  localStorage.removeItem("ghola_token");
}

async function apiFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) || {}),
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (!res.ok) {
    const body = await res
      .json()
      .catch(() => ({ error: `API error ${res.status}` }));
    throw new Error(body.error || `API error ${res.status}`);
  }
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text);
}

// Auth

export async function register(data: {
  email: string;
  password: string;
  business_name: string;
  category: string;
  website: string;
}): Promise<{ token: string; user: { id: string; email: string } }> {
  const res = await apiFetch<{
    token: string;
    user: { id: string; email: string };
  }>("/auth/register", {
    method: "POST",
    body: JSON.stringify(data),
  });
  setToken(res.token);
  return res;
}

export async function login(data: {
  email: string;
  password: string;
}): Promise<{ token: string; user: { id: string; email: string } }> {
  const res = await apiFetch<{
    token: string;
    user: { id: string; email: string };
  }>("/auth/login", {
    method: "POST",
    body: JSON.stringify(data),
  });
  setToken(res.token);
  return res;
}

// Business Profile

export async function getProfile(): Promise<BusinessProfile> {
  return apiFetch<BusinessProfile>("/business/profile");
}

export async function updateProfile(
  data: Partial<BusinessProfile>
): Promise<BusinessProfile> {
  return apiFetch<BusinessProfile>("/business/profile", {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

// Domain Verification

export async function verifyDomain(
  method: string
): Promise<DomainVerification> {
  return apiFetch<DomainVerification>("/business/verify-domain", {
    method: "POST",
    body: JSON.stringify({ method }),
  });
}

export async function checkDomainVerification(): Promise<{
  verified: boolean;
  domain?: string;
  message?: string;
}> {
  return apiFetch<{ verified: boolean; domain?: string; message?: string }>(
    "/business/check-domain-verification",
    { method: "POST" }
  );
}

// Generated Files

export async function getAgentsTxt(): Promise<string> {
  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}/business/agents-txt`, { headers });
  if (!res.ok) throw new Error("Failed to fetch agents.txt");
  return res.text();
}

export async function getWellKnownSaid(): Promise<string> {
  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}/business/well-known`, { headers });
  if (!res.ok) throw new Error("Failed to fetch said.json");
  return res.text();
}

// Analytics

export async function getAnalytics(): Promise<AnalyticsSummary> {
  return apiFetch<AnalyticsSummary>("/analytics/summary");
}

// Consumer Auth

export async function registerConsumer(data: {
  email: string;
  password: string;
  display_name: string;
}): Promise<{ token: string; user: { id: string; email: string } }> {
  const res = await apiFetch<{ token: string; user: { id: string; email: string } }>(
    "/consumer/register",
    { method: "POST", body: JSON.stringify(data) }
  );
  setToken(res.token);
  return res;
}

// Consumer Profile

export async function getConsumerProfile(): Promise<PublicProfile> {
  return apiFetch<PublicProfile>("/consumer/profile");
}

export async function updateConsumerProfile(data: Partial<PublicProfile>): Promise<PublicProfile> {
  return apiFetch<PublicProfile>("/consumer/profile", {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

// Encrypted Wallet

export async function uploadWallet(encrypted_wallet: string): Promise<void> {
  await apiFetch("/consumer/wallet", {
    method: "POST",
    body: JSON.stringify({ encrypted_wallet }),
  });
}

export async function downloadWallet(): Promise<{ encrypted_wallet: string } | null> {
  try {
    return await apiFetch<{ encrypted_wallet: string }>("/consumer/wallet");
  } catch {
    return null;
  }
}

// Billing

export async function getBillingStatus(): Promise<BillingStatus> {
  return apiFetch<BillingStatus>("/billing/status");
}

export async function createCheckout(product: string): Promise<{ checkout_url: string }> {
  return apiFetch<{ checkout_url: string }>("/billing/create-checkout", {
    method: "POST",
    body: JSON.stringify({ product }),
  });
}

export async function getBillingPortal(): Promise<{ portal_url: string }> {
  return apiFetch<{ portal_url: string }>("/billing/portal");
}

// Expanded Analytics

export async function getAnalyticsTimeline(days?: number): Promise<AnalyticsTimeline> {
  const params = days ? `?days=${days}` : "";
  return apiFetch<AnalyticsTimeline>(`/analytics/timeline${params}`);
}

export async function getAgentStats(): Promise<AgentStats> {
  return apiFetch<AgentStats>("/analytics/agents");
}

export async function getDiscoveryFunnel(): Promise<DiscoveryFunnel> {
  return apiFetch<DiscoveryFunnel>("/analytics/funnel");
}

// Badges

export async function requestBadge(notes?: string): Promise<{ status: string; message: string }> {
  return apiFetch<{ status: string; message: string }>("/badges/request", {
    method: "POST",
    body: JSON.stringify({ notes: notes || "" }),
  });
}

// ── Inference Nodes API ──

export async function registerNode(data: {
  endpoint_url: string;
  models_served: string[];
  price_per_query_micro_usdc?: number;
  region?: string;
  description?: string;
}) {
  return apiFetch<InferenceNode>("/nodes/register", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function getNodes(params?: { model?: string; region?: string }) {
  const sp = new URLSearchParams();
  if (params?.model) sp.set("model", params.model);
  if (params?.region) sp.set("region", params.region);
  const qs = sp.toString();
  return apiFetch<{ nodes: InferenceNode[]; total: number }>(`/nodes${qs ? `?${qs}` : ""}`);
}

export async function getNode(id: string) {
  return apiFetch<{ node: InferenceNode; heartbeats: NodeHeartbeat[] }>(`/nodes/${id}`);
}

export async function updateNode(id: string, data: Partial<InferenceNode>) {
  return apiFetch<InferenceNode>(`/nodes/manage/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function deleteNode(id: string) {
  return apiFetch<void>(`/nodes/manage/${id}`, { method: "DELETE" });
}

// ══════════════════════════════════════════════════════════════
// Orni Models API
// ══════════════════════════════════════════════════════════════

const ORNI_API_BASE =
  process.env.NEXT_PUBLIC_ORNI_API_URL || "http://localhost:8081/api";

function getOrniToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("ghola_orni_token");
}

function setOrniToken(token: string) {
  localStorage.setItem("ghola_orni_token", token);
}

export function clearOrniToken() {
  localStorage.removeItem("ghola_orni_token");
}

async function orniFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getOrniToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) || {}),
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const res = await fetch(`${ORNI_API_BASE}${path}`, { ...options, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `API error ${res.status}` }));
    throw new Error(body.error || `API error ${res.status}`);
  }
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text);
}

// Orni Identity

export async function linkDid(did: string, saidToken: string) {
  return orniFetch<{ message: string }>("/identity/link", {
    method: "POST",
    body: JSON.stringify({ did, said_token: saidToken }),
  });
}

// Orni Auth

export async function orniGetNonce(wallet: string) {
  return orniFetch<{ nonce: string; message: string }>("/auth/nonce", {
    method: "POST",
    body: JSON.stringify({ wallet_address: wallet }),
  });
}

export async function orniVerifySignature(wallet: string, signature: string, nonce: string) {
  const res = await orniFetch<{ token: string; user: { id: string; is_creator: boolean } }>(
    "/auth/verify",
    {
      method: "POST",
      body: JSON.stringify({ wallet_address: wallet, signature, nonce }),
    }
  );
  setOrniToken(res.token);
  return { token: res.token, is_creator: res.user.is_creator };
}

// Orni Models

export async function getModels(params?: {
  search?: string;
  category?: string;
  sort?: string;
  page?: number;
  limit?: number;
}) {
  const sp = new URLSearchParams();
  if (params?.search) sp.set("search", params.search);
  if (params?.category) sp.set("category", params.category);
  if (params?.sort) sp.set("sort", params.sort);
  if (params?.page) sp.set("page", String(params.page));
  if (params?.limit) sp.set("limit", String(params.limit));
  const qs = sp.toString();
  return orniFetch<ModelsResponse>(`/models${qs ? `?${qs}` : ""}`);
}

export async function getModel(slug: string) {
  return orniFetch<Model>(`/models/${slug}`);
}

export async function createModel(data: {
  name: string;
  slug: string;
  description?: string;
  system_prompt: string;
  price_per_query?: number;
  category?: string;
}) {
  return orniFetch<Model>("/models/create", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateModel(id: string, data: Partial<Model>) {
  return orniFetch<Model>(`/models/id/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

// Orni Chat (SSE streaming)

export function sendMessage(
  slug: string,
  message: string,
  sessionId?: string
): ReadableStream<string> {
  const token = getOrniToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  return new ReadableStream<string>({
    async start(controller) {
      try {
        const res = await fetch(`${ORNI_API_BASE}/chat/${slug}/message`, {
          method: "POST",
          headers,
          body: JSON.stringify({ message, session_id: sessionId }),
        });
        if (!res.ok) {
          const err = await res.text().catch(() => "Chat error");
          controller.error(new Error(err));
          return;
        }
        const reader = res.body?.getReader();
        if (!reader) {
          controller.close();
          return;
        }
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const data = line.slice(6);
              if (data === "[DONE]") {
                controller.close();
                return;
              }
              try {
                const parsed = JSON.parse(data);
                if (parsed.content) controller.enqueue(parsed.content);
                if (parsed.session_id && !sessionId) {
                  controller.enqueue(`__session:${parsed.session_id}`);
                }
              } catch {
                controller.enqueue(data);
              }
            }
          }
        }
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });
}

// Orni Balance & Payments

export async function getBalance() {
  return orniFetch<Balance>("/balance");
}

export async function submitDeposit(txSignature: string, amount: number) {
  return orniFetch<{ id: string; amount: number }>("/deposits", {
    method: "POST",
    body: JSON.stringify({ tx_signature: txSignature, amount }),
  });
}

export async function requestWithdraw(amount: number, destinationWallet: string) {
  return orniFetch<{ status: string; message: string }>("/withdraw", {
    method: "POST",
    body: JSON.stringify({ amount, destination_wallet: destinationWallet }),
  });
}

// Orni Creator

export async function getCreatorStats() {
  return orniFetch<CreatorStats>("/creator/stats");
}

export async function getCreatorModels() {
  return orniFetch<Model[]>("/creator/models");
}

export async function addContent(
  modelId: string,
  data: { source_type: string; content_text?: string; source_url?: string }
) {
  return orniFetch(`/models/id/${modelId}/content`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function startFineTune(modelId: string) {
  return orniFetch(`/creator/models/${modelId}/fine-tune`, { method: "POST" });
}

// Namespace export for pages that use api.method()
export const orniApi = {
  orniGetNonce,
  orniVerifySignature,
  getModels,
  getModel,
  createModel,
  updateModel,
  sendMessage,
  getBalance,
  submitDeposit,
  requestWithdraw,
  getCreatorStats,
  getCreatorModels,
  addContent,
  startFineTune,
  clearOrniToken,
  linkDid,
};
