use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;
use zeroize::Zeroize;

// ── Data Schemas ──

/// A portable system prompt.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct SystemPrompt {
    pub id: Uuid,
    pub name: String,
    pub content: String,
    pub tags: Vec<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// A memory fact that persists across sessions.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct Memory {
    pub id: Uuid,
    pub content: String,
    pub tags: Vec<String>,
    pub source_provider: Option<String>,
    pub created_at: DateTime<Utc>,
}

/// A user preference (dotted key path).
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct Preference {
    /// Dotted key path, e.g. "code.language", "tone.formality"
    pub key: String,
    pub value: serde_json::Value,
    pub updated_at: DateTime<Utc>,
}

/// A conversation history entry.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ConversationEntry {
    pub id: Uuid,
    pub role: Role,
    pub content: String,
    pub provider: String,
    pub model: Option<String>,
    pub timestamp: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
    System,
}

/// A knowledge base document.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct KnowledgeDoc {
    pub id: Uuid,
    pub title: String,
    pub content: String,
    pub tags: Vec<String>,
    pub created_at: DateTime<Utc>,
}

/// MCP server configuration reference.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct McpConfig {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: std::collections::HashMap<String, String>,
}

/// A secret stored in the vault (API keys, tokens, credentials).
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct Secret {
    pub id: Uuid,
    /// Unique name for this secret, e.g. "stripe", "openai", "github"
    pub name: String,
    /// The secret value (encrypted at rest by the wallet)
    pub value: String,
    /// Optional description
    pub description: Option<String>,
    /// Optional tags for organization
    pub tags: Vec<String>,
    /// Which providers are allowed to read this secret (empty = all)
    pub allowed_providers: Vec<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Drop for Secret {
    fn drop(&mut self) {
        self.value.zeroize();
    }
}

// ── Wallet Metadata ──

/// Wallet metadata stored unencrypted alongside the encrypted data.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WalletMetadata {
    pub version: u32,
    pub created_at: DateTime<Utc>,
    pub master_public_key: String,
    /// Whether the seed file is encrypted with a password.
    #[serde(default)]
    pub seed_encrypted: bool,
}

// ── HD Derivation Constants ──

/// Provider index for HD key derivation.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq, Hash)]
pub enum Provider {
    Master = 0,
    OpenAI = 1,
    Anthropic = 2,
    Google = 3,
    Local = 4,
    Solana = 5,
    Agent = 6,
}

/// Key type within a provider's derivation subtree.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub enum KeyType {
    Signing = 0,
    Encryption = 1,
    Storage = 2,
}

/// HD derivation purpose for SAID: 0x534149 = "SAI" in ASCII.
/// Path: m / 0x534149' / provider' / key_type' / instance
pub const SAID_PURPOSE: u32 = 0x534149;

// ── UCAN / Provider Sessions ──

/// A capability that can be granted to a provider.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    ReadPrompts,
    ReadPreferences,
    ReadMemories,
    WriteMemories,
    ReadKnowledge,
    ReadConversations,
    ReadMcpConfigs,
    ReadSecrets,
    WriteSecrets,
    PayRead,
    PayTransfer,
    PayManage,
    /// Shorthand for all capabilities.
    All,
}

impl Capability {
    /// Convert to the UCAN `can` action string.
    pub fn to_ucan_action(&self) -> &'static str {
        match self {
            Self::ReadPrompts => "said/read_prompts",
            Self::ReadPreferences => "said/read_preferences",
            Self::ReadMemories => "said/read_memories",
            Self::WriteMemories => "said/write_memories",
            Self::ReadKnowledge => "said/read_knowledge",
            Self::ReadConversations => "said/read_conversations",
            Self::ReadMcpConfigs => "said/read_mcp_configs",
            Self::ReadSecrets => "said/read_secrets",
            Self::WriteSecrets => "said/write_secrets",
            Self::PayRead => "said/pay_read",
            Self::PayTransfer => "said/pay_transfer",
            Self::PayManage => "said/pay_manage",
            Self::All => "said/*",
        }
    }

    /// Parse from a UCAN `can` action string.
    pub fn from_ucan_action(s: &str) -> Option<Self> {
        match s {
            "said/read_prompts" => Some(Self::ReadPrompts),
            "said/read_preferences" => Some(Self::ReadPreferences),
            "said/read_memories" => Some(Self::ReadMemories),
            "said/write_memories" => Some(Self::WriteMemories),
            "said/read_knowledge" => Some(Self::ReadKnowledge),
            "said/read_conversations" => Some(Self::ReadConversations),
            "said/read_mcp_configs" => Some(Self::ReadMcpConfigs),
            "said/read_secrets" => Some(Self::ReadSecrets),
            "said/write_secrets" => Some(Self::WriteSecrets),
            "said/pay_read" => Some(Self::PayRead),
            "said/pay_transfer" => Some(Self::PayTransfer),
            "said/pay_manage" => Some(Self::PayManage),
            "said/*" => Some(Self::All),
            _ => None,
        }
    }

    /// Parse from a CLI-friendly string like "read-prompts".
    pub fn from_cli_str(s: &str) -> Option<Self> {
        match s {
            "read-prompts" => Some(Self::ReadPrompts),
            "read-preferences" => Some(Self::ReadPreferences),
            "read-memories" => Some(Self::ReadMemories),
            "write-memories" => Some(Self::WriteMemories),
            "read-knowledge" => Some(Self::ReadKnowledge),
            "read-conversations" => Some(Self::ReadConversations),
            "read-mcp-configs" => Some(Self::ReadMcpConfigs),
            "read-secrets" => Some(Self::ReadSecrets),
            "write-secrets" => Some(Self::WriteSecrets),
            "pay-read" => Some(Self::PayRead),
            "pay-transfer" => Some(Self::PayTransfer),
            "pay-manage" => Some(Self::PayManage),
            "read-all" => Some(Self::All),
            "all" => Some(Self::All),
            _ => None,
        }
    }

    /// Check whether this capability grants access for the given required capability.
    pub fn grants(&self, required: &Capability) -> bool {
        *self == Capability::All || self == required
    }
}

/// A provider session — tracks a UCAN grant to a provider.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ProviderSession {
    pub id: Uuid,
    pub provider: Provider,
    pub label: String,
    pub capabilities: Vec<Capability>,
    pub token: String,
    pub issued_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub revoked: bool,
}

// ── Business Identity (agents.txt / Cloud) ──

/// A business profile for the SAID identity layer.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct BusinessProfile {
    pub did: String,
    pub business_name: String,
    /// Unique handle, e.g. @example-restaurant
    pub handle: Option<String>,
    /// Category: "restaurant", "hotel", "saas", "retail", "service", etc.
    pub category: String,
    pub description: String,
    pub logo_url: Option<String>,
    pub website: String,
    pub verified_domain: Option<String>,
    pub verified_at: Option<DateTime<Utc>>,
    pub operating_hours: Option<serde_json::Value>,
    pub location: Option<BusinessLocation>,
    pub contact: Option<BusinessContact>,
    pub services: Vec<ServiceDefinition>,
    pub policies: Vec<PolicyDefinition>,
    pub api_endpoints: Vec<ApiEndpoint>,
    pub payment_methods: Vec<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Physical location of a business.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct BusinessLocation {
    pub address: Option<String>,
    pub city: Option<String>,
    pub state: Option<String>,
    pub country: Option<String>,
    pub postal_code: Option<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
}

/// Contact information for a business.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct BusinessContact {
    pub email: Option<String>,
    pub phone: Option<String>,
    pub support_url: Option<String>,
}

/// A service offered by a business, discoverable by AI agents.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ServiceDefinition {
    pub name: String,
    pub description: String,
    pub price: Option<String>,
    pub availability: Option<String>,
    pub booking_url: Option<String>,
    pub api_endpoint: Option<String>,
    /// JSON Schema describing the API parameters for this service.
    pub parameters: serde_json::Value,
    /// Optional URL to an agentskills.io-compatible skill manifest for this service.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill_url: Option<String>,
}

/// An API endpoint exposed by a business for agent interaction.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ApiEndpoint {
    pub name: String,
    pub url: String,
    /// HTTP method: GET, POST, PUT, DELETE, etc.
    pub method: String,
    /// Auth type: "none", "api_key", "ucan"
    pub auth_type: String,
    pub description: String,
    pub request_schema: serde_json::Value,
    pub response_schema: serde_json::Value,
}

/// A business policy (cancellation, refund, privacy, etc.).
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct PolicyDefinition {
    /// Policy name: "cancellation", "refund", "privacy"
    pub name: String,
    /// Human-readable policy text.
    pub content: String,
    /// Structured rules for agent consumption.
    pub machine_readable: serde_json::Value,
}

// ── Public Profile (Consumer) ──

/// A public-facing consumer profile for agent interactions.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct PublicProfile {
    pub did: String,
    pub display_name: String,
    pub handle: Option<String>,
    pub avatar_url: Option<String>,
    pub bio: Option<String>,
    pub timezone: Option<String>,
    pub agent_preferences: AgentPreferences,
    pub on_chain_registered: bool,
}

/// User preferences that agents can use to personalize interactions.
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct AgentPreferences {
    pub communication_style: Option<String>,
    pub response_format: Option<String>,
    pub expertise_areas: Vec<String>,
    pub dietary_restrictions: Vec<String>,
    pub accessibility_needs: Vec<String>,
    pub location: Option<GeoHint>,
    pub custom: HashMap<String, serde_json::Value>,
}

/// Approximate geographic location hint (no precise coordinates).
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct GeoHint {
    pub city: Option<String>,
    pub region: Option<String>,
    pub country: Option<String>,
    pub timezone: Option<String>,
}

// ── agents.txt Parsed Types ──

/// Parsed representation of an agents.txt file.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct AgentsTxt {
    /// The DID identity declared in the file.
    pub identity: Option<String>,
    /// URL to the full SAID profile.
    pub profile_url: Option<String>,
    /// Path to .well-known/said.json (relative or absolute).
    pub said_json: Option<String>,
    /// Agent access policy: "*" for all, or specific agent identifiers.
    pub allow_agents: Vec<String>,
    /// Declared services (name -> URL).
    pub services: Vec<AgentsTxtService>,
    /// Declared skills (agentskills.io manifests).
    #[serde(default)]
    pub skills: Vec<AgentsTxtSkill>,
    /// Auth endpoint and method.
    pub auth: Option<AgentsTxtAuth>,
    /// Per-service pricing declarations.
    #[serde(default)]
    pub pricing: Vec<AgentsTxtPricing>,
    /// SLA guarantees.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sla: Option<AgentsTxtSla>,
    /// URL to OpenAPI spec.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub openapi: Option<String>,
    /// Payment configuration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payment: Option<AgentsTxtPayment>,
    /// Spec version (e.g. "1.1").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// A service entry in agents.txt.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct AgentsTxtService {
    pub name: String,
    pub url: String,
}

/// A skill entry in agents.txt (agentskills.io compatible).
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct AgentsTxtSkill {
    /// Skill name (single token, e.g. "book-table", "check-availability").
    pub name: String,
    /// URL to an agentskills.io-compatible skill manifest.
    pub url: String,
}

/// Auth declaration in agents.txt.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct AgentsTxtAuth {
    pub method: String,
    pub url: String,
}

/// Pricing declaration in agents.txt.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct AgentsTxtPricing {
    /// Service name this pricing applies to.
    pub service: String,
    /// Pricing model: "per_request", "per_minute", "per_token", etc.
    pub model: String,
    /// Human-readable price string, e.g. "0.001"
    pub price_usdc: String,
    /// Free tier description, e.g. "100/day"
    pub free_tier: Option<String>,
}

/// SLA declaration in agents.txt.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct AgentsTxtSla {
    pub uptime: Option<String>,
    pub latency_p50: Option<String>,
    pub latency_p99: Option<String>,
}

/// Payment configuration in agents.txt.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct AgentsTxtPayment {
    /// Solana address to receive payments.
    pub address: String,
    /// Accepted currencies (e.g. ["usdc", "sol"]).
    pub currencies: Vec<String>,
    /// SAID verification endpoint URL.
    pub verify_url: String,
}

/// Full .well-known/said.json structure.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct WellKnownSaid {
    pub said_version: String,
    pub did: String,
    pub profile_url: Option<String>,
    pub business: Option<WellKnownBusiness>,
    pub services: Vec<ServiceDefinition>,
    pub operating_hours: Option<serde_json::Value>,
    pub verification: Option<WellKnownVerification>,
    /// Link to SAID service registry listings for this entity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub services_registry_url: Option<String>,
    /// URL to OpenAPI spec.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub openapi_url: Option<String>,
    /// Payment configuration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payment: Option<WellKnownPayment>,
    /// Reputation lookup URL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reputation_url: Option<String>,
}

/// Payment configuration in .well-known/said.json.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct WellKnownPayment {
    pub receive_address: String,
    pub accepted_currencies: Vec<String>,
    pub verify_url: String,
    pub meter_url: String,
}

/// Business info within .well-known/said.json.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct WellKnownBusiness {
    pub name: String,
    pub category: Option<String>,
    pub description: Option<String>,
}

/// Verification method in .well-known/said.json.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct WellKnownVerification {
    pub method: String,
    pub record: Option<String>,
}

// ── Inference Node Types ──

/// Status of a registered inference node.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum NodeStatus {
    Pending,
    Active,
    Degraded,
    Offline,
}

/// A registered inference node.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct InferenceNodeRegistration {
    pub endpoint_url: String,
    pub models_served: Vec<String>,
    pub price_per_query_micro_usdc: i64,
    pub region: Option<String>,
    pub description: Option<String>,
}

// ── Service Registry Types ──

/// Status of a registered service listing.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ServiceListingStatus {
    Pending,
    Active,
    Degraded,
    Offline,
    Suspended,
}

/// Auth type required by a service.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ServiceAuthType {
    None,
    ApiKey,
    Ucan,
    OAuth2,
    SaidVerify,
}

/// Pricing model for a service.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PricingModel {
    PerRequest,
    PerMinute,
    PerToken,
    FlatMonthly,
    Free,
}

/// A pricing tier within a service listing.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct PricingTier {
    pub name: String,
    pub price_micro_usdc: i64,
    pub rate_limit: Option<i32>,
    pub description: Option<String>,
}

/// A structured endpoint within a service listing.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ServiceListingEndpoint {
    pub name: String,
    pub path: String,
    pub method: String,
    pub description: String,
    #[serde(default)]
    pub request_schema: serde_json::Value,
    #[serde(default)]
    pub response_schema: serde_json::Value,
    /// Per-endpoint pricing override (micro USDC). None = use service-level pricing.
    pub price_micro_usdc: Option<i64>,
}

/// SLA guarantees for a service.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ServiceSla {
    pub uptime_percent: Option<f32>,
    pub latency_p50_ms: Option<i32>,
    pub latency_p99_ms: Option<i32>,
}

/// Measured metrics for a service listing.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ServiceMetrics {
    pub uptime_percent: f32,
    pub avg_latency_ms: f32,
    pub total_requests: i64,
    pub avg_rating: Option<f32>,
    pub review_count: i32,
}

// ── Agent Payment Types ──

/// An agent wallet derived from the SAID HD path.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct AgentWallet {
    pub id: Uuid,
    pub label: String,
    /// HD derivation index: m / 0x534149' / 6' / 0' / {index}
    pub index: u32,
    /// Base58-encoded Solana address
    pub solana_address: String,
    pub spending_policy: SpendingPolicy,
    pub created_at: DateTime<Utc>,
    pub active: bool,
}

/// Spending policy for an agent wallet.
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct SpendingPolicy {
    /// Maximum daily spend in lamports (None = unlimited)
    pub daily_limit_lamports: Option<u64>,
    /// Maximum daily spend in USDC micro-units (6 decimals, None = unlimited)
    pub daily_limit_usdc_micro: Option<u64>,
    /// Maximum per-transaction spend in lamports (None = unlimited)
    pub per_tx_limit_lamports: Option<u64>,
    /// Maximum per-transaction spend in USDC micro-units (None = unlimited)
    pub per_tx_limit_usdc_micro: Option<u64>,
    /// Allowed recipient addresses in base58 (empty = any)
    #[serde(default)]
    pub allowed_recipients: Vec<String>,
}

/// A payment transaction record.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct PaymentTransaction {
    pub id: Uuid,
    pub agent_id: Uuid,
    pub agent_label: String,
    pub direction: TxDirection,
    pub currency: PayCurrency,
    /// Amount in lamports (SOL) or micro-units (USDC, 6 decimals)
    pub amount: u64,
    pub recipient: String,
    pub sender: String,
    /// Solana transaction signature
    pub signature: String,
    pub memo: Option<String>,
    pub status: TxStatus,
    pub created_at: DateTime<Utc>,
}

/// Direction of a payment transaction.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TxDirection {
    Send,
    Receive,
}

/// Currency of a payment transaction.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PayCurrency {
    Sol,
    Usdc,
}

/// Status of a payment transaction.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TxStatus {
    Pending,
    Confirmed,
    Failed,
}

// ── Circuit Breaker Types ──

/// Tracks consecutive payment failures for an agent wallet.
/// When `consecutive_failures` reaches the configured threshold, `tripped` is set to true
/// and the agent's spending is locked until manually unlocked.
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct SpendingCircuitBreaker {
    pub agent_id: Uuid,
    /// Number of consecutive payment failures since last success or unlock.
    pub consecutive_failures: u32,
    /// Whether the circuit breaker has tripped (spending is locked).
    pub tripped: bool,
    /// Timestamp of the most recent payment failure.
    pub last_failure_at: Option<DateTime<Utc>>,
    /// Timestamp when the circuit breaker tripped.
    pub tripped_at: Option<DateTime<Utc>>,
}

/// Spending status for an agent wallet — returned by `said_spending_status`.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct SpendingStatus {
    pub agent_id: Uuid,
    pub agent_label: String,
    pub solana_address: String,
    pub active: bool,
    /// Total SOL sent in the last 24h (lamports).
    pub spend_today_sol_lamports: u64,
    /// Total USDC sent in the last 24h (micro-units, 6 decimals).
    pub spend_today_usdc_micro: u64,
    /// Daily SOL limit (lamports). None = unlimited.
    pub daily_limit_sol_lamports: Option<u64>,
    /// Daily USDC limit (micro-units). None = unlimited.
    pub daily_limit_usdc_micro: Option<u64>,
    /// Per-transaction SOL limit (lamports). None = unlimited.
    pub per_tx_limit_sol_lamports: Option<u64>,
    /// Per-transaction USDC limit (micro-units). None = unlimited.
    pub per_tx_limit_usdc_micro: Option<u64>,
    /// Remaining SOL budget today (lamports). None if no daily limit is set.
    pub remaining_sol_lamports: Option<u64>,
    /// Remaining USDC budget today (micro-units). None if no daily limit is set.
    pub remaining_usdc_micro: Option<u64>,
    /// Whether the circuit breaker has tripped (spending locked).
    pub circuit_breaker_tripped: bool,
    /// Number of consecutive payment failures.
    pub consecutive_failures: u32,
    /// When the circuit breaker tripped. None if not tripped.
    pub tripped_at: Option<DateTime<Utc>>,
}
