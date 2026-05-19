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

export type ThumperNetworkScope =
  | "auth"
  | "cloudChat"
  | "localServerChat"
  | "callExecution"
  | "emailDraft"
  | "emailSend"
  | "calendarExecution"
  | "walletProvision"
  | "walletTransfer"
  | "smsSend"
  | "nativeMessagingRelay"
  | "agentPlan"
  | "remoteAgentCompute"
  | "swarmExecution"
  | "billing"
  | "commerceExecution"
  | "providerConfig";

export interface ThumperPrivacyApproval {
  privacy_mode: "strictLocal";
  network_scope: ThumperNetworkScope;
  user_approved_at: string;
  approval_nonce: string;
  approval_summary: string;
}

export interface ThumperPrivacyHealthResponse {
  strict_local_default: boolean;
  approval_enforcement_enabled: boolean;
  raw_approval_nonce_hashing_enabled: boolean;
  sms_approval_enabled: boolean;
  task_result_redaction_enabled: boolean;
  task_step_redaction_enabled: boolean;
  call_recipient_hashing_enabled: boolean;
  sms_recipient_hashing_enabled: boolean;
  remote_compute_approval_enabled: boolean;
  messaging_block_report_enabled: boolean;
  private_rail_fail_closed: boolean;
  blocking_reasons: string[];
}

export interface ThumperPrivateRailRecipientResponse {
  configured: boolean;
  ready: boolean;
  provider: string;
  network: string;
  asset: string;
  recipient_configured: boolean;
  recipient_preview?: string | null;
  recipient?: string | null;
  arbitrary_recipient_proofs_enabled?: boolean;
  recipient_receipts_enabled?: boolean;
  rail: string;
  canonical_rail: string;
  fallback_allowed: boolean;
  unavailable_reason?: string | null;
  privacy_disclosure: string;
}

export interface ThumperTaskStepResponse {
  id: string;
  step_number: number;
  action_type: string;
  status: string;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
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
  /**
   * Inline actions surfaced by the assistant for this message. A single turn
   * may emit multiple actions (e.g. "email alice and text bob"). Legacy
   * sessions persisted with the singular `action` field are normalized on
   * load — see `chat-history-store`.
   */
  actions?: ThumperInlineAction[];
  // Per-message cryptographic receipt (assistant messages only).
  // Built after streaming completes; rides inside the same
  // session-vault-encrypted payload as the rest of the message so
  // receipts inherit encryption-at-rest. See lib/receipt.ts.
  receipt?: import("./receipt").ReceiptV1;
}

export interface ThumperInlineAction {
  type: "call" | "email" | "sms" | "calendar" | "task";
  status: "ready" | "in_progress" | "completed" | "failed";
  data: Record<string, unknown>;
}

export interface ThumperSmsResponse {
  id: string;
  to: string;
  body: string;
  status: "sending" | "sent" | "failed";
  sent_at: string | null;
  vendor_message_id: string | null;
}

export interface ThumperCalendarEventResponse {
  action?: string;
  status?: string;
  event?: {
    id: string;
    title: string;
    start: string;
    end: string;
    html_link: string | null;
  };
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

export interface CommerceIntent {
  id: string;
  user_id: string;
  goal: string;
  budget_micro_usdc: number;
  privacy_mode: "private" | "open";
  preferred_rail: string;
  allowed_adapters: string[];
  deadline_at: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface CommerceOffer {
  offer_id: string;
  adapter: "x402" | "mcp";
  title: string;
  description: string;
  provider_slug: string;
  model_id: string;
  tags: string[];
  tools: string[];
  provider_reputation: number;
  amount_micro_usdc: number;
  currency: string;
  rail: string;
  privacy_disclosure: string;
  available: boolean;
  unavailable_reason: string | null;
  raw_offer: Record<string, unknown>;
}

export interface CommerceQuote {
  id: string;
  intent_id: string;
  adapter: "x402" | "mcp";
  offer_id: string;
  provider_slug: string | null;
  provider_label: string | null;
  amount_micro_usdc: number;
  currency: string;
  rail: string;
  status: string;
  payment_requirements: Record<string, unknown>;
  policy: Record<string, unknown>;
  raw_offer: Record<string, unknown>;
  expires_at: string;
  created_at: string;
}

export interface CommerceReceipt {
  id: string;
  execution_id: string;
  status: string;
  adapter: "x402" | "mcp";
  amount_micro_usdc: number;
  currency: string;
  rail: string;
  receipt: Record<string, unknown>;
  created_at: string;
}

export interface CommerceExecution {
  id: string;
  intent_id: string;
  quote_id: string;
  status: string;
  handoff: Record<string, unknown>;
  receipt: CommerceReceipt;
  created_at: string;
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
