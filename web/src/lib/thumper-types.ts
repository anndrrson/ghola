export interface ThumperAuthResponse {
  token: string;
  user: {
    id: string;
    email: string;
    name?: string;
  };
}

export interface ThumperUserProfile {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  timezone: string | null;
  tier: string;
  created_at: string;
}

export interface ThumperUsageResponse {
  calls_used: number;
  calls_limit: number;
  emails_used: number;
  emails_limit: number;
  period_start: string;
  period_end: string;
}

export interface ThumperTaskResponse {
  id: string;
  user_id: string;
  template_id: string | null;
  task_type: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
  params: Record<string, unknown>;
  result: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  steps?: ThumperTaskStepResponse[];
}

export interface ThumperTaskStepResponse {
  id: string;
  task_id: string;
  step_number: number;
  action: string;
  status: string;
  result: Record<string, unknown> | null;
  created_at: string;
}

export interface ThumperCallResponse {
  id: string;
  task_id: string;
  phone_number: string;
  objective: string;
  status: "ready" | "calling" | "completed" | "failed";
  transcript: string | null;
  duration_seconds: number | null;
  created_at: string;
}

export interface ThumperEmailResponse {
  id: string;
  task_id: string | null;
  action: "draft" | "send";
  to_address: string;
  subject: string;
  body: string;
  status: "draft" | "sending" | "sent" | "failed";
  sent_at: string | null;
  created_at: string;
}

export interface ThumperLlmConfigResponse {
  provider: string | null;
  model: string | null;
  has_api_key: boolean;
  base_url: string | null;
}

export interface ThumperProviderInfo {
  id: string;
  name: string;
  models: string[];
  requires_base_url: boolean;
}

export interface ThumperTemplateResponse {
  id: string;
  name: string;
  description: string;
  task_type: string;
  params_schema: Record<string, unknown>;
}

export interface ThumperBillingStatusResponse {
  tier: "free" | "pro" | "unlimited";
  stripe_customer_id: string | null;
  expires_at: string | null;
  limits: {
    calls_per_month: number;
    emails_per_month: number;
  };
}

export interface ThumperTelegramLinkCode {
  code: string;
  expires_at: string;
  bot_username: string;
}

export interface ThumperTelegramStatus {
  linked: boolean;
  telegram_username?: string;
  linked_at?: string;
}

export interface ThumperChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  action?: ThumperInlineAction;
}

export interface ThumperInlineAction {
  type: "call" | "email" | "task";
  status: "ready" | "in_progress" | "completed" | "failed";
  data: Record<string, unknown>;
}

export interface ThumperSession {
  id: string;
  title: string;
  lastMessage: string;
  lastMessageAt: string;
  messages: ThumperChatMessage[];
}

export interface ThumperApiKeyCreate {
  name?: string;
  scopes?: string[];
}

export interface ThumperApiKeyCreateResponse {
  id: string;
  key: string;
  key_prefix: string;
  name: string;
  scopes: string[];
  created_at: string;
}

export interface ThumperApiKeyInfo {
  id: string;
  key_prefix: string;
  name: string;
  scopes: string[];
  rate_limit_per_min: number | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface ThumperApiUsageResponse {
  call_count: number;
  call_minutes: number;
  email_count: number;
  call_limit: number;
  email_limit: number;
  api_call_count: number;
  api_call_limit: number;
  api_token_count: number;
}

export interface ComputeProviderInfo {
  id: string;
  user_id: string;
  relay_pubkey: string;
  display_name: string;
  models: { model_id: string; price_per_1k_input: number; price_per_1k_output: number }[];
  vram_mb: number;
  max_concurrent: number;
  status: string;
  total_requests: number;
  total_tokens_served: number;
  total_earned_usdc: number;
  success_rate: number;
  avg_latency_ms: number;
  reputation_score: number;
  last_heartbeat_at: string | null;
  created_at: string;
}

export interface ComputeDailyStats {
  stat_date: string;
  requests_total: number;
  requests_success: number;
  requests_failed: number;
  tokens_served: number;
  earned_usdc: number;
  avg_latency_ms: number;
}

export interface ComputeRecentJob {
  id: string;
  model_id: string;
  status: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number | null;
  created_at: string;
}
