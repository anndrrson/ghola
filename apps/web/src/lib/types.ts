export interface User {
  id: string;
  email: string;
}

export interface BusinessProfile {
  did: string;
  business_name: string;
  handle: string | null;
  category: string;
  description: string;
  logo_url: string | null;
  website: string;
  verified_domain: string | null;
  verified_at: string | null;
  operating_hours: Record<string, string> | null;
  location: BusinessLocation | null;
  contact: BusinessContact | null;
  services: ServiceDefinition[];
  policies: PolicyDefinition[];
  api_endpoints: ApiEndpoint[];
  payment_methods: string[];
  created_at: string;
  updated_at: string;
}

export interface BusinessLocation {
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  postal_code?: string;
  latitude?: number;
  longitude?: number;
}

export interface BusinessContact {
  email?: string;
  phone?: string;
  support_url?: string;
}

export interface ServiceDefinition {
  name: string;
  description: string;
  price?: string;
  availability?: string;
  booking_url?: string;
  api_endpoint?: string;
  parameters: Record<string, unknown>;
  skill_url?: string;
}

export interface ApiEndpoint {
  name: string;
  url: string;
  method: string;
  auth_type: string;
  description: string;
  request_schema: Record<string, unknown>;
  response_schema: Record<string, unknown>;
}

export interface PolicyDefinition {
  name: string;
  content: string;
  machine_readable: Record<string, unknown>;
}

export interface AnalyticsSummary {
  profile_views: number;
  resolve_count: number;
  total_api_calls: number;
}

export interface DomainVerification {
  method: string;
  instructions: string;
  token: string;
}

export const BUSINESS_CATEGORIES = [
  { value: "restaurant", label: "Restaurant" },
  { value: "hotel", label: "Hotel & Hospitality" },
  { value: "retail", label: "Retail & E-Commerce" },
  { value: "saas", label: "SaaS & Software" },
  { value: "healthcare", label: "Healthcare" },
  { value: "finance", label: "Finance" },
  { value: "education", label: "Education" },
  { value: "entertainment", label: "Entertainment" },
  { value: "service", label: "Professional Service" },
  { value: "government", label: "Government" },
  { value: "nonprofit", label: "Nonprofit" },
] as const;

export interface PublicProfile {
  did: string;
  display_name: string;
  handle: string | null;
  avatar_url: string | null;
  bio: string | null;
  timezone: string | null;
  agent_preferences: AgentPreferences;
  on_chain_registered: boolean;
}

export interface AgentPreferences {
  communication_style?: string;
  response_format?: string;
  expertise_areas: string[];
  dietary_restrictions: string[];
  accessibility_needs: string[];
  location?: GeoHint;
  custom: Record<string, unknown>;
}

export interface GeoHint {
  city?: string;
  region?: string;
  country?: string;
  timezone?: string;
}

export interface BillingStatus {
  tier: 'free' | 'consumer_pro' | 'business' | 'enterprise';
  stripe_customer_id: string | null;
  expires_at: string | null;
  limits: {
    resolve_per_day: number;
    profiles: number;
    analytics: boolean;
  };
  usage?: {
    api_calls_today: number;
    limit: number;
  };
}

export interface AnalyticsTimeline {
  days: Array<{
    date: string;
    views: number;
    resolves: number;
    service_calls: number;
  }>;
}

export interface AgentStats {
  agents: Array<{
    identifier: string;
    interactions: number;
    last_seen: string;
  }>;
}

export interface DiscoveryFunnel {
  agents_txt_fetched: number;
  well_known_fetched: number;
  profile_resolved: number;
  service_called: number;
}

// ── Orni Models Types ──

export interface Model {
  id: string;
  slug: string;
  name: string;
  description?: string;
  avatar_url?: string;
  creator_name?: string;
  creator_wallet?: string;
  system_prompt?: string;
  /** Stored in micro-USDC (1 USD = 1_000_000). UI must divide before display. */
  price_per_query: number;
  category?: string;
  tags?: string[];
  total_queries: number;
  status: string;
  created_at: string;
  creator_did?: string;
  creator_verified?: boolean;

  // Foundation catalog metadata — what the marketplace actually surfaces.
  is_featured?: boolean;
  is_foundation?: boolean;
  developer?: string;           // "Meta", "OpenAI", "Alibaba" — drives ProviderMark
  architecture?: string;        // "llama", "qwen2", "deepseek-v3-moe"
  params_b?: number;            // total params, billions
  active_params_b?: number;     // active params for MoE
  license?: string;             // "llama-3.1-community", "apache-2.0", "mit"
  license_url?: string;
  context_window?: number;      // tokens
  modality?: string[];          // ["text"], ["text","image"]
  hf_id?: string;
  release_date?: string;
  gguf_available?: boolean;
  recommended_vram_gb?: number;
  awaiting_host?: boolean;      // catalog-only: no provider wired yet
}

export interface ModelsResponse {
  models: Model[];
  total: number;
  page: number;
  limit: number;
}

export interface CreatorStats {
  total_models: number;
  total_queries: number;
  total_revenue: number;
  pending_earnings: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface Balance {
  balance: number;
  pending_earnings: number;
}

// ── Inference Node Types ──

export interface InferenceNode {
  id: string;
  owner_did: string;
  endpoint_url: string;
  models_served: string[];
  price_per_query_micro_usdc: number;
  status: "pending" | "active" | "degraded" | "offline";
  region?: string;
  description?: string;
  uptime_percent: number;
  total_queries: number;
  last_heartbeat_at?: string;
  created_at: string;
}

export interface NodeHeartbeat {
  status: string;
  latency_ms?: number;
  error_message?: string;
  created_at: string;
}

export const MODEL_CATEGORIES = [
  "All",
  "Education",
  "Entertainment",
  "Finance",
  "Health",
  "Lifestyle",
  "Technology",
  "Writing",
  "Other",
] as const;

// ── Chat Types ──

export interface ChatAgent {
  id: string;
  name: string;
  avatar: string;          // emoji or hex color
  provider: string;        // "openai" | "anthropic" | "google" | "mistral" | "groq" | "together" | "ollama" | etc.
  model: string;
  systemPrompt: string;
  apiKey: string;
  baseUrl?: string;
  createdAt: string;
  lastMessageAt?: string;
  lastMessagePreview?: string;
}

export interface ChatMessageLocal {
  id: string;
  agentId: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  model?: string;
}

export interface ProviderConfig {
  id: string;
  name: string;
  models: { id: string; name: string }[];
}

export interface EncryptedAgentConfig {
  id: string;
  user_id: string;
  encrypted_config: string;
  display_order: number;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EncryptedSnapshot {
  id: string;
  user_id: string;
  agent_id: string;
  encrypted_messages: string;
  message_count: number;
  snapshot_at: string;
}

// ── Headless Merchant Economy Types ──

export interface ServiceListingResponse {
  id: string;
  owner_did: string;
  name: string;
  slug: string;
  description: string;
  logo_url: string | null;
  website: string | null;
  category: string;
  tags: string[];
  base_url: string;
  auth_type: string;
  pricing_model: string;
  price_micro_usdc: number;
  status: string;
  uptime_percent: number;
  avg_latency_ms: number;
  total_requests: number;
  avg_rating: number | null;
  review_count: number;
  regions: string[];
  endpoints: unknown[];
  receive_address: string | null;
  created_at: string;
}

export interface ServiceDetail extends ServiceListingResponse {
  health_check_url: string | null;
  openapi_url: string | null;
  auth_details: Record<string, unknown>;
  pricing_tiers: unknown[] | null;
  free_tier_requests: number | null;
  sla_uptime_percent: number | null;
  sla_latency_p50_ms: number | null;
  sla_latency_p99_ms: number | null;
  total_revenue_micro_usdc: number;
  platform_fee_bps: number;
  updated_at: string;
}

export interface ReputationScore {
  entity_did: string;
  entity_type: string;
  overall_score: number;
  confidence: number;
  components: {
    identity: number;
    transaction: number;
    quality: number;
    reliability: number;
    history: number;
  };
  summary: {
    total_transactions: number;
    completion_rate: number;
    dispute_rate: number;
    total_volume_micro_usdc: number;
    avg_review_rating: number | null;
    review_count: number;
    account_age_days: number;
  };
  computed_at: string;
}

export const SERVICE_CATEGORIES = [
  "general",
  "inference",
  "data",
  "commerce",
  "finance",
  "logistics",
  "communication",
  "search",
  "media",
  "developer-tools",
] as const;

// ── Agent Ownership Types ──

export type AgentStatus = "active" | "paused" | "archived";

export interface Agent {
  id: string;
  user_id: string;
  slug: string;
  display_name: string;
  bio: string | null;
  avatar_url: string | null;
  did: string;
  solana_address: string;
  wallet_id: string | null;
  onchain_identity_pda: string | null;
  status: AgentStatus;
  created_at: string;
  updated_at: string;
}

export interface AgentWallet {
  id: string;
  user_id: string;
  label: string;
  hd_index: number;
  solana_address: string;
  spending_policy: Record<string, unknown>;
  active: boolean;
  agent_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentDetail extends Agent {
  wallet: AgentWallet | null;
  service_count: number;
  reputation_score: number | null;
}

export interface CreateAgentRequest {
  slug: string;
  display_name: string;
  bio?: string;
  avatar_url?: string;
}

export interface UpdateAgentRequest {
  display_name?: string;
  bio?: string;
  avatar_url?: string;
  status?: AgentStatus;
}

export interface AgentEarnings {
  agent_id: string;
  total_received_micro_usdc: number;
  total_spent_micro_usdc: number;
  net_micro_usdc: number;
  transaction_count: number;
}

export interface AgentReputationView {
  entity_did: string;
  entity_type: string;
  overall_score: number;
  confidence: number;
  total_transactions: number;
  completed_transactions: number;
  review_count: number;
}

export interface CreateAgentServiceRequest {
  name: string;
  slug: string;
  description?: string;
  category?: string;
  tags?: string[];
  base_url: string;
  health_check_url?: string;
  openapi_url?: string;
  auth_type?: string;
  pricing_model?: string;
  price_micro_usdc?: number;
  free_tier_requests?: number;
  sla_uptime_percent?: number;
  regions?: string[];
  receive_address?: string;
  platform_fee_bps?: number;
}
