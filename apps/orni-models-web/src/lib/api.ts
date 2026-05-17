const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080/api";

function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("orni_token");
}

function setToken(token: string) {
  localStorage.setItem("orni_token", token);
}

export function clearToken() {
  localStorage.removeItem("orni_token");
}

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
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
    const body = await res.json().catch(() => ({ error: `API error ${res.status}` }));
    throw new Error(body.error || `API error ${res.status}`);
  }
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text);
}

// Server-side fetch (no localStorage dependency)
export async function serverFetch<T>(path: string): Promise<T> {
  const res = await fetch(
    `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080/api"}${path}`,
    { next: { revalidate: 60 } }
  );
  if (!res.ok) throw new Error(`API error ${res.status}`);
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text);
}

// ── Auth ──

export async function getNonce(wallet: string) {
  return apiFetch<{ nonce: string; message: string }>("/auth/nonce", {
    method: "POST",
    body: JSON.stringify({ wallet_address: wallet }),
  });
}

export async function verifySignature(wallet: string, signature: string, nonce: string) {
  const res = await apiFetch<{ token: string; user: { id: string; is_creator: boolean } }>(
    "/auth/verify",
    {
      method: "POST",
      body: JSON.stringify({ wallet_address: wallet, signature, nonce }),
    }
  );
  setToken(res.token);
  return { token: res.token, is_creator: res.user.is_creator };
}

export async function registerEmail(email: string, password: string, displayName?: string) {
  const res = await apiFetch<{ token: string; user: { id: string; is_creator: boolean } }>(
    "/auth/register",
    {
      method: "POST",
      body: JSON.stringify({ email, password, display_name: displayName }),
    }
  );
  setToken(res.token);
  return { token: res.token, is_creator: res.user.is_creator };
}

export async function loginEmail(email: string, password: string) {
  const res = await apiFetch<{ token: string; user: { id: string; is_creator: boolean } }>(
    "/auth/login",
    {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }
  );
  setToken(res.token);
  return { token: res.token, is_creator: res.user.is_creator };
}

// ── Models ──

export interface Model {
  id: string;
  slug: string;
  name: string;
  description?: string;
  avatar_url?: string;
  creator_name?: string;
  creator_wallet?: string;
  creator_slug?: string;
  system_prompt?: string;
  price_per_query: number;
  category?: string;
  tags?: string[];
  total_queries: number;
  free_queries_per_day?: number;
  is_featured?: boolean;
  avg_rating: number;
  review_count: number;
  status: string;
  created_at: string;
}

export interface ModelsResponse {
  models: Model[];
  total: number;
  page: number;
  limit: number;
}

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
  return apiFetch<ModelsResponse>(`/models${qs ? `?${qs}` : ""}`);
}

export async function getModel(slug: string) {
  return apiFetch<Model>(`/models/${slug}`);
}

export async function createModel(data: {
  name: string;
  slug: string;
  description?: string;
  system_prompt: string;
  base_model?: string;
  price_per_query?: number;
  category?: string;
}) {
  return apiFetch<Model>("/models/create", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateModel(id: string, data: Partial<Model>) {
  return apiFetch<Model>(`/models/id/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

// ── Chat (SSE streaming) ──

export function sendMessage(
  slug: string,
  message: string,
  sessionId?: string,
  onSessionId?: (id: string) => void
): ReadableStream<string> {
  const token = getToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  return new ReadableStream<string>({
    async start(controller) {
      try {
        const res = await fetch(`${API_BASE}/chat/${slug}/message`, {
          method: "POST",
          headers,
          body: JSON.stringify({ message, session_id: sessionId || undefined }),
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
        let gotSessionId = false;
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
                // Capture session_id from first chunk via callback
                if (parsed.session_id && !gotSessionId) {
                  gotSessionId = true;
                  onSessionId?.(parsed.session_id);
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

// ── Chat Sessions ──

export interface SessionSummary {
  id: string;
  model_id: string;
  model_name: string;
  model_slug: string;
  last_message?: string;
  message_count: number;
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  id: string;
  session_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: string;
}

export async function getChatSessions() {
  return apiFetch<SessionSummary[]>("/chat/sessions");
}

export async function getSessionMessages(sessionId: string) {
  return apiFetch<ChatMessage[]>(`/chat/sessions/${sessionId}/messages`);
}

// ── Usage Display ──

export interface UsageInfo {
  used: number;
  limit: number;
  is_free: boolean;
}

export async function getModelUsage(slug: string) {
  return apiFetch<UsageInfo>(`/chat/${slug}/usage`);
}

// ── Balance & Payments ──

export interface CurrencyBalance {
  currency: string;
  balance: number;
}

export interface BalanceResponse {
  balances: CurrencyBalance[];
  pending_earnings: number;
}

export async function getBalance() {
  return apiFetch<BalanceResponse>("/balance");
}

export async function submitDeposit(
  txSignature: string,
  amount: number,
  currency?: string,
) {
  return apiFetch<{ id: string; amount: number; currency: string }>("/deposits", {
    method: "POST",
    body: JSON.stringify({
      tx_signature: txSignature,
      amount,
      ...(currency ? { currency } : {}),
    }),
  });
}

export async function requestWithdraw(
  amount: number,
  destinationWallet: string,
  currency?: string,
) {
  return apiFetch<{ status: string; message: string; currency: string }>("/withdraw", {
    method: "POST",
    body: JSON.stringify({
      amount,
      destination_wallet: destinationWallet,
      ...(currency ? { currency } : {}),
    }),
  });
}

export async function createCheckout(pack: string) {
  return apiFetch<{ checkout_url: string; session_id: string }>("/checkout", {
    method: "POST",
    body: JSON.stringify({ pack }),
  });
}

// ── Spending limits (budget caps) ──

export interface BudgetLimits {
  user_id: string;
  daily_cap_micro: number;
  monthly_cap_micro: number;
  total_cap_micro: number | null;
  enabled: boolean;
}

export interface SpendSnapshot {
  day_micro: number;
  month_micro: number;
  total_micro: number;
}

export interface LimitsView {
  budget: BudgetLimits;
  spend: SpendSnapshot;
}

export async function getLimits() {
  return apiFetch<LimitsView>("/limits");
}

export async function updateLimits(req: {
  daily_cap_usd: number;
  monthly_cap_usd: number;
  total_cap_usd?: number | null;
  enabled?: boolean;
}) {
  return apiFetch<BudgetLimits>("/limits", {
    method: "POST",
    body: JSON.stringify({
      daily_cap_usd: req.daily_cap_usd,
      monthly_cap_usd: req.monthly_cap_usd,
      total_cap_usd: req.total_cap_usd ?? null,
      enabled: req.enabled ?? true,
    }),
  });
}

export async function getFeaturedModels() {
  return apiFetch<Model[]>("/models/featured");
}

// ── Creator ──

export interface CreatorStats {
  total_models: number;
  total_queries: number;
  total_revenue: number;
  pending_earnings: number;
}

export async function getCreatorStats() {
  return apiFetch<CreatorStats>("/creator/stats");
}

export async function getCreatorModels() {
  return apiFetch<Model[]>("/creator/models");
}

export async function addContent(
  modelId: string,
  data: { source_type: string; content_text?: string; source_url?: string }
) {
  return apiFetch(`/models/id/${modelId}/content`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function startFineTune(modelId: string) {
  return apiFetch(`/creator/models/${modelId}/fine-tune`, { method: "POST" });
}

export async function publishModel(modelId: string) {
  return apiFetch<Model>(`/creator/models/${modelId}/publish`, { method: "POST" });
}

export async function toggleModelStatus(modelId: string, status: "live" | "paused") {
  return apiFetch<Model>(`/creator/models/${modelId}/status`, {
    method: "PUT",
    body: JSON.stringify({ status }),
  });
}

// ── Earnings ──

export interface DailyEarning {
  date: string;
  amount: number;
}

export interface ModelEarning {
  model_id: string;
  model_name: string;
  model_slug: string;
  total_revenue: number;
  creator_earnings: number;
  query_count: number;
}

export interface EarningsData {
  daily: DailyEarning[];
  per_model: ModelEarning[];
  total_earnings: number;
  total_revenue: number;
}

export async function getCreatorEarnings() {
  return apiFetch<EarningsData>("/creator/earnings");
}

// ── API Keys ──

export interface ApiKeyInfo {
  id: string;
  key_prefix: string;
  name?: string;
  model_id: string;
  model_name?: string;
  model_slug?: string;
  created_at: string;
  last_used_at?: string;
  is_active: boolean;
}

export interface CreateApiKeyResponse {
  id: string;
  key: string;
  key_prefix: string;
  name?: string;
  model_id: string;
  created_at: string;
}

export async function createApiKey(modelId: string, name?: string) {
  return apiFetch<CreateApiKeyResponse>("/keys", {
    method: "POST",
    body: JSON.stringify({ model_id: modelId, name }),
  });
}

export async function listApiKeys() {
  return apiFetch<ApiKeyInfo[]>("/keys");
}

export async function revokeApiKey(id: string) {
  return apiFetch<{ status: string }>(`/keys/${id}`, { method: "DELETE" });
}

// ── Reviews ──

export interface ReviewWithUser {
  id: string;
  rating: number;
  review_text?: string;
  created_at: string;
  user_name?: string;
}

export async function getModelReviews(slug: string) {
  return apiFetch<ReviewWithUser[]>(`/models/${slug}/reviews`);
}

export async function submitReview(slug: string, rating: number, reviewText?: string) {
  return apiFetch(`/models/${slug}/review`, {
    method: "POST",
    body: JSON.stringify({ rating, review_text: reviewText }),
  });
}

// ── Creators ──

export interface CreatorPublicProfile {
  display_name?: string;
  avatar_url?: string;
  slug?: string;
  did?: string;
  said_verified: boolean;
  model_count: number;
  total_queries: number;
  created_at: string;
}

export async function getCreatorProfile(slug: string) {
  return apiFetch<{ profile: CreatorPublicProfile; models: Model[] }>(`/creators/${slug}`);
}

// ── Namespace export for pages that use api.method() ──

export const api = {
  getNonce,
  verifySignature,
  registerEmail,
  loginEmail,
  getModels,
  getModel,
  createModel,
  updateModel,
  sendMessage,
  getBalance,
  submitDeposit,
  requestWithdraw,
  createCheckout,
  getFeaturedModels,
  getCreatorStats,
  getCreatorModels,
  addContent,
  startFineTune,
  publishModel,
  toggleModelStatus,
  getCreatorEarnings,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  getModelReviews,
  submitReview,
  getChatSessions,
  getSessionMessages,
  getModelUsage,
  getCreatorProfile,
  clearToken,
};
