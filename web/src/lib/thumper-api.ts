import type {
  ThumperAuthResponse,
  ThumperUserProfile,
  ThumperUsageResponse,
  ThumperTaskResponse,
  ThumperCallResponse,
  ThumperEmailResponse,
  ThumperLlmConfigResponse,
  ThumperProviderInfo,
  ThumperTemplateResponse,
  ThumperBillingStatusResponse,
  ThumperTelegramLinkCode,
  ThumperTelegramStatus,
} from "./thumper-types";

const THUMPER_API_BASE =
  process.env.NEXT_PUBLIC_THUMPER_API_URL || "http://localhost:3000";

function getThumperToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("thumper_token");
}

export function setThumperToken(token: string) {
  localStorage.setItem("thumper_token", token);
}

export function clearThumperToken() {
  localStorage.removeItem("thumper_token");
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
    throw new Error(body.error || `API error ${res.status}`);
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

// Google Sign-In

export async function thumperGoogleSignIn(
  idToken: string
): Promise<ThumperAuthResponse> {
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
