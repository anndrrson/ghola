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
  EncryptedAgentConfig,
  EncryptedSnapshot,
  ServiceListingResponse,
  ServiceDetail,
  ReputationScore,
  Agent,
  AgentDetail,
  AgentWallet,
  CreateAgentRequest,
  UpdateAgentRequest,
  AgentEarnings,
  AgentReputationView,
  CreateAgentServiceRequest,
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
  process.env.NEXT_PUBLIC_ORNI_API_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  "https://orni-models-api.onrender.com/api";

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
  // Foundation-catalog filters honored by the backend MarketplaceQuery.
  min_params?: number; // billions
  max_params?: number; // billions
  developer?: string;
  license?: string;
  is_foundation?: boolean;
}) {
  const sp = new URLSearchParams();
  if (params?.search) sp.set("search", params.search);
  if (params?.category) sp.set("category", params.category);
  if (params?.sort) sp.set("sort", params.sort);
  if (params?.page) sp.set("page", String(params.page));
  if (params?.limit) sp.set("limit", String(params.limit));
  if (params?.min_params != null) sp.set("min_params", String(params.min_params));
  if (params?.max_params != null) sp.set("max_params", String(params.max_params));
  if (params?.developer) sp.set("developer", params.developer);
  if (params?.license) sp.set("license", params.license);
  if (params?.is_foundation != null) sp.set("is_foundation", String(params.is_foundation));
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

// ── Chat API ──

export async function getChatAgents(): Promise<EncryptedAgentConfig[]> {
  return apiFetch<EncryptedAgentConfig[]>("/chat/agents");
}

export async function saveChatAgent(data: {
  encrypted_config: string;
  display_order?: number;
}): Promise<EncryptedAgentConfig> {
  return apiFetch<EncryptedAgentConfig>("/chat/agents", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateChatAgent(
  id: string,
  data: {
    encrypted_config?: string;
    display_order?: number;
    last_message_at?: string;
  }
): Promise<EncryptedAgentConfig> {
  return apiFetch<EncryptedAgentConfig>(`/chat/agents/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function deleteChatAgent(id: string): Promise<void> {
  await apiFetch(`/chat/agents/${id}`, { method: "DELETE" });
}

export async function getChatHistory(
  agentId: string
): Promise<EncryptedSnapshot | null> {
  return apiFetch<EncryptedSnapshot | null>(`/chat/history/${agentId}`);
}

export async function saveChatHistory(
  agentId: string,
  data: { encrypted_messages: string; message_count: number }
): Promise<EncryptedSnapshot> {
  return apiFetch<EncryptedSnapshot>(`/chat/history/${agentId}`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function chatRelay(
  provider: string,
  model: string,
  apiKey: string,
  messages: { role: string; content: string }[],
  system?: string,
  baseUrl?: string
): ReadableStream<string> {
  const token = getToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  return new ReadableStream<string>({
    async start(controller) {
      try {
        const payload: Record<string, unknown> = { provider, model, api_key: apiKey, messages, system, stream: true };
        if (baseUrl) payload.base_url = baseUrl;
        const res = await fetch(`${API_BASE}/chat/relay`, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const err = await res.text().catch(() => "Chat relay error");
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
                // Handle different provider response formats
                // OpenAI/Mistral format
                if (parsed.choices?.[0]?.delta?.content) {
                  controller.enqueue(parsed.choices[0].delta.content);
                }
                // Anthropic format
                else if (parsed.type === "content_block_delta" && parsed.delta?.text) {
                  controller.enqueue(parsed.delta.text);
                }
                // Google format
                else if (parsed.candidates?.[0]?.content?.parts?.[0]?.text) {
                  controller.enqueue(parsed.candidates[0].content.parts[0].text);
                }
                // Simple format
                else if (parsed.content) {
                  controller.enqueue(parsed.content);
                }
              } catch {
                // Not JSON, might be raw text
                if (data.trim()) controller.enqueue(data);
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

// ── Service Registry ──

export async function searchServices(
  query: string,
  filters?: {
    category?: string;
    maxPrice?: number;
    minRating?: number;
    minUptime?: number;
    region?: string;
  }
): Promise<{ services: ServiceListingResponse[]; total: number }> {
  const params = new URLSearchParams({ task: query });
  if (filters?.category) params.set("category", filters.category);
  if (filters?.maxPrice !== undefined)
    params.set("max_price_micro_usdc", String(filters.maxPrice));
  if (filters?.minRating !== undefined)
    params.set("min_rating", String(filters.minRating));
  if (filters?.minUptime !== undefined)
    params.set("min_uptime", String(filters.minUptime));
  if (filters?.region) params.set("region", filters.region);

  const res = await fetch(`${API_BASE}/services/resolve?${params}`);
  if (!res.ok) throw new Error("Failed to search services");
  return res.json();
}

export async function listServices(
  params?: {
    category?: string;
    q?: string;
    sort?: string;
    page?: number;
    limit?: number;
  }
): Promise<{ services: ServiceListingResponse[]; total: number; page: number }> {
  const p = new URLSearchParams();
  if (params?.category) p.set("category", params.category);
  if (params?.q) p.set("q", params.q);
  if (params?.sort) p.set("sort", params.sort);
  if (params?.page) p.set("page", String(params.page));
  if (params?.limit) p.set("limit", String(params.limit));

  const res = await fetch(`${API_BASE}/services?${p}`);
  if (!res.ok) throw new Error("Failed to list services");
  return res.json();
}

export async function getMyServices(): Promise<{
  services: ServiceListingResponse[];
  total_services: number;
  total_revenue_micro_usdc: number;
  total_requests: number;
}> {
  return apiFetch("/services/mine");
}

export async function getServiceDetail(
  slugOrId: string
): Promise<{ service: ServiceDetail; heartbeats: unknown[] }> {
  const res = await fetch(`${API_BASE}/services/${encodeURIComponent(slugOrId)}`);
  if (!res.ok) throw new Error("Service not found");
  return res.json();
}

export async function registerService(
  data: Record<string, unknown>
): Promise<ServiceListingResponse> {
  return apiFetch<ServiceListingResponse>("/services/register", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function getReputation(did: string): Promise<ReputationScore> {
  const res = await fetch(`${API_BASE}/reputation/${encodeURIComponent(did)}`);
  if (!res.ok) throw new Error("Failed to get reputation");
  return res.json();
}

// ── Agent Ownership ──

export async function listAgents(): Promise<Agent[]> {
  return apiFetch<Agent[]>("/agents");
}

export async function getAgent(id: string): Promise<AgentDetail> {
  return apiFetch<AgentDetail>(`/agents/${id}`);
}

export async function createAgent(body: CreateAgentRequest): Promise<Agent> {
  return apiFetch<Agent>("/agents", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function updateAgent(
  id: string,
  body: UpdateAgentRequest,
): Promise<Agent> {
  return apiFetch<Agent>(`/agents/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function deleteAgent(id: string): Promise<void> {
  await apiFetch<void>(`/agents/${id}`, { method: "DELETE" });
}

export async function getAgentWallet(id: string): Promise<AgentWallet> {
  return apiFetch<AgentWallet>(`/agents/${id}/wallet`);
}

export async function listAgentServices(
  id: string,
): Promise<ServiceListingResponse[]> {
  return apiFetch<ServiceListingResponse[]>(`/agents/${id}/services`);
}

export async function createAgentService(
  id: string,
  body: CreateAgentServiceRequest,
): Promise<ServiceListingResponse> {
  return apiFetch<ServiceListingResponse>(`/agents/${id}/services`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function getAgentReputation(
  id: string,
): Promise<AgentReputationView> {
  return apiFetch<AgentReputationView>(`/agents/${id}/reputation`);
}

export async function getAgentEarnings(id: string): Promise<AgentEarnings> {
  return apiFetch<AgentEarnings>(`/agents/${id}/earnings`);
}

// ─── Merchant gateway (zero-account onboarding) ─────────────────────────

export type MerchantAuthMode =
  | "bearer"
  | "api_key_header"
  | "api_key_query"
  | "basic"
  | "none";

export interface NewMerchantRequest {
  origin_url: string;
  auth_mode: MerchantAuthMode;
  auth_header_name?: string;
  auth_credential?: string;
  price_micro_usdc: number;
  name?: string;
  slug?: string;
  description?: string;
}

export interface MerchantProbeResult {
  ok: boolean;
  status: number | null;
  latency_ms: number | null;
  error: string | null;
}

export interface NewMerchantResponse {
  slug: string;
  service_id: string;
  wallet_address: string;
  gateway_url: string;
  public_url: string;
  dashboard_url: string;
  origin_probe: MerchantProbeResult;
}

export interface MerchantPublicListing {
  slug: string;
  name: string;
  description: string;
  price_micro_usdc: number;
  wallet_address: string | null;
  status: string;
  gateway_url: string;
  total_requests: number;
  total_revenue_micro_usdc: number;
}

export interface MerchantCallLog {
  id: string;
  caller_agent_did: string | null;
  method: string;
  path: string;
  upstream_status: number | null;
  gateway_status: number;
  latency_ms: number;
  amount_charged_micro_usdc: number;
  payment_status: string;
  error_reason: string | null;
  created_at: string;
}

export interface MerchantDailyEarnings {
  day: string;
  micro_usdc: number;
  calls: number;
}

export interface MerchantEarningsSummary {
  total_micro_usdc: number;
  last_24h_micro_usdc: number;
  total_calls: number;
  by_day: MerchantDailyEarnings[];
}

export interface MerchantTestCallResponse {
  status: number;
  latency_ms: number;
  trace_id: string | null;
  error: string | null;
}

export async function createMerchant(
  body: NewMerchantRequest,
): Promise<NewMerchantResponse> {
  return apiFetch<NewMerchantResponse>("/m/new", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function getMerchantListing(
  slug: string,
): Promise<MerchantPublicListing> {
  return apiFetch<MerchantPublicListing>(`/m/${slug}`);
}

export async function getMerchantLogs(
  slug: string,
  limit = 100,
): Promise<MerchantCallLog[]> {
  return apiFetch<MerchantCallLog[]>(`/m/${slug}/logs?limit=${limit}`);
}

export async function getMerchantEarnings(
  slug: string,
): Promise<MerchantEarningsSummary> {
  return apiFetch<MerchantEarningsSummary>(`/m/${slug}/earnings`);
}

export async function runMerchantTestCall(
  slug: string,
): Promise<MerchantTestCallResponse> {
  return apiFetch<MerchantTestCallResponse>(`/m/${slug}/test-call`, {
    method: "POST",
  });
}

export async function killMerchant(slug: string): Promise<void> {
  return apiFetch<void>(`/m/${slug}`, { method: "DELETE" });
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
