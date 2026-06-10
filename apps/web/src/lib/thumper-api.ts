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
  ThumperNetworkScope,
  ThumperPrivacyApproval,
  ThumperPrivacyHealthResponse,
  ThumperPrivateRailRecipientResponse,
  ThumperTemplateResponse,
  ThumperBillingStatusResponse,
  ThumperTelegramLinkCode,
  ThumperTelegramStatus,
  ComputeProviderInfo,
  ComputeDailyStats,
  ComputeRecentJob,
  CommerceExecution,
  CommerceIntent,
  CommerceOffer,
  CommerceQuote,
  CommerceReceipt,
  CommerceReceiptExport,
} from "./thumper-types";

function thumperApiBase() {
  return typeof window === "undefined"
    ? process.env.NEXT_PUBLIC_THUMPER_API_URL || "https://thumper-cloud.onrender.com"
    : process.env.NEXT_PUBLIC_THUMPER_API_URL || "";
}

function thumperFetchUrl(path: string) {
  // Cookie-backed session routes live in this Next app. They must remain
  // same-origin even when production has a public upstream API URL configured.
  if (path.startsWith("/api/auth/session/")) return path;
  return `${thumperApiBase()}${path}`;
}

function publicErrorMessage(path: string, status: number, rawError?: string) {
  const fallback = `API error ${status}`;
  const safeRawError = rawError && rawError !== fallback ? rawError : "";

  if (!path.startsWith("/api/auth/session/")) {
    return safeRawError || fallback;
  }

  if (status === 401) return safeRawError || "Email or password is incorrect.";
  if (status === 403) return "Sign in is temporarily unavailable. Please refresh and try again.";
  if (status === 404) return "Sign in is temporarily unavailable. Please refresh and try again.";
  if (status >= 500) return "Sign in is temporarily unavailable. Please try again in a moment.";
  return safeRawError || "Sign in failed. Please try again.";
}

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

function approvalNonce(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `approval-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createPrivacyApproval(
  network_scope: ThumperNetworkScope,
  approval_summary: string
): ThumperPrivacyApproval {
  return {
    privacy_mode: "strictLocal",
    network_scope,
    user_approved_at: new Date().toISOString(),
    approval_nonce: approvalNonce(),
    approval_summary,
  };
}

function taskScope(taskType: string, params: Record<string, unknown>): ThumperNetworkScope {
  if (
    [
      "call",
      "customer_service",
      "cancel_service",
      "request_refund",
      "complaint",
      "cancel_subscription",
    ].includes(taskType)
  ) {
    return "callExecution";
  }
  if (taskType === "email" || taskType === "follow_up") return "emailDraft";
  if (taskType === "calendar") return "calendarExecution";
  if (
    taskType === "crypto_transfer" ||
    taskType === "send_crypto" ||
    (taskType === "crypto" && params.action === "transfer")
  ) {
    return "walletTransfer";
  }
  return "auth";
}

function getThumperToken(): string | null {
  if (typeof window === "undefined") return null;
  return safeGetLocalStorage("thumper_token");
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const [, payload] = token.split(".");
    if (!payload) return null;
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function userFromAuthToken(
  token: string,
  fallbackEmail?: string,
  fallbackName?: string
): ThumperAuthResponse["user"] {
  const payload = decodeJwtPayload(token);
  const id = payload?.sub || payload?.user_id;
  const email = payload?.email || fallbackEmail;
  const name = payload?.name || fallbackName;
  if (typeof id !== "string" || typeof email !== "string" || !email) {
    throw new Error("Auth response was missing user details.");
  }
  return {
    id,
    email,
    ...(typeof name === "string" && name ? { name } : {}),
  };
}

export function setThumperToken(token: string) {
  safeSetLocalStorage("thumper_token", token);
}

export function clearThumperToken() {
  safeRemoveLocalStorage("thumper_token");
}

export function thumperLogout() {
  const token = getThumperToken();
  if (typeof window !== "undefined") {
    fetch("/api/auth/session/logout", {
      method: "POST",
      credentials: "same-origin",
    }).catch(() => {});
  } else if (token) {
    fetch(`${thumperApiBase()}/api/auth/logout`, {
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
  const res = await fetch(thumperFetchUrl(path), {
    ...options,
    headers,
    credentials: options.credentials ?? "same-origin",
  });
  if (!res.ok) {
    const body = await res
      .json()
      .catch(() => ({ error: `API error ${res.status}` }));
    const err = new Error(
      publicErrorMessage(path, res.status, body.error),
    ) as Error & { status: number; path?: string };
    err.status = res.status;
    err.path = path;
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
  const res = await thumperFetch<{ user: ThumperAuthResponse["user"] }>(
    "/api/auth/session/email/signup",
    {
      method: "POST",
      body: JSON.stringify({
        email: data.email,
        password: data.password,
        display_name: data.name,
      }),
    },
  );
  clearThumperToken();
  return { user: res.user };
}

export async function thumperSignIn(data: {
  email: string;
  password: string;
}): Promise<ThumperAuthResponse> {
  const res = await thumperFetch<{ user: ThumperAuthResponse["user"] }>(
    "/api/auth/session/email/signin",
    {
      method: "POST",
      body: JSON.stringify(data),
    },
  );
  clearThumperToken();
  return { user: res.user };
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
  approval?: ThumperPrivacyApproval;
}): Promise<ThumperTaskResponse> {
  const { approval: providedApproval, ...taskData } = data;
  const scope = taskScope(data.task_type, data.params);
  const approval =
    providedApproval ??
    (scope === "auth"
      ? undefined
      : createPrivacyApproval(scope, `User approved ${data.task_type} network execution.`));
  return thumperFetch<ThumperTaskResponse>("/api/tasks", {
    method: "POST",
    body: JSON.stringify({ ...taskData, ...(approval ?? {}) }),
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
  const approval = createPrivacyApproval(
    "callExecution",
    "User approved a phone call through Ghola Cloud and the calling provider."
  );
  return thumperFetch<ThumperCallResponse>("/api/calls", {
    method: "POST",
    body: JSON.stringify({ ...data, ...approval }),
  });
}

// Emails

export async function generateEmail(data: {
  to: string;
  objective: string;
}): Promise<ThumperEmailResponse> {
  const approval = createPrivacyApproval(
    "emailDraft",
    "User approved email draft generation through Ghola Cloud and the configured model provider."
  );
  return thumperFetch<ThumperEmailResponse>("/api/emails/generate", {
    method: "POST",
    body: JSON.stringify({ ...data, ...approval }),
  });
}

export async function sendEmail(data: {
  to: string;
  subject: string;
  body: string;
}): Promise<ThumperEmailResponse> {
  const approval = createPrivacyApproval(
    "emailSend",
    "User approved sending this email through Ghola Cloud and Gmail."
  );
  return thumperFetch<ThumperEmailResponse>("/api/emails/send", {
    method: "POST",
    body: JSON.stringify({ ...data, ...approval }),
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
  const approval = createPrivacyApproval(
    "smsSend",
    "User approved sending this SMS through Ghola Cloud and the SMS provider."
  );
  return thumperFetch<ThumperSmsResponse>("/api/sms/send", {
    method: "POST",
    body: JSON.stringify({ ...data, ...approval }),
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
  const approval = createPrivacyApproval(
    "calendarExecution",
    "User approved creating this calendar event through Ghola Cloud and Google Calendar."
  );
  return thumperFetch<ThumperCalendarEventResponse>("/api/calendar/events", {
    method: "POST",
    body: JSON.stringify({ ...data, ...approval }),
  });
}

export async function getPrivacyHealth(): Promise<ThumperPrivacyHealthResponse> {
  return thumperFetch<ThumperPrivacyHealthResponse>("/health/privacy");
}

export async function getPrivateUSDCxRecipient(): Promise<ThumperPrivateRailRecipientResponse> {
  return thumperFetch<ThumperPrivateRailRecipientResponse>("/api/wallet/private/recipient");
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

export async function reservePrivateAgentCompute(input: {
  session_id: string;
  seconds: number;
}): Promise<{ ok: boolean; reservation_id: string; reserved_seconds: number }> {
  return thumperFetch<{ ok: boolean; reservation_id: string; reserved_seconds: number }>(
    "/api/billing/private-agent/compute/reserve",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function releasePrivateAgentCompute(input: {
  session_id: string;
  status: "paused" | "completed" | "failed";
}): Promise<{ ok: boolean }> {
  return thumperFetch<{ ok: boolean }>(
    "/api/billing/private-agent/compute/release",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export type PrivateBalanceDeposit = {
  id: string;
  amount_usdc: number;
  status: string;
  source: string;
  stripe_session_id: string | null;
  created_at: string;
  paid_at: string | null;
  shielded_at: string | null;
};

export type PrivateBalanceStatusResponse = {
  available_micro_usdc: number;
  paid_micro_usdc: number;
  shielded_micro_usdc: number;
  pending_micro_usdc: number;
  deposits: PrivateBalanceDeposit[];
};

export async function createPrivateBalanceTopUp(
  amountUsdc: number
): Promise<{ deposit_id: string; checkout_url: string }> {
  return thumperFetch<{ deposit_id: string; checkout_url: string }>(
    "/api/billing/private-balance/checkout",
    {
      method: "POST",
      body: JSON.stringify({ amount_usdc: amountUsdc }),
    }
  );
}

export async function getPrivateBalanceStatus(): Promise<PrivateBalanceStatusResponse> {
  return thumperFetch<PrivateBalanceStatusResponse>("/api/billing/private-balance");
}

// Commerce intents

export async function createCommerceIntent(data: {
  goal: string;
  budget_micro_usdc?: number;
  privacy_mode?: "private" | "open";
  preferred_rail?: string;
  allowed_adapters?: string[];
  deadline_at?: string | null;
}): Promise<CommerceIntent> {
  return thumperFetch<CommerceIntent>("/api/commerce/intents", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function getCommerceIntent(id: string): Promise<CommerceIntent> {
  return thumperFetch<CommerceIntent>(`/api/commerce/intents/${id}`);
}

export async function listCommerceOffers(intentId: string): Promise<CommerceOffer[]> {
  return thumperFetch<CommerceOffer[]>(`/api/commerce/intents/${intentId}/offers`);
}

export async function createCommerceQuote(
  intentId: string,
  data: { offer_id: string; rail?: string }
): Promise<CommerceQuote> {
  return thumperFetch<CommerceQuote>(`/api/commerce/intents/${intentId}/quote`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function executeCommerceQuote(
  intentId: string,
  data: {
    quote_id: string;
    privacy_mode: "strictLocal";
    network_scope: "commerceExecution";
    user_approved_at: string;
    approval_nonce: string;
    approval_summary: string;
  }
): Promise<CommerceExecution> {
  return thumperFetch<CommerceExecution>(`/api/commerce/intents/${intentId}/execute`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function getCommerceExecution(id: string): Promise<CommerceExecution> {
  return thumperFetch<CommerceExecution>(`/api/commerce/executions/${id}`);
}

export async function getCommerceReceipt(id: string): Promise<CommerceReceipt> {
  return thumperFetch<CommerceReceipt>(`/api/commerce/receipts/${id}`);
}

export async function exportCommerceReceipt(
  id: string,
  data: {
    reason?: string;
    audience?: string;
    privacy_mode: "strictLocal";
    network_scope: "commerceExecution";
    user_approved_at: string;
    approval_nonce: string;
    approval_summary: string;
  }
): Promise<CommerceReceiptExport> {
  return thumperFetch<CommerceReceiptExport>(`/api/commerce/receipts/${id}/export`, {
    method: "POST",
    body: JSON.stringify(data),
  });
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
  return {
    token,
    user: userFromAuthToken(token),
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
      user: ThumperAuthResponse["user"];
    }>("/api/auth/session/google", {
      method: "POST",
      body: JSON.stringify({ id_token: idToken }),
    });
    clearThumperToken();
    return { user: res.user };
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
  const params = data.params || {};
  const scope = taskScope(data.task_type, params);
  const approval =
    scope === "auth"
      ? undefined
      : createPrivacyApproval(scope, `User approved posting a ${data.task_type} task.`);
  return thumperFetch("/api/tasks", {
    method: "POST",
    body: JSON.stringify({
      ...data,
      params,
      is_open: true,
      ...(approval ?? {}),
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
