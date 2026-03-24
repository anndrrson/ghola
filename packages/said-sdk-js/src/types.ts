export interface SAIDClientOptions {
  /** API key for authenticated requests (optional for public endpoints) */
  apiKey?: string;
  /** Base URL for the SAID API (default: https://api.said.id/v1) */
  baseUrl?: string;
  /** Request timeout in ms (default: 10000) */
  timeout?: number;
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

export interface AgentsTxt {
  identity: string | null;
  profile_url: string | null;
  said_json: string | null;
  allow_agents: string[];
  services: AgentsTxtService[];
  skills: AgentsTxtSkill[];
  auth: AgentsTxtAuth | null;
}

export interface AgentsTxtService {
  name: string;
  url: string;
}

export interface AgentsTxtSkill {
  name: string;
  url: string;
}

export interface AgentsTxtAuth {
  method: string;
  url: string;
}

export interface WellKnownSaid {
  said_version: string;
  did: string;
  profile_url?: string;
  business?: { name: string; category?: string; description?: string };
  services: ServiceDefinition[];
  operating_hours?: Record<string, string>;
  verification?: { method: string; record?: string };
}

export interface ResolvedProfile {
  profile_type: "business" | "consumer";
  profile: BusinessProfile | PublicProfile;
}

export interface DomainDiscovery {
  domain: string;
  agents_txt: AgentsTxt | null;
  well_known: WellKnownSaid | null;
}

// ── Headless Merchant Economy Types ──

export interface ServiceSearchOptions {
  category?: string;
  maxPriceMicroUsdc?: number;
  minUptime?: number;
  minRating?: number;
  minTrustScore?: number;
  authType?: string;
  region?: string;
  limit?: number;
}

export interface ServiceSearchResult {
  id: string;
  slug: string;
  name: string;
  description: string;
  base_url: string;
  auth_type: string;
  auth_details: Record<string, unknown>;
  price_micro_usdc: number;
  pricing_model: string;
  uptime_percent: number;
  avg_latency_ms: number;
  avg_rating: number | null;
  endpoints: unknown[];
  relevance_score: number | null;
}

export interface ServiceListing {
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
  health_check_url: string | null;
  openapi_url: string | null;
  auth_type: string;
  auth_details: Record<string, unknown>;
  pricing_model: string;
  price_micro_usdc: number;
  pricing_tiers: unknown[] | null;
  free_tier_requests: number | null;
  sla_uptime_percent: number | null;
  sla_latency_p50_ms: number | null;
  sla_latency_p99_ms: number | null;
  regions: string[];
  endpoints: unknown[];
  status: string;
  uptime_percent: number;
  avg_latency_ms: number;
  total_requests: number;
  total_revenue_micro_usdc: number;
  avg_rating: number | null;
  review_count: number;
  receive_address: string | null;
  platform_fee_bps: number;
  created_at: string;
  updated_at: string;
}

export interface VerifyAgentResult {
  valid: boolean;
  agent_did: string;
  display_name: string | null;
  profile_type: string | null;
  on_chain_registered: boolean;
  verified_badge: boolean;
  capabilities: string[];
  trust_score: number;
  spending_summary: AgentSpendingSummary | null;
  error: string | null;
}

export interface AgentSpendingSummary {
  total_transactions: number;
  total_spent_micro_usdc: number;
  avg_transaction_micro_usdc: number;
  first_transaction_at: string | null;
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
    completed_transactions: number;
    disputed_transactions: number;
    completion_rate: number;
    dispute_rate: number;
    total_volume_micro_usdc: number;
    avg_review_rating: number | null;
    review_count: number;
    account_age_days: number;
  };
  computed_at: string;
}
