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
  status: "pending" | "in_progress" | "completed" | "failed" | "cancelled" | "awaiting_approval";
  params: Record<string, unknown>;
  result: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
  bounty_usdc?: number | null;
  bounty_status?: string | null;
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
  wallet_address?: string;
  status: string;
  total_requests: number;
  total_tokens_served: number;
  total_earned_usdc: number;
  total_withdrawn_usdc: number;
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

export interface PayoutSummary {
  total_earned_usdc: number;
  total_withdrawn_usdc: number;
  available_usdc: number;
  min_withdrawal_usdc: number;
}

export interface PayoutInfo {
  id: string;
  amount_usdc: number;
  to_address: string;
  signature: string | null;
  status: string;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface PayoutsResponse {
  summary: PayoutSummary;
  payouts: PayoutInfo[];
}

export interface WithdrawalResponse {
  payout_id: string;
  amount_usdc: number;
  to_address: string;
  signature: string;
  explorer_url: string;
}

// ── Bounty Marketplace ──

export interface MarketplaceTask {
  id: string;
  task_type: string;
  title: string | null;
  description: string | null;
  status: string;
  params: Record<string, unknown>;
  bounty_usdc: number | null;
  funder_id: string;
  executor_id: string | null;
  claimed_at: string | null;
  claim_expires_at: string | null;
  created_at: string;
  // Identity fields
  funder_name: string | null;
  funder_reputation: number | null;
  funder_verified: boolean | null;
  funder_bounties_funded: number | null;
  min_reputation: number | null;
}

export interface ClaimResponse {
  task_id: string;
  claimed_at: string;
  claim_expires_at: string;
}

export interface TaskBounty {
  id: string;
  task_id: string;
  funder_id: string;
  executor_id: string | null;
  amount_usdc: number;
  platform_fee_bps: number;
  executor_amount: number;
  platform_fee: number;
  status: string;
  created_at: string;
  settled_at: string | null;
}

export interface EarningsResponse {
  earned_usdc: number;
  withdrawn_usdc: number;
  available_usdc: number;
}

export interface BountyWithdrawResponse {
  payout_id: string;
  amount_usdc: number;
  to_address: string;
  signature: string | null;
  status: string;
}

export const BOUNTY_TASK_TYPES = [
  "research",
  "data_collection",
  "content_creation",
  "code_review",
  "testing",
  "translation",
  "design",
  "analysis",
  "call",
  "email",
  "other",
] as const;
