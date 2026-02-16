use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
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
