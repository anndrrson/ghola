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
