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
  price_per_query: number;
  category?: string;
  tags?: string[];
  total_queries: number;
  status: string;
  created_at: string;
  creator_did?: string;
  creator_verified?: boolean;
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
