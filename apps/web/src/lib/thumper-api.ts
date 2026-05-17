import type {
  ThumperAuthResponse,
  ThumperUserProfile,
  ThumperUsageResponse,
  ThumperTaskResponse,
  ThumperCallResponse,
  ThumperEmailResponse,
  ThumperSmsResponse,
  ThumperCalendarEventResponse,
  ThumperLlmConfigResponse,
  ThumperProviderInfo,
  ThumperTemplateResponse,
  ThumperBillingStatusResponse,
  ThumperTelegramLinkCode,
  ThumperTelegramStatus,
  ComputeProviderInfo,
  ComputeDailyStats,
  ComputeRecentJob,
} from "./thumper-types";

const THUMPER_API_BASE =
  process.env.NEXT_PUBLIC_THUMPER_API_URL || "http://localhost:3000";

function safeGetLocalStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetLocalStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Best-effort only. If storage is unavailable, auth continues via
    // in-memory state for this tab.
  }
}

function safeRemoveLocalStorage(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Best-effort only.
  }
}

function getThumperToken(): string | null {
  if (typeof window === "undefined") return null;
  return safeGetLocalStorage("thumper_token");
}

export function setThumperToken(token: string) {
  safeSetLocalStorage("thumper_token", token);
}

export function clearThumperToken() {
  safeRemoveLocalStorage("thumper_token");
}

export function thumperLogout() {
  const token = getThumperToken();
  if (token) {
    fetch(`${THUMPER_API_BASE}/api/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }
  clearThumperToken();
}

async function thumperFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getThumperToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) || {}),
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const res = await fetch(`${THUMPER_API_BASE}${path}`, {
    ...options,
    headers,
  });
  if (!res.ok) {
    const body = await res
      .json()
      .catch(() => ({ error: `API error ${res.status}` }));
    const err = new Error(body.error || `API error ${res.status}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text);
}

// Auth

export async function thumperSignUp(data: {
  name: string;
  email: string;
  password: string;
}): Promise<ThumperAuthResponse> {
  const res = await thumperFetch<ThumperAuthResponse>(
    "/api/auth/email/signup",
    {
      method: "POST",
      body: JSON.stringify(data),
    }
  );
  setThumperToken(res.token);
  return res;
}

export async function thumperSignIn(data: {
  email: string;
  password: string;
}): Promise<ThumperAuthResponse> {
  const res = await thumperFetch<ThumperAuthResponse>(
    "/api/auth/email/signin",
    {
      method: "POST",
      body: JSON.stringify(data),
    }
  );
  setThumperToken(res.token);
  return res;
}

// User Profile

export async function getUserProfile(): Promise<ThumperUserProfile> {
  return thumperFetch<ThumperUserProfile>("/api/user/profile");
}

export async function updateUserProfile(
  data: Partial<ThumperUserProfile>
): Promise<ThumperUserProfile> {
  return thumperFetch<ThumperUserProfile>("/api/user/profile", {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function getUsage(): Promise<ThumperUsageResponse> {
  return thumperFetch<ThumperUsageResponse>("/api/user/usage");
}

// Tasks

export async function createTask(data: {
  template_id?: string;
  task_type: string;
  params: Record<string, unknown>;
}): Promise<ThumperTaskResponse> {
  return thumperFetch<ThumperTaskResponse>("/api/tasks", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function listTasks(): Promise<ThumperTaskResponse[]> {
  return thumperFetch<ThumperTaskResponse[]>("/api/tasks");
}

export async function getTask(id: string): Promise<ThumperTaskResponse> {
  return thumperFetch<ThumperTaskResponse>(`/api/tasks/${id}`);
}

export async function cancelTask(id: string): Promise<void> {
  await thumperFetch(`/api/tasks/${id}/cancel`, { method: "POST" });
}

// Calls

export async function initiateCall(data: {
  phone_number: string;
  objective: string;
}): Promise<ThumperCallResponse> {
  return thumperFetch<ThumperCallResponse>("/api/calls", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

// Emails

export async function generateEmail(data: {
  to: string;
  objective: string;
}): Promise<ThumperEmailResponse> {
  return thumperFetch<ThumperEmailResponse>("/api/emails/generate", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function sendEmail(data: {
  to: string;
  subject: string;
  body: string;
}): Promise<ThumperEmailResponse> {
  return thumperFetch<ThumperEmailResponse>("/api/emails/send", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function listEmails(): Promise<ThumperEmailResponse[]> {
  return thumperFetch<ThumperEmailResponse[]>("/api/emails");
}

// SMS

export async function sendSms(data: {
  to: string;
  body: string;
}): Promise<ThumperSmsResponse> {
  return thumperFetch<ThumperSmsResponse>("/api/sms/send", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

// Calendar

export async function createCalendarEvent(data: {
  title: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
  timezone?: string;
}): Promise<ThumperCalendarEventResponse> {
  return thumperFetch<ThumperCalendarEventResponse>("/api/calendar/events", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

// LLM Config (BYOM)

export async function getLlmConfig(): Promise<ThumperLlmConfigResponse> {
  return thumperFetch<ThumperLlmConfigResponse>("/api/llm/config");
}

export async function updateLlmConfig(data: {
  provider: string;
  model: string;
  api_key?: string;
  base_url?: string;
}): Promise<ThumperLlmConfigResponse> {
  return thumperFetch<ThumperLlmConfigResponse>("/api/llm/config", {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function listProviders(): Promise<ThumperProviderInfo[]> {
  return thumperFetch<ThumperProviderInfo[]>("/api/llm/providers");
}

// Billing

export async function createThumperCheckout(
  tier: string
): Promise<{ checkout_url: string }> {
  return thumperFetch<{ checkout_url: string }>("/api/billing/checkout", {
    method: "POST",
    body: JSON.stringify({ tier }),
  });
}

export async function getThumperBillingStatus(): Promise<ThumperBillingStatusResponse> {
  return thumperFetch<ThumperBillingStatusResponse>("/api/billing/status");
}

// Telegram

export async function createTelegramLinkCode(): Promise<ThumperTelegramLinkCode> {
  return thumperFetch<ThumperTelegramLinkCode>("/api/telegram/link-code", {
    method: "POST",
  });
}

export async function getTelegramLinkStatus(): Promise<ThumperTelegramStatus> {
  return thumperFetch<ThumperTelegramStatus>("/api/telegram/status");
}

export async function unlinkTelegram(): Promise<void> {
  await thumperFetch("/api/telegram/unlink", { method: "DELETE" });
}

// Twitter Sign-In (token comes from OAuth callback redirect)

export function handleTwitterToken(token: string): ThumperAuthResponse {
  setThumperToken(token);
  const payload = JSON.parse(atob(token.split(".")[1]));
  return {
    token,
    user: {
      id: payload.sub || payload.user_id,
      email: payload.email,
      name: payload.name,
    },
  };
}

/**
 * Newer Twitter exchange flow: the server-side `/api/auth/twitter/exchange`
 * endpoint sets the session cookie itself, then returns the user object
 * directly. We don't see (or store) a JWT here — auth is cookie-backed.
 * The chat page calls this to wrap the response in the same shape every
 * other auth path produces, so the rest of the app doesn't branch on
 * which sign-in flow was used.
 */
export function handleTwitterSession(user: {
  id: string;
  email: string;
  name?: string;
}): { user: { id: string; email: string; name?: string } } {
  return { user };
}

// Google Sign-In

export async function thumperGoogleSignIn(
  idToken: string
): Promise<ThumperAuthResponse> {
  try {
    const res = await thumperFetch<{
      token: string;
      user_id: string;
      is_new_user: boolean;
    }>("/api/auth/google", {
      method: "POST",
      body: JSON.stringify({ id_token: idToken }),
    });
    setThumperToken(res.token);
    // Parse JWT for user info
    const payload = JSON.parse(atob(res.token.split(".")[1]));
    return {
      token: res.token,
      user: {
        id: payload.sub || payload.user_id,
        email: payload.email,
        name: payload.name,
      },
    };
  } catch (err) {
    const status = (err as Error & { status?: number }).status;
    if (status === 503) {
      throw new Error(
        "Google sign-in is temporarily unavailable. Please use email instead."
      );
    }
    if (status === 401) {
      throw new Error(
        "Google sign-in failed. Please try again or use email."
      );
    }
    throw err;
  }
}

// Accounts (Gmail OAuth)

export async function getGmailAuthorizeUrl(): Promise<{ authorize_url: string }> {
  return thumperFetch<{ authorize_url: string }>("/api/accounts/authorize/gmail");
}

export async function getAccountsStatus(): Promise<
  { provider: string; connected: boolean; connected_at: string | null }[]
> {
  return thumperFetch("/api/accounts/status");
}

// Templates

export async function listTemplates(): Promise<ThumperTemplateResponse[]> {
  return thumperFetch<ThumperTemplateResponse[]>("/api/templates");
}

// API Keys (Developer Platform)

export async function createApiKey(data: {
  name?: string;
  scopes?: string[];
}): Promise<import("./thumper-types").ThumperApiKeyCreateResponse> {
  return thumperFetch("/api/keys", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function listApiKeys(): Promise<
  import("./thumper-types").ThumperApiKeyInfo[]
> {
  return thumperFetch("/api/keys");
}

export async function revokeApiKey(id: string): Promise<void> {
  await thumperFetch(`/api/keys/${id}`, { method: "DELETE" });
}

export async function getApiUsage(): Promise<
  import("./thumper-types").ThumperApiUsageResponse
> {
  return thumperFetch("/api/user/usage");
}

// Compute (GPU Marketplace)

export async function createProviderKey(): Promise<import("./thumper-types").ThumperApiKeyCreateResponse> {
  return thumperFetch("/api/auth/provider-key", { method: "POST" });
}

export async function getComputeProviders(): Promise<ComputeProviderInfo[]> {
  return thumperFetch("/api/compute/providers");
}

export async function getComputeModels(): Promise<{
  models: { model_id: string; provider_count: number; min_price_input: number; min_price_output: number }[];
}> {
  return thumperFetch("/api/compute/models");
}

export async function getMyProvider(): Promise<ComputeProviderInfo | null> {
  try {
    return await thumperFetch("/api/compute/providers/me");
  } catch (err) {
    if ((err as Error & { status?: number }).status === 404) return null;
    throw err;
  }
}

export async function getComputeStats(days?: number): Promise<ComputeDailyStats[]> {
  const params = days ? `?days=${days}` : "";
  return thumperFetch(`/api/compute/stats${params}`);
}

export async function getRecentJobs(limit?: number): Promise<ComputeRecentJob[]> {
  const params = limit ? `?limit=${limit}` : "";
  return thumperFetch(`/api/compute/jobs${params}`);
}

export async function withdrawProviderEarnings(amount_usdc?: number): Promise<import("./thumper-types").WithdrawalResponse> {
  return thumperFetch("/api/compute/providers/me/withdraw", {
    method: "POST",
    body: JSON.stringify(amount_usdc != null ? { amount_usdc } : {}),
  });
}

export async function getProviderPayouts(limit?: number): Promise<import("./thumper-types").PayoutsResponse> {
  const params = limit ? `?limit=${limit}` : "";
  return thumperFetch(`/api/compute/providers/me/payouts${params}`);
}

// ── Bounty Marketplace ──

import type {
  MarketplaceTask,
  ClaimResponse,
  TaskBounty,
  EarningsResponse,
  BountyWithdrawResponse,
} from "./thumper-types";

export async function browseMarketplace(params?: {
  task_type?: string;
  min_bounty?: number;
  max_bounty?: number;
  sort?: string;
  limit?: number;
  offset?: number;
}): Promise<MarketplaceTask[]> {
  const sp = new URLSearchParams();
  if (params?.task_type) sp.set("task_type", params.task_type);
  if (params?.min_bounty != null) sp.set("min_bounty", String(params.min_bounty));
  if (params?.max_bounty != null) sp.set("max_bounty", String(params.max_bounty));
  if (params?.sort) sp.set("sort", params.sort);
  if (params?.limit) sp.set("limit", String(params.limit));
  if (params?.offset) sp.set("offset", String(params.offset));
  const qs = sp.toString();
  return thumperFetch<MarketplaceTask[]>(`/api/marketplace${qs ? `?${qs}` : ""}`);
}

export async function getMarketplaceTask(id: string): Promise<MarketplaceTask> {
  return thumperFetch<MarketplaceTask>(`/api/marketplace/${id}`);
}

export async function claimTask(taskId: string): Promise<ClaimResponse> {
  return thumperFetch<ClaimResponse>(`/api/marketplace/${taskId}/claim`, { method: "POST" });
}

export async function submitTask(
  taskId: string,
  result: unknown,
): Promise<{ task_id: string; status: string }> {
  return thumperFetch(`/api/marketplace/${taskId}/submit`, {
    method: "POST",
    body: JSON.stringify({ result }),
  });
}

export async function unclaimTask(
  taskId: string,
): Promise<{ task_id: string; status: string; message: string }> {
  return thumperFetch(`/api/marketplace/${taskId}/unclaim`, { method: "POST" });
}

export async function createBountyTask(data: {
  title: string;
  description: string;
  task_type: string;
  bounty_usdc: number;
  params?: Record<string, unknown>;
  min_reputation?: number;
}): Promise<ThumperTaskResponse> {
  return thumperFetch("/api/tasks", {
    method: "POST",
    body: JSON.stringify({
      ...data,
      params: data.params || {},
      is_open: true,
    }),
  });
}

export async function releaseTask(
  taskId: string,
): Promise<{
  task_id: string;
  status: string;
  executor_id: string;
  executor_amount: number;
  platform_fee: number;
}> {
  return thumperFetch(`/api/marketplace/${taskId}/release`, { method: "POST" });
}

export async function rejectTask(
  taskId: string,
  reason?: string,
): Promise<{ task_id: string; status: string; message: string }> {
  return thumperFetch(`/api/marketplace/${taskId}/reject`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

export async function listBounties(params?: {
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<TaskBounty[]> {
  const sp = new URLSearchParams();
  if (params?.status) sp.set("status", params.status);
  if (params?.limit) sp.set("limit", String(params.limit));
  if (params?.offset) sp.set("offset", String(params.offset));
  const qs = sp.toString();
  return thumperFetch<TaskBounty[]>(`/api/bounties${qs ? `?${qs}` : ""}`);
}

export async function getEarnings(): Promise<EarningsResponse> {
  return thumperFetch<EarningsResponse>("/api/wallet/earnings");
}

export async function withdrawEarnings(data: {
  to_address: string;
  amount_usdc?: number;
}): Promise<BountyWithdrawResponse> {
  return thumperFetch<BountyWithdrawResponse>("/api/wallet/withdraw-earnings", {
    method: "POST",
    body: JSON.stringify(data),
  });
}
