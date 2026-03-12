use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

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

// ── Wallet Metadata ──

/// Wallet metadata stored unencrypted alongside the encrypted data.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WalletMetadata {
    pub version: u32,
    pub created_at: DateTime<Utc>,
    pub master_public_key: String,
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
    /// Auth endpoint and method.
    pub auth: Option<AgentsTxtAuth>,
}

/// A service entry in agents.txt.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct AgentsTxtService {
    pub name: String,
    pub url: String,
}

/// Auth declaration in agents.txt.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct AgentsTxtAuth {
    pub method: String,
    pub url: String,
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
