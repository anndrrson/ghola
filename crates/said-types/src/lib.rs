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
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
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
