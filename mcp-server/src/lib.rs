pub mod http;
mod solana_lookup;

use std::sync::{Arc, Mutex};

use rmcp::{
    handler::server::{tool::ToolRouter, wrapper::Parameters},
    model::*,
    tool, tool_handler, tool_router,
    transport::stdio,
    ErrorData, ServerHandler, ServiceExt,
};
use schemars::JsonSchema;
use serde::Deserialize;

use said_core::Wallet;
use said_types::{
    AgentWallet, Capability, ConversationEntry, KnowledgeDoc, McpConfig, Memory, PayCurrency,
    PaymentTransaction, Preference, Secret, SpendingPolicy, SpendingStatus, SystemPrompt,
    TxDirection, TxStatus,
};
use said_x402::{GholaX402Client, X402PaymentPayload};

// ── Tool Parameter Types ──

#[derive(Deserialize, JsonSchema)]
pub struct GetSystemPromptParams {
    /// Name of the system prompt to retrieve. Returns the default if omitted.
    pub name: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
pub struct GetPreferencesParams {
    /// Dotted key path to filter (e.g. "code.language"). Returns all if omitted.
    pub path: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
pub struct SearchMemoriesParams {
    /// Keyword search query.
    pub query: String,
    /// Max results (default 10).
    pub limit: Option<usize>,
}

#[derive(Deserialize, JsonSchema)]
pub struct AddMemoryParams {
    /// The memory content to store.
    pub content: String,
    /// Optional tags for categorization.
    pub tags: Option<Vec<String>>,
}

#[derive(Deserialize, JsonSchema)]
pub struct SearchKnowledgeParams {
    /// Search query for knowledge base.
    pub query: String,
    /// Max results (default 10).
    pub limit: Option<usize>,
}

#[derive(Deserialize, JsonSchema)]
pub struct GetConversationContextParams {
    /// Max recent entries to return (default 20).
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GetRelevantContextParams {
    /// A snippet of conversation text to find relevant context for
    pub conversation_snippet: String,
    /// Maximum number of results per category (default: 10)
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ObserveParams {
    /// The observation/fact to record
    pub content: String,
    /// Role of the observer: "user" or "assistant"
    pub role: String,
    /// Which AI provider this observation came from
    pub source_provider: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct LookupIdentityParams {
    /// DID (did:key:z6Mk...) or base58 master public key
    pub query: String,
    /// Solana RPC URL (default: https://api.devnet.solana.com)
    pub rpc_url: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DiscoverBusinessParams {
    /// Domain name to discover (e.g. "restaurant.com")
    pub domain: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct FetchAgentsTxtParams {
    /// Domain name to fetch agents.txt from (e.g. "example.com")
    pub domain: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GetPublicProfileParams {
    /// DID (did:key:...) to look up
    pub did: String,
    /// SAID Cloud API base URL (default: https://api.said.id/v1)
    pub api_url: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct RequestServiceParams {
    /// The service API endpoint URL
    pub url: String,
    /// HTTP method (GET, POST, PUT, DELETE)
    pub method: Option<String>,
    /// Request body as JSON string (for POST/PUT)
    pub body: Option<String>,
    /// Authorization header value (e.g. "Bearer token" or UCAN token)
    pub authorization: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
pub struct GetSecretParams {
    /// Name of the secret to retrieve (e.g. "stripe", "openai")
    pub name: String,
}

#[derive(Deserialize, JsonSchema)]
pub struct SetSecretParams {
    /// Name of the secret (e.g. "stripe", "openai")
    pub name: String,
    /// The secret value to store
    pub value: String,
    /// Optional description
    pub description: Option<String>,
    /// Optional tags for organization
    pub tags: Option<Vec<String>>,
    /// Restrict to specific providers (empty = all providers can access)
    pub allowed_providers: Option<Vec<String>>,
}

#[derive(Deserialize, JsonSchema)]
pub struct RemoveSecretParams {
    /// Name of the secret to remove
    pub name: String,
}

// ── Payment Tool Parameter Types ──

#[derive(Deserialize, JsonSchema)]
pub struct PayBalanceParams {
    /// Agent wallet label. If omitted, shows the owner wallet balance.
    pub agent: Option<String>,
    /// Solana RPC URL (default: https://api.devnet.solana.com)
    pub rpc_url: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
pub struct PayAddressParams {
    /// Agent wallet label. If omitted, shows the owner wallet address.
    pub agent: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
pub struct PayTransferParams {
    /// Agent wallet label to send from
    pub agent: String,
    /// Recipient Solana address (base58)
    pub to: String,
    /// Amount to send (in SOL or USDC, human-readable e.g. "0.5")
    pub amount: String,
    /// Currency: "sol" or "usdc" (default: "sol")
    pub currency: Option<String>,
    /// Optional memo for the transaction
    pub memo: Option<String>,
    /// Solana RPC URL (default: https://api.devnet.solana.com)
    pub rpc_url: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
pub struct PayCreateAgentParams {
    /// Human-readable label for the agent wallet
    pub label: String,
    /// Daily USDC spending limit in dollars (e.g. "50")
    pub daily_usdc_limit: Option<String>,
    /// Per-transaction USDC limit in dollars (e.g. "10")
    pub per_tx_usdc_limit: Option<String>,
    /// Daily SOL spending limit (e.g. "1.0")
    pub daily_sol_limit: Option<String>,
    /// Per-transaction SOL limit (e.g. "0.5")
    pub per_tx_sol_limit: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
pub struct PayHistoryParams {
    /// Agent wallet label. If omitted, shows all transactions.
    pub agent: Option<String>,
    /// Max number of transactions to return (default: 20)
    pub limit: Option<usize>,
}

#[derive(Deserialize, JsonSchema)]
pub struct PayLimitsParams {
    /// Agent wallet label
    pub agent: String,
}

// ── Headless Merchant Economy Tool Parameter Types ──

#[derive(Deserialize, JsonSchema)]
pub struct SearchServicesParams {
    /// Search query describing what you need (e.g. "SEC filing search", "image generation")
    pub query: String,
    /// Filter by category (e.g. "data", "inference", "commerce", "finance")
    pub category: Option<String>,
    /// Maximum price per request in USDC (human-readable, e.g. "0.01")
    pub max_price_usdc: Option<String>,
    /// Minimum average rating (1.0 - 5.0)
    pub min_rating: Option<f32>,
    /// Filter by region (e.g. "us-east", "eu-west")
    pub region: Option<String>,
    /// Max results (default 5)
    pub limit: Option<usize>,
    /// SAID Cloud API base URL (default: https://ghola-api.onrender.com)
    pub api_url: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
pub struct GetServiceParams {
    /// Service slug or UUID
    pub slug_or_id: String,
    /// SAID Cloud API base URL
    pub api_url: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
pub struct VerifyAgentToolParams {
    /// The agent's DID (did:key:z6Mk...)
    pub agent_did: String,
    /// UCAN token to verify (optional — omit for identity-only check)
    pub ucan_token: Option<String>,
    /// Required capabilities to check (e.g. ["said/pay_transfer", "said/read_preferences"])
    pub required_capabilities: Option<Vec<String>>,
    /// Service API key for authentication
    pub service_key: Option<String>,
    /// SAID Cloud API base URL
    pub api_url: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
pub struct TrustScoreParams {
    /// DID to look up reputation for
    pub did: String,
    /// SAID Cloud API base URL
    pub api_url: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
pub struct CallServiceParams {
    /// Service slug to call
    pub slug: String,
    /// Endpoint path (e.g. "/v1/search" or full URL)
    pub endpoint: Option<String>,
    /// HTTP method (GET, POST, PUT, DELETE). Default: GET
    pub method: Option<String>,
    /// Request body as JSON string (for POST/PUT)
    pub body: Option<String>,
    /// Authorization header value
    pub authorization: Option<String>,
    /// SAID Cloud API base URL
    pub api_url: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
pub struct SubscribeServiceParams {
    /// Service slug to subscribe to
    pub service_slug: String,
    /// Agent wallet label
    pub agent_label: String,
    /// Daily USDC spending budget (e.g. "10.00"). Omit for unlimited.
    pub daily_budget_usdc: Option<String>,
    /// SAID Cloud API base URL
    pub api_url: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
pub struct VerifyX402MerchantParams {
    /// Solana address of the merchant (from x402 payTo field)
    pub address: String,
    /// SAID Cloud API base URL
    pub api_url: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
pub struct PayX402Params {
    /// The service URL to call (will be probed for a 402 first)
    pub url: String,
    /// HTTP method for the service call (default: GET)
    pub method: Option<String>,
    /// Request body as JSON string (for POST/PUT)
    pub body: Option<String>,
    /// Agent wallet label to pay from
    pub agent: String,
    /// Minimum trust score to proceed with payment (0.0–1.0, default: 0.3).
    /// Use 0.0 to allow payment to any merchant, 0.7 for verified-only.
    pub min_trust_score: Option<f32>,
    /// Optional memo logged with the transaction
    pub memo: Option<String>,
    /// Solana RPC URL (default: https://api.devnet.solana.com)
    pub rpc_url: Option<String>,
    /// Ghola API base URL for trust checks (default: https://ghola-api.onrender.com/v1)
    pub ghola_api_url: Option<String>,
}

// ── Service Discovery Tool Parameter Types ──

#[derive(Deserialize, JsonSchema)]
pub struct DiscoverServicesParams {
    /// Filter by service category (e.g. "data", "inference", "commerce", "finance")
    pub category: Option<String>,
    /// Filter by tags (e.g. ["weather", "realtime"])
    pub tags: Option<Vec<String>>,
    /// Maximum price per request in USDC (human-readable, e.g. "0.01")
    pub max_price_usdc: Option<String>,
    /// Minimum on-chain reputation score 0.0–1.0 (default: 0.0 = no filter)
    pub min_reputation: Option<f32>,
    /// Maximum number of results (default 10)
    pub limit: Option<usize>,
    /// Solana RPC URL (default: https://api.devnet.solana.com)
    pub rpc_url: Option<String>,
    /// SAID Cloud API base URL (default: https://ghola-api.onrender.com)
    pub api_url: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
pub struct EvaluateServiceParams {
    /// Service slug (e.g. "acme-weather-api")
    pub slug: String,
    /// SAID Cloud API base URL (default: https://ghola-api.onrender.com)
    pub api_url: Option<String>,
    /// Solana RPC URL for on-chain reputation check (default: https://api.devnet.solana.com)
    pub rpc_url: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
pub struct DiscoverAndPayParams {
    /// Natural language description of what you need (e.g. "current weather in NYC")
    pub task: String,
    /// Filter by category (e.g. "data", "inference")
    pub category: Option<String>,
    /// Maximum price per request in USDC (e.g. "0.05")
    pub max_price_usdc: Option<String>,
    /// Minimum trust score to proceed with payment (0.0–1.0, default: 0.5)
    pub min_trust_score: Option<f32>,
    /// Agent wallet label to pay from
    pub agent: String,
    /// Request body to send to the service (JSON string)
    pub request_body: Option<String>,
    /// Solana RPC URL (default: https://api.devnet.solana.com)
    pub rpc_url: Option<String>,
    /// SAID Cloud API base URL (default: https://ghola-api.onrender.com)
    pub api_url: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
pub struct SpendingStatusParams {
    /// Agent wallet label
    pub agent: String,
}

// ── Enterprise Tool Parameter Types ──

#[derive(Deserialize, JsonSchema)]
pub struct AuditLogParams {
    /// Filter by tenant ID (UUID). If omitted, returns global events.
    pub tenant_id: Option<String>,
    /// Filter by event type (e.g. "wallet_op", "payment", "ucan_delegation").
    pub event_type: Option<String>,
    /// Filter by actor DID.
    pub actor_did: Option<String>,
    /// ISO-8601 start timestamp for the query range.
    pub since: Option<String>,
    /// Max results (default 50, max 500).
    pub limit: Option<u32>,
    /// Ghola Cloud API base URL (default: https://ghola-api.onrender.com).
    pub api_url: Option<String>,
    /// Bearer JWT token for authentication.
    pub token: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
pub struct TreasuryStatusParams {
    /// Tenant ID (UUID) to query treasury pools for.
    pub tenant_id: String,
    /// Specific pool ID (UUID) — if omitted, lists all pools for the tenant.
    pub pool_id: Option<String>,
    /// Ghola Cloud API base URL (default: https://ghola-api.onrender.com).
    pub api_url: Option<String>,
    /// Bearer JWT token for authentication.
    pub token: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
pub struct RequestApprovalParams {
    /// Treasury pool ID (UUID) to draw from.
    pub treasury_pool_id: String,
    /// Tenant ID (UUID) the pool belongs to.
    pub tenant_id: String,
    /// Amount to transfer in micro-USDC (1 USDC = 1_000_000 micro-USDC).
    pub amount_micro_usdc: i64,
    /// Recipient Solana address.
    pub recipient_address: String,
    /// Human-readable purpose / description for this payment.
    pub purpose: String,
    /// Ghola Cloud API base URL (default: https://ghola-api.onrender.com).
    pub api_url: Option<String>,
    /// Bearer JWT token for authentication.
    pub token: Option<String>,
}

// ── MCP Server ──

/// Per-request authenticated session, established by the HTTP auth
/// middleware and read by tool handlers via [`REQUEST_SESSION`].
///
/// We use a task-local — not a field on `SaidServer` — because rmcp's
/// session manager reuses a single `SaidServer` across many concurrent
/// requests. Earlier code stored the verified capabilities in a shared
/// `Arc<Mutex<Option<Vec<Capability>>>>` written by the middleware and
/// `take()`'d by the service factory; under concurrent requests that let
/// caps from request A satisfy a tool call in request B's session. The
/// task-local makes that impossible by binding caps to the calling task.
#[derive(Clone, Debug, Default)]
pub struct RequestSession {
    pub capabilities: Vec<Capability>,
    pub provider_label: Option<String>,
    /// Issuer DID of the verified UCAN, useful for audit logs.
    pub issuer_did: Option<String>,
}

tokio::task_local! {
    /// Set by the HTTP auth middleware via `REQUEST_SESSION.scope(...)`
    /// before forwarding a request to the rmcp service. Tool handlers read
    /// it through [`current_session`].
    pub static REQUEST_SESSION: RequestSession;
}

/// Distinguishes the trust model the server is operating under. In `Stdio`
/// mode the user is the one running the binary; capability checks are
/// disabled. In `Http` mode every tool call must find a `RequestSession`
/// in the task-local — failure to do so is a server bug, not a "stdio
/// fallback," and is surfaced as an explicit error.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthMode {
    Stdio,
    Http,
}

#[derive(Clone)]
pub struct SaidServer {
    wallet: Arc<Mutex<Wallet>>,
    tool_router: ToolRouter<Self>,
    auth_mode: AuthMode,
}

impl SaidServer {
    /// Check that the current session has the required capability.
    ///
    /// - In `Stdio` mode, always allows the call.
    /// - In `Http` mode, reads the per-request task-local
    ///   ([`REQUEST_SESSION`]). If the task-local is unset (which would
    ///   indicate that the auth middleware was not in front of the call),
    ///   the call is denied — failing closed is the only safe default.
    fn check_capability(&self, cap: &Capability) -> Result<(), ErrorData> {
        if self.auth_mode == AuthMode::Stdio {
            return Ok(());
        }
        REQUEST_SESSION
            .try_with(|session| {
                if session.capabilities.iter().any(|c| c.grants(cap)) {
                    Ok(())
                } else {
                    Err(ErrorData::internal_error(
                        format!("insufficient capability: {:?}", cap),
                        None,
                    ))
                }
            })
            .unwrap_or_else(|_| {
                Err(ErrorData::internal_error(
                    "no authenticated session for this request",
                    None,
                ))
            })
    }

    /// Returns the provider label of the currently authenticated session,
    /// if any. Returns `None` in stdio mode (no provider context — user is
    /// at the terminal).
    fn current_provider_label(&self) -> Option<String> {
        if self.auth_mode == AuthMode::Stdio {
            return None;
        }
        REQUEST_SESSION
            .try_with(|s| s.provider_label.clone())
            .unwrap_or(None)
    }
}

#[tool_router]
impl SaidServer {
    /// Create a new server in stdio mode (no auth, all tools allowed).
    pub fn new(wallet: Wallet) -> Self {
        Self {
            wallet: Arc::new(Mutex::new(wallet)),
            tool_router: Self::tool_router(),
            auth_mode: AuthMode::Stdio,
        }
    }

    /// Create a new server in HTTP mode. Capability and provider-label
    /// checks read from the per-request [`REQUEST_SESSION`] task-local
    /// scope established by the auth middleware.
    pub fn new_http(wallet: Arc<Mutex<Wallet>>) -> Self {
        Self {
            wallet,
            tool_router: Self::tool_router(),
            auth_mode: AuthMode::Http,
        }
    }

    /// Backwards-compatible constructor retained so external callers that
    /// still pass `(wallet, capabilities, provider_label)` keep compiling.
    /// The arguments other than `wallet` are now ignored — the values come
    /// from the per-request [`REQUEST_SESSION`] task-local. New callers
    /// should use [`SaidServer::new_http`].
    #[deprecated(
        since = "0.2.0",
        note = "session-state cross-talk fix: use SaidServer::new_http and set the REQUEST_SESSION task-local from your auth middleware instead"
    )]
    pub fn new_with_auth(
        wallet: Arc<Mutex<Wallet>>,
        _capabilities: Vec<Capability>,
        _provider_label: Option<String>,
    ) -> Self {
        Self::new_http(wallet)
    }

    #[tool(
        name = "said_get_system_prompt",
        description = "Get your portable system prompt by name, or the default if no name is given"
    )]
    async fn get_system_prompt(
        &self,
        Parameters(params): Parameters<GetSystemPromptParams>,
    ) -> Result<CallToolResult, ErrorData> {
        self.check_capability(&Capability::ReadPrompts)?;

        let wallet = self.wallet.lock().unwrap();
        let prompts: Vec<SystemPrompt> = wallet.storage().load("prompts").unwrap_or_default();

        let prompt = if let Some(name) = params.name {
            prompts.into_iter().find(|p| p.name == name)
        } else {
            prompts.into_iter().next()
        };

        match prompt {
            Some(p) => Ok(CallToolResult::success(vec![Content::text(p.content)])),
            None => Ok(CallToolResult::success(vec![Content::text(
                "No system prompt found. Import one with: said import prompts <file>",
            )])),
        }
    }

    #[tool(
        name = "said_get_preferences",
        description = "Get your preferences, optionally filtered by dotted key path"
    )]
    async fn get_preferences(
        &self,
        Parameters(params): Parameters<GetPreferencesParams>,
    ) -> Result<CallToolResult, ErrorData> {
        self.check_capability(&Capability::ReadPreferences)?;

        let wallet = self.wallet.lock().unwrap();
        let prefs: Vec<Preference> = wallet.storage().load("preferences").unwrap_or_default();

        let filtered: Vec<&Preference> = if let Some(path) = &params.path {
            prefs
                .iter()
                .filter(|p| p.key.starts_with(path.as_str()))
                .collect()
        } else {
            prefs.iter().collect()
        };

        let json = serde_json::to_string_pretty(&filtered).unwrap_or_default();
        Ok(CallToolResult::success(vec![Content::text(json)]))
    }

    #[tool(
        name = "said_search_memories",
        description = "Search your memories by keyword"
    )]
    async fn search_memories(
        &self,
        Parameters(params): Parameters<SearchMemoriesParams>,
    ) -> Result<CallToolResult, ErrorData> {
        self.check_capability(&Capability::ReadMemories)?;

        let wallet = self.wallet.lock().unwrap();
        let memories: Vec<Memory> = wallet.storage().load("memories").unwrap_or_default();

        let query_lower = params.query.to_lowercase();
        let limit = params.limit.unwrap_or(10);

        let results: Vec<&Memory> = memories
            .iter()
            .filter(|m| {
                m.content.to_lowercase().contains(&query_lower)
                    || m.tags
                        .iter()
                        .any(|t| t.to_lowercase().contains(&query_lower))
            })
            .take(limit)
            .collect();

        let json = serde_json::to_string_pretty(&results).unwrap_or_default();
        Ok(CallToolResult::success(vec![Content::text(json)]))
    }

    #[tool(
        name = "said_add_memory",
        description = "Persist a new memory fact to your wallet"
    )]
    async fn add_memory(
        &self,
        Parameters(params): Parameters<AddMemoryParams>,
    ) -> Result<CallToolResult, ErrorData> {
        self.check_capability(&Capability::WriteMemories)?;

        let wallet = self.wallet.lock().unwrap();
        let memory = Memory {
            id: uuid::Uuid::new_v4(),
            content: params.content,
            tags: params.tags.unwrap_or_default(),
            source_provider: None,
            created_at: chrono::Utc::now(),
        };

        let value = serde_json::to_value(&memory)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        wallet
            .storage()
            .append_value("memories", value)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

        let json = serde_json::to_string_pretty(&memory).unwrap_or_default();
        Ok(CallToolResult::success(vec![Content::text(json)]))
    }

    #[tool(
        name = "said_search_knowledge",
        description = "Search your knowledge base documents by keyword"
    )]
    async fn search_knowledge(
        &self,
        Parameters(params): Parameters<SearchKnowledgeParams>,
    ) -> Result<CallToolResult, ErrorData> {
        self.check_capability(&Capability::ReadKnowledge)?;

        let wallet = self.wallet.lock().unwrap();
        let docs: Vec<KnowledgeDoc> = wallet.storage().load("knowledge").unwrap_or_default();

        let query_lower = params.query.to_lowercase();
        let limit = params.limit.unwrap_or(10);

        let results: Vec<&KnowledgeDoc> = docs
            .iter()
            .filter(|d| {
                d.title.to_lowercase().contains(&query_lower)
                    || d.content.to_lowercase().contains(&query_lower)
                    || d.tags
                        .iter()
                        .any(|t| t.to_lowercase().contains(&query_lower))
            })
            .take(limit)
            .collect();

        let json = serde_json::to_string_pretty(&results).unwrap_or_default();
        Ok(CallToolResult::success(vec![Content::text(json)]))
    }

    #[tool(
        name = "said_get_conversation_context",
        description = "Get recent conversation context entries"
    )]
    async fn get_conversation_context(
        &self,
        Parameters(params): Parameters<GetConversationContextParams>,
    ) -> Result<CallToolResult, ErrorData> {
        self.check_capability(&Capability::ReadConversations)?;

        let wallet = self.wallet.lock().unwrap();
        let entries: Vec<ConversationEntry> =
            wallet.storage().load("conversations").unwrap_or_default();

        let limit = params.limit.unwrap_or(20);
        let recent: Vec<&ConversationEntry> = entries.iter().rev().take(limit).collect();

        let json = serde_json::to_string_pretty(&recent).unwrap_or_default();
        Ok(CallToolResult::success(vec![Content::text(json)]))
    }

    #[tool(
        name = "said_list_mcp_configs",
        description = "List your other MCP server configurations"
    )]
    async fn list_mcp_configs(&self) -> Result<CallToolResult, ErrorData> {
        self.check_capability(&Capability::ReadMcpConfigs)?;

        let wallet = self.wallet.lock().unwrap();
        let configs: Vec<McpConfig> = wallet.storage().load("mcp_configs").unwrap_or_default();

        let json = serde_json::to_string_pretty(&configs).unwrap_or_default();
        Ok(CallToolResult::success(vec![Content::text(json)]))
    }

    #[tool(
        name = "said_get_relevant_context",
        description = "Get context relevant to the current conversation. Takes a snippet of conversation text and returns the most relevant memories, preferences, and knowledge."
    )]
    async fn get_relevant_context(
        &self,
        Parameters(params): Parameters<GetRelevantContextParams>,
    ) -> Result<CallToolResult, ErrorData> {
        self.check_capability(&Capability::ReadMemories)?;

        let wallet = self.wallet.lock().map_err(|e| {
            ErrorData::internal_error(format!("Failed to lock wallet: {}", e), None)
        })?;
        let context = wallet
            .get_relevant_context(&params.conversation_snippet, params.limit.unwrap_or(10))
            .map_err(|e| ErrorData::internal_error(format!("{}", e), None))?;

        Ok(CallToolResult::success(vec![Content::text(context)]))
    }

    #[tool(
        name = "said_observe",
        description = "Record an observation from a conversation. AI clients should call this to let SAID persist important facts discovered during conversations."
    )]
    async fn observe(
        &self,
        Parameters(params): Parameters<ObserveParams>,
    ) -> Result<CallToolResult, ErrorData> {
        self.check_capability(&Capability::WriteMemories)?;

        let wallet = self.wallet.lock().map_err(|e| {
            ErrorData::internal_error(format!("Failed to lock wallet: {}", e), None)
        })?;
        let memory = Memory {
            id: uuid::Uuid::new_v4(),
            content: params.content,
            tags: vec![format!("role:{}", params.role)],
            source_provider: params.source_provider,
            created_at: chrono::Utc::now(),
        };

        let value = serde_json::to_value(&memory)
            .map_err(|e| ErrorData::internal_error(format!("Serialization error: {}", e), None))?;
        wallet
            .storage()
            .append_value("memories", value)
            .map_err(|e| ErrorData::internal_error(format!("{}", e), None))?;

        Ok(CallToolResult::success(vec![Content::text(format!(
            "Observation recorded with id {}",
            memory.id
        ))]))
    }

    #[tool(
        name = "said_lookup_identity",
        description = "Look up a SAID identity on the Solana blockchain by DID or public key"
    )]
    async fn lookup_identity(
        &self,
        Parameters(params): Parameters<LookupIdentityParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let rpc_url = params
            .rpc_url
            .unwrap_or_else(|| "https://api.devnet.solana.com".to_string());

        let master_pubkey = if params.query.starts_with("did:key:") {
            let vk = said_core::pub_key_from_did_key(&params.query)
                .map_err(|e| ErrorData::internal_error(format!("Invalid DID: {}", e), None))?;
            *vk.as_bytes()
        } else {
            let bytes = bs58::decode(&params.query)
                .into_vec()
                .map_err(|e| ErrorData::internal_error(format!("Invalid base58: {}", e), None))?;
            let arr: [u8; 32] = bytes.try_into().map_err(|_| {
                ErrorData::internal_error("Expected 32-byte public key".to_string(), None)
            })?;
            arr
        };

        match solana_lookup::lookup_identity(&rpc_url, &master_pubkey).await {
            Ok(record) => {
                let json = serde_json::to_string_pretty(&record).unwrap_or_default();
                Ok(CallToolResult::success(vec![Content::text(json)]))
            }
            Err(e) if e.contains("not found") => {
                Ok(CallToolResult::success(vec![Content::text(
                    "Identity not registered on-chain.",
                )]))
            }
            Err(e) => Err(ErrorData::internal_error(e, None)),
        }
    }

    #[tool(
        name = "said_discover_business",
        description = "Discover a business's SAID identity by fetching agents.txt and .well-known/said.json from their domain"
    )]
    async fn discover_business(
        &self,
        Parameters(params): Parameters<DiscoverBusinessParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let client = reqwest::Client::new();
        let discovery =
            said_core::discovery::discover_domain(&client, &params.domain)
                .await
                .map_err(|e| ErrorData::internal_error(format!("{}", e), None))?;

        let json = serde_json::to_string_pretty(&discovery).unwrap_or_default();
        Ok(CallToolResult::success(vec![Content::text(json)]))
    }

    #[tool(
        name = "said_fetch_agents_txt",
        description = "Fetch and parse agents.txt from a domain to discover its SAID identity, services, and auth endpoints"
    )]
    async fn fetch_agents_txt(
        &self,
        Parameters(params): Parameters<FetchAgentsTxtParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let client = reqwest::Client::new();
        let agents_txt =
            said_core::discovery::fetch_agents_txt(&client, &params.domain)
                .await
                .map_err(|e| ErrorData::internal_error(format!("{}", e), None))?;

        let json = serde_json::to_string_pretty(&agents_txt).unwrap_or_default();
        Ok(CallToolResult::success(vec![Content::text(json)]))
    }

    #[tool(
        name = "said_get_public_profile",
        description = "Look up a public SAID profile by DID from the SAID Cloud API"
    )]
    async fn get_public_profile(
        &self,
        Parameters(params): Parameters<GetPublicProfileParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let api_url = params
            .api_url
            .unwrap_or_else(|| "https://api.said.id/v1".to_string());
        let url = format!("{}/profile/{}", api_url, params.did);

        let client = reqwest::Client::new();
        let response = client
            .get(&url)
            .send()
            .await
            .map_err(|e| ErrorData::internal_error(format!("HTTP error: {}", e), None))?;

        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|e| ErrorData::internal_error(format!("Failed to read body: {}", e), None))?;

        if !status.is_success() {
            return Ok(CallToolResult::success(vec![Content::text(format!(
                "Profile lookup failed (HTTP {}): {}",
                status, body
            ))]));
        }

        // Try to pretty-print if it's valid JSON
        let output = match serde_json::from_str::<serde_json::Value>(&body) {
            Ok(val) => serde_json::to_string_pretty(&val).unwrap_or(body),
            Err(_) => body,
        };
        Ok(CallToolResult::success(vec![Content::text(output)]))
    }

    #[tool(
        name = "said_request_service",
        description = "Make an HTTP request to a SAID service endpoint discovered via agents.txt"
    )]
    async fn request_service(
        &self,
        Parameters(params): Parameters<RequestServiceParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let client = reqwest::Client::new();
        let method_str = params.method.as_deref().unwrap_or("GET").to_uppercase();

        let method: reqwest::Method = method_str
            .parse()
            .map_err(|_| ErrorData::internal_error(format!("Invalid HTTP method: {}", method_str), None))?;

        let mut request = client.request(method, &params.url);

        if let Some(auth) = &params.authorization {
            request = request.header("Authorization", auth);
        }

        if let Some(body) = &params.body {
            request = request
                .header("Content-Type", "application/json")
                .body(body.clone());
        }

        let response = request
            .send()
            .await
            .map_err(|e| ErrorData::internal_error(format!("HTTP error: {}", e), None))?;

        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|e| ErrorData::internal_error(format!("Failed to read body: {}", e), None))?;

        // Try to pretty-print if it's valid JSON
        let body_output = match serde_json::from_str::<serde_json::Value>(&body) {
            Ok(val) => serde_json::to_string_pretty(&val).unwrap_or(body),
            Err(_) => body,
        };

        Ok(CallToolResult::success(vec![Content::text(format!(
            "HTTP {} {}\n\n{}",
            status.as_u16(),
            status.canonical_reason().unwrap_or(""),
            body_output
        ))]))
    }

    #[tool(
        name = "said_get_secret",
        description = "Get a secret (API key, token, credential) from your vault by name"
    )]
    async fn get_secret(
        &self,
        Parameters(params): Parameters<GetSecretParams>,
    ) -> Result<CallToolResult, ErrorData> {
        self.check_capability(&Capability::ReadSecrets)?;

        let wallet = self.wallet.lock().unwrap();
        let secrets: Vec<Secret> = wallet.storage().load("secrets").unwrap_or_default();

        match secrets.iter().find(|s| s.name == params.name) {
            Some(secret) => {
                // Enforce per-secret provider restrictions
                if !secret.allowed_providers.is_empty() {
                    if let Some(label) = self.current_provider_label() {
                        if !secret.allowed_providers.iter().any(|p| p == &label) {
                            return Err(ErrorData::internal_error(
                                format!(
                                    "Secret '{}' is not available to provider '{}'",
                                    params.name, label
                                ),
                                None,
                            ));
                        }
                    }
                    // If no provider_label (local stdio mode), allow access — user is at the terminal
                }
                Ok(CallToolResult::success(vec![Content::text(&secret.value)]))
            }
            None => Ok(CallToolResult::success(vec![Content::text(format!(
                "Secret '{}' not found. Available secrets: {}",
                params.name,
                secrets
                    .iter()
                    .map(|s| s.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ))])),
        }
    }

    #[tool(
        name = "said_set_secret",
        description = "Store or update a secret (API key, token, credential) in your vault"
    )]
    async fn set_secret(
        &self,
        Parameters(params): Parameters<SetSecretParams>,
    ) -> Result<CallToolResult, ErrorData> {
        self.check_capability(&Capability::WriteSecrets)?;

        let wallet = self.wallet.lock().unwrap();
        let mut secrets: Vec<Secret> = wallet.storage().load("secrets").unwrap_or_default();

        let now = chrono::Utc::now();
        if let Some(existing) = secrets.iter_mut().find(|s| s.name == params.name) {
            existing.value = params.value;
            if let Some(desc) = params.description {
                existing.description = Some(desc);
            }
            if let Some(tags) = params.tags {
                existing.tags = tags;
            }
            if let Some(providers) = params.allowed_providers {
                existing.allowed_providers = providers;
            }
            existing.updated_at = now;
        } else {
            secrets.push(Secret {
                id: uuid::Uuid::new_v4(),
                name: params.name.clone(),
                value: params.value,
                description: params.description,
                tags: params.tags.unwrap_or_default(),
                allowed_providers: params.allowed_providers.unwrap_or_default(),
                created_at: now,
                updated_at: now,
            });
        }

        wallet
            .storage()
            .save("secrets", &secrets)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

        Ok(CallToolResult::success(vec![Content::text(format!(
            "Secret '{}' saved.",
            params.name
        ))]))
    }

    #[tool(
        name = "said_list_secrets",
        description = "List all secret names in your vault (values are not shown)"
    )]
    async fn list_secrets(&self) -> Result<CallToolResult, ErrorData> {
        self.check_capability(&Capability::ReadSecrets)?;

        let wallet = self.wallet.lock().unwrap();
        let secrets: Vec<Secret> = wallet.storage().load("secrets").unwrap_or_default();

        if secrets.is_empty() {
            return Ok(CallToolResult::success(vec![Content::text(
                "No secrets stored. Add one with said_set_secret or `said secret set <name> <value>`",
            )]));
        }

        let listing: Vec<serde_json::Value> = secrets
            .iter()
            .map(|s| {
                serde_json::json!({
                    "name": s.name,
                    "description": s.description,
                    "tags": s.tags,
                    "allowed_providers": s.allowed_providers,
                    "updated_at": s.updated_at.to_rfc3339(),
                })
            })
            .collect();

        let json = serde_json::to_string_pretty(&listing).unwrap_or_default();
        Ok(CallToolResult::success(vec![Content::text(json)]))
    }

    #[tool(
        name = "said_remove_secret",
        description = "Remove a secret from your vault by name"
    )]
    async fn remove_secret(
        &self,
        Parameters(params): Parameters<RemoveSecretParams>,
    ) -> Result<CallToolResult, ErrorData> {
        self.check_capability(&Capability::WriteSecrets)?;

        let wallet = self.wallet.lock().unwrap();
        let mut secrets: Vec<Secret> = wallet.storage().load("secrets").unwrap_or_default();

        let len_before = secrets.len();
        secrets.retain(|s| s.name != params.name);

        if secrets.len() == len_before {
            return Ok(CallToolResult::success(vec![Content::text(format!(
                "Secret '{}' not found.",
                params.name
            ))]));
        }

        wallet
            .storage()
            .save("secrets", &secrets)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

        Ok(CallToolResult::success(vec![Content::text(format!(
            "Secret '{}' removed.",
            params.name
        ))]))
    }

    // ── Payment Tools ──

    #[tool(
        name = "said_pay_balance",
        description = "Get SOL and USDC balances for an agent wallet or the owner wallet"
    )]
    async fn pay_balance(
        &self,
        Parameters(params): Parameters<PayBalanceParams>,
    ) -> Result<CallToolResult, ErrorData> {
        self.check_capability(&Capability::PayRead)?;

        let rpc_url = params
            .rpc_url
            .unwrap_or_else(|| "https://api.devnet.solana.com".to_string());
        let is_devnet = rpc_url.contains("devnet");

        let (address, label) = {
            let wallet = self.wallet.lock().unwrap();
            if let Some(agent_label) = &params.agent {
                let agent = wallet
                    .find_agent_wallet(agent_label)
                    .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
                (agent.solana_address.clone(), agent.label.clone())
            } else {
                let pubkey = wallet.solana_pubkey_bytes();
                (bs58::encode(&pubkey).into_string(), "owner".to_string())
            }
        };

        let dummy_kp = [0u8; 64]; // We only need RPC reads, not signing
        let client = said_solana::SolanaClient::new(&rpc_url, &dummy_kp)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

        let sol_balance = client
            .get_balance_of(&address)
            .await
            .unwrap_or(0);

        let wallet_bytes = bs58::decode(&address)
            .into_vec()
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let mut wallet_arr = [0u8; 32];
        wallet_arr.copy_from_slice(&wallet_bytes);

        let usdc_mint = if is_devnet {
            said_solana::spl::USDC_MINT_DEVNET
        } else {
            said_solana::spl::USDC_MINT_MAINNET
        };
        let usdc_balance = client
            .get_token_balance(&wallet_arr, &usdc_mint)
            .await
            .unwrap_or(0);

        let output = format!(
            "Wallet: {} ({})\nSOL:  {:.9}\nUSDC: {:.6}",
            label,
            address,
            sol_balance as f64 / 1_000_000_000.0,
            usdc_balance as f64 / 1_000_000.0,
        );
        Ok(CallToolResult::success(vec![Content::text(output)]))
    }

    #[tool(
        name = "said_pay_address",
        description = "Get the Solana deposit address for an agent wallet or the owner wallet"
    )]
    async fn pay_address(
        &self,
        Parameters(params): Parameters<PayAddressParams>,
    ) -> Result<CallToolResult, ErrorData> {
        self.check_capability(&Capability::PayRead)?;

        let wallet = self.wallet.lock().unwrap();

        let (address, label) = if let Some(agent_label) = &params.agent {
            let agent = wallet
                .find_agent_wallet(agent_label)
                .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
            (agent.solana_address.clone(), agent.label.clone())
        } else {
            let pubkey = wallet.solana_pubkey_bytes();
            (bs58::encode(&pubkey).into_string(), "owner".to_string())
        };

        let output = format!("{} address: {}", label, address);
        Ok(CallToolResult::success(vec![Content::text(output)]))
    }

    #[tool(
        name = "said_pay_transfer",
        description = "Send SOL or USDC from an agent wallet, enforcing spending limits"
    )]
    async fn pay_transfer(
        &self,
        Parameters(params): Parameters<PayTransferParams>,
    ) -> Result<CallToolResult, ErrorData> {
        self.check_capability(&Capability::PayTransfer)?;

        let rpc_url = params
            .rpc_url
            .unwrap_or_else(|| "https://api.devnet.solana.com".to_string());
        let is_devnet = rpc_url.contains("devnet");

        let currency_str = params.currency.as_deref().unwrap_or("sol");
        let currency = match currency_str {
            "usdc" => PayCurrency::Usdc,
            _ => PayCurrency::Sol,
        };

        // Parse amount to smallest units
        let amount_float: f64 = params.amount.parse().map_err(|_| {
            ErrorData::internal_error(format!("invalid amount: {}", params.amount), None)
        })?;
        let amount = match currency {
            PayCurrency::Sol => (amount_float * 1_000_000_000.0) as u64,
            PayCurrency::Usdc => (amount_float * 1_000_000.0) as u64,
        };

        let (kp_bytes, agent_id, agent_label, sender) = {
            let wallet = self.wallet.lock().unwrap();
            let agent = wallet
                .find_agent_wallet(&params.agent)
                .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

            // Check allowlist
            wallet
                .check_recipient_allowed(agent.id, &params.to)
                .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

            // Check spending limits
            wallet
                .check_spending_limit(agent.id, &currency, amount)
                .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

            // Derive agent signing key
            let kp = wallet.agent_solana_keypair(agent.index);
            (kp, agent.id, agent.label.clone(), agent.solana_address.clone())
        };

        let client = said_solana::SolanaClient::new(&rpc_url, &kp_bytes)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

        let to_bytes = bs58::decode(&params.to)
            .into_vec()
            .map_err(|e| ErrorData::internal_error(format!("invalid recipient: {}", e), None))?;
        let mut to_arr = [0u8; 32];
        if to_bytes.len() != 32 {
            return Err(ErrorData::internal_error(
                "recipient must be a 32-byte Solana address".to_string(),
                None,
            ));
        }
        to_arr.copy_from_slice(&to_bytes);

        let signature = match currency {
            PayCurrency::Sol => client
                .transfer_sol(&to_arr, amount)
                .await
                .map_err(|e| ErrorData::internal_error(e.to_string(), None))?,
            PayCurrency::Usdc => client
                .transfer_usdc(&to_arr, amount, is_devnet)
                .await
                .map_err(|e| ErrorData::internal_error(e.to_string(), None))?,
        };

        // Log transaction
        let tx = PaymentTransaction {
            id: uuid::Uuid::new_v4(),
            agent_id,
            agent_label: agent_label.clone(),
            direction: TxDirection::Send,
            currency: currency.clone(),
            amount,
            recipient: params.to.clone(),
            sender,
            signature: signature.clone(),
            memo: params.memo.clone(),
            status: TxStatus::Confirmed,
            created_at: chrono::Utc::now(),
        };

        let wallet = self.wallet.lock().unwrap();
        let _ = wallet.log_transaction(tx);

        let explorer = format!("https://explorer.solana.com/tx/{}?cluster=devnet", signature);
        let output = format!(
            "Sent {} {} from '{}' to {}\nTX: {}\nExplorer: {}",
            params.amount, currency_str, agent_label, params.to, signature, explorer
        );
        Ok(CallToolResult::success(vec![Content::text(output)]))
    }

    #[tool(
        name = "said_pay_agents",
        description = "List all agent wallets with their labels, addresses, and spending policies"
    )]
    async fn pay_agents(&self) -> Result<CallToolResult, ErrorData> {
        self.check_capability(&Capability::PayRead)?;

        let wallet = self.wallet.lock().unwrap();
        let agents: Vec<AgentWallet> = wallet
            .list_agent_wallets()
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

        if agents.is_empty() {
            return Ok(CallToolResult::success(vec![Content::text(
                "No agent wallets. Create one with said_pay_create_agent.",
            )]));
        }

        let json = serde_json::to_string_pretty(&agents).unwrap_or_default();
        Ok(CallToolResult::success(vec![Content::text(json)]))
    }

    #[tool(
        name = "said_pay_create_agent",
        description = "Create a new agent wallet with a label and optional spending limits"
    )]
    async fn pay_create_agent(
        &self,
        Parameters(params): Parameters<PayCreateAgentParams>,
    ) -> Result<CallToolResult, ErrorData> {
        self.check_capability(&Capability::PayManage)?;

        fn parse_sol(s: &str) -> Option<u64> {
            s.parse::<f64>().ok().map(|v| (v * 1_000_000_000.0) as u64)
        }
        fn parse_usdc(s: &str) -> Option<u64> {
            s.parse::<f64>().ok().map(|v| (v * 1_000_000.0) as u64)
        }

        let policy = SpendingPolicy {
            daily_limit_lamports: params.daily_sol_limit.as_deref().and_then(parse_sol),
            daily_limit_usdc_micro: params.daily_usdc_limit.as_deref().and_then(parse_usdc),
            per_tx_limit_lamports: params.per_tx_sol_limit.as_deref().and_then(parse_sol),
            per_tx_limit_usdc_micro: params.per_tx_usdc_limit.as_deref().and_then(parse_usdc),
            allowed_recipients: vec![],
        };

        let wallet = self.wallet.lock().unwrap();
        let agent = wallet
            .create_agent_wallet(&params.label, policy)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

        let json = serde_json::to_string_pretty(&agent).unwrap_or_default();
        Ok(CallToolResult::success(vec![Content::text(json)]))
    }

    #[tool(
        name = "said_pay_history",
        description = "View payment transaction history, optionally filtered by agent"
    )]
    async fn pay_history(
        &self,
        Parameters(params): Parameters<PayHistoryParams>,
    ) -> Result<CallToolResult, ErrorData> {
        self.check_capability(&Capability::PayRead)?;

        let wallet = self.wallet.lock().unwrap();
        let limit = params.limit.unwrap_or(20);

        let agent_id = if let Some(agent_label) = &params.agent {
            let agent = wallet
                .find_agent_wallet(agent_label)
                .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
            Some(agent.id)
        } else {
            None
        };

        let txs = wallet
            .transaction_history(agent_id, limit)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

        if txs.is_empty() {
            return Ok(CallToolResult::success(vec![Content::text(
                "No transactions found.",
            )]));
        }

        let json = serde_json::to_string_pretty(&txs).unwrap_or_default();
        Ok(CallToolResult::success(vec![Content::text(json)]))
    }

    #[tool(
        name = "said_pay_limits",
        description = "View spending limits and 24h usage for an agent wallet"
    )]
    async fn pay_limits(
        &self,
        Parameters(params): Parameters<PayLimitsParams>,
    ) -> Result<CallToolResult, ErrorData> {
        self.check_capability(&Capability::PayRead)?;

        let wallet = self.wallet.lock().unwrap();
        let agent = wallet
            .find_agent_wallet(&params.agent)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

        // Get 24h spending
        let txs: Vec<PaymentTransaction> = wallet
            .transaction_history(Some(agent.id), 1000)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

        let twenty_four_hours_ago = chrono::Utc::now() - chrono::Duration::hours(24);

        let sol_spent: u64 = txs
            .iter()
            .filter(|tx| {
                tx.direction == TxDirection::Send
                    && tx.currency == PayCurrency::Sol
                    && tx.created_at > twenty_four_hours_ago
            })
            .map(|tx| tx.amount)
            .sum();

        let usdc_spent: u64 = txs
            .iter()
            .filter(|tx| {
                tx.direction == TxDirection::Send
                    && tx.currency == PayCurrency::Usdc
                    && tx.created_at > twenty_four_hours_ago
            })
            .map(|tx| tx.amount)
            .sum();

        let policy = &agent.spending_policy;
        let mut output = format!("Agent: {} ({})\n", agent.label, agent.solana_address);
        output.push_str(&format!("Active: {}\n\n", agent.active));

        output.push_str("SOL Limits (24h):\n");
        if let Some(daily) = policy.daily_limit_lamports {
            output.push_str(&format!(
                "  Daily:     {:.9} / {:.9} SOL\n",
                sol_spent as f64 / 1e9,
                daily as f64 / 1e9
            ));
        } else {
            output.push_str(&format!("  Daily:     {:.9} SOL (unlimited)\n", sol_spent as f64 / 1e9));
        }
        if let Some(per_tx) = policy.per_tx_limit_lamports {
            output.push_str(&format!("  Per-TX:    {:.9} SOL\n", per_tx as f64 / 1e9));
        }

        output.push_str("\nUSDC Limits (24h):\n");
        if let Some(daily) = policy.daily_limit_usdc_micro {
            output.push_str(&format!(
                "  Daily:     {:.6} / {:.6} USDC\n",
                usdc_spent as f64 / 1e6,
                daily as f64 / 1e6
            ));
        } else {
            output.push_str(&format!("  Daily:     {:.6} USDC (unlimited)\n", usdc_spent as f64 / 1e6));
        }
        if let Some(per_tx) = policy.per_tx_limit_usdc_micro {
            output.push_str(&format!("  Per-TX:    {:.6} USDC\n", per_tx as f64 / 1e6));
        }

        if !policy.allowed_recipients.is_empty() {
            output.push_str(&format!(
                "\nAllowed Recipients: {}\n",
                policy.allowed_recipients.join(", ")
            ));
        }

        Ok(CallToolResult::success(vec![Content::text(output)]))
    }

    #[tool(
        name = "said_spending_status",
        description = "Get the current spending status for an agent wallet: amount spent today, remaining budget, and whether the circuit breaker has tripped after consecutive payment failures. Use said_pay_transfer to unlock after fixing the underlying issue."
    )]
    async fn spending_status(
        &self,
        Parameters(params): Parameters<SpendingStatusParams>,
    ) -> Result<CallToolResult, ErrorData> {
        self.check_capability(&Capability::PayRead)?;

        let wallet = self.wallet.lock().unwrap();
        let agent = wallet
            .find_agent_wallet(&params.agent)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

        let status: SpendingStatus = wallet
            .spending_status(agent.id)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

        let json = serde_json::to_string_pretty(&status)
            .unwrap_or_default();
        Ok(CallToolResult::success(vec![Content::text(json)]))
    }

    // ── Headless Merchant Economy Tools ──

    #[tool(
        name = "said_search_services",
        description = "Search the SAID service registry for headless merchants by task description, category, price, rating, or trust score"
    )]
    async fn search_services(
        &self,
        Parameters(params): Parameters<SearchServicesParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let client = reqwest::Client::new();
        let api_url = params
            .api_url
            .as_deref()
            .unwrap_or("https://ghola-api.onrender.com");

        let mut url = format!("{}/v1/services/resolve?task={}", api_url, params.query);
        if let Some(ref cat) = params.category {
            url.push_str(&format!("&category={}", cat));
        }
        if let Some(ref price) = params.max_price_usdc {
            // Convert human-readable USDC to micro USDC
            let micro: i64 = (price.parse::<f64>().unwrap_or(0.0) * 1_000_000.0) as i64;
            url.push_str(&format!("&max_price_micro_usdc={}", micro));
        }
        if let Some(rating) = params.min_rating {
            url.push_str(&format!("&min_rating={}", rating));
        }
        if let Some(ref region) = params.region {
            url.push_str(&format!("&region={}", region));
        }
        if let Some(limit) = params.limit {
            url.push_str(&format!("&limit={}", limit));
        }

        let resp = client
            .get(&url)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| ErrorData::internal_error(format!("HTTP error: {e}"), None))?;

        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| ErrorData::internal_error(format!("JSON error: {e}"), None))?;

        let output = serde_json::to_string_pretty(&body).unwrap_or_default();
        Ok(CallToolResult::success(vec![Content::text(output)]))
    }

    #[tool(
        name = "said_get_service",
        description = "Get detailed information about a specific service by slug or ID from the SAID registry"
    )]
    async fn get_service(
        &self,
        Parameters(params): Parameters<GetServiceParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let client = reqwest::Client::new();
        let api_url = params
            .api_url
            .as_deref()
            .unwrap_or("https://ghola-api.onrender.com");

        let url = format!("{}/v1/services/{}", api_url, params.slug_or_id);

        let resp = client
            .get(&url)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| ErrorData::internal_error(format!("HTTP error: {e}"), None))?;

        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| ErrorData::internal_error(format!("JSON error: {e}"), None))?;

        let output = serde_json::to_string_pretty(&body).unwrap_or_default();
        Ok(CallToolResult::success(vec![Content::text(output)]))
    }

    #[tool(
        name = "said_verify_agent",
        description = "Verify an agent's identity and capabilities via SAID. Returns trust score, profile info, and UCAN capability check."
    )]
    async fn verify_agent_tool(
        &self,
        Parameters(params): Parameters<VerifyAgentToolParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let client = reqwest::Client::new();
        let api_url = params
            .api_url
            .as_deref()
            .unwrap_or("https://ghola-api.onrender.com");

        let url = format!("{}/v1/verify/agent", api_url);

        let mut body = serde_json::json!({
            "agent_did": params.agent_did,
        });
        if let Some(ref token) = params.ucan_token {
            body["ucan_token"] = serde_json::json!(token);
        }
        if let Some(ref caps) = params.required_capabilities {
            body["required_capabilities"] = serde_json::json!(caps);
        }

        let mut req = client.post(&url).json(&body);
        if let Some(ref key) = params.service_key {
            req = req.header("X-Service-Key", key.as_str());
        }

        let resp = req
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| ErrorData::internal_error(format!("HTTP error: {e}"), None))?;

        let result: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| ErrorData::internal_error(format!("JSON error: {e}"), None))?;

        let output = serde_json::to_string_pretty(&result).unwrap_or_default();
        Ok(CallToolResult::success(vec![Content::text(output)]))
    }

    #[tool(
        name = "said_trust_score",
        description = "Get the reputation/trust score for any DID (agent, business, or service provider)"
    )]
    async fn trust_score(
        &self,
        Parameters(params): Parameters<TrustScoreParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let client = reqwest::Client::new();
        let api_url = params
            .api_url
            .as_deref()
            .unwrap_or("https://ghola-api.onrender.com");

        let url = format!("{}/v1/reputation/{}", api_url, params.did);

        let resp = client
            .get(&url)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| ErrorData::internal_error(format!("HTTP error: {e}"), None))?;

        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| ErrorData::internal_error(format!("JSON error: {e}"), None))?;

        let output = serde_json::to_string_pretty(&body).unwrap_or_default();
        Ok(CallToolResult::success(vec![Content::text(output)]))
    }

    #[tool(
        name = "said_call_service",
        description = "Call a headless merchant's API endpoint. Resolves the service by slug, constructs the request, and returns the response."
    )]
    async fn call_service(
        &self,
        Parameters(params): Parameters<CallServiceParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let client = reqwest::Client::new();
        let api_url = params
            .api_url
            .as_deref()
            .unwrap_or("https://ghola-api.onrender.com");

        // First, resolve the service to get its base_url and endpoints
        let svc_url = format!("{}/v1/services/{}", api_url, params.slug);
        let svc_resp = client
            .get(&svc_url)
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await
            .map_err(|e| ErrorData::internal_error(format!("Service lookup failed: {e}"), None))?;

        let svc_data: serde_json::Value = svc_resp
            .json()
            .await
            .map_err(|e| ErrorData::internal_error(format!("JSON error: {e}"), None))?;

        let service = svc_data.get("service").ok_or_else(|| {
            ErrorData::internal_error("Service not found".to_string(), None)
        })?;

        let base_url = service
            .get("base_url")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                ErrorData::internal_error("Service has no base_url".to_string(), None)
            })?;

        // Build the full endpoint URL
        let endpoint_path = params.endpoint.as_deref().unwrap_or("");
        let full_url = if endpoint_path.starts_with("http") {
            endpoint_path.to_string()
        } else {
            format!(
                "{}/{}",
                base_url.trim_end_matches('/'),
                endpoint_path.trim_start_matches('/')
            )
        };

        // Make the actual service call
        let method = params.method.as_deref().unwrap_or("GET").to_uppercase();
        let mut req = match method.as_str() {
            "POST" => client.post(&full_url),
            "PUT" => client.put(&full_url),
            "DELETE" => client.delete(&full_url),
            "PATCH" => client.patch(&full_url),
            _ => client.get(&full_url),
        };

        if let Some(ref body) = params.body {
            req = req.header("Content-Type", "application/json").body(body.clone());
        }
        if let Some(ref auth) = params.authorization {
            req = req.header("Authorization", auth.as_str());
        }

        let resp = req
            .timeout(std::time::Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| ErrorData::internal_error(format!("Service call failed: {e}"), None))?;

        let status = resp.status().as_u16();
        let body_text = resp
            .text()
            .await
            .unwrap_or_else(|_| "<empty response>".to_string());

        let mut output = format!("HTTP {} from {}\n\n{}", status, full_url, body_text);
        if status >= 400 {
            output = format!("ERROR: HTTP {} from {}\n\n{}", status, full_url, body_text);
        }

        Ok(CallToolResult::success(vec![Content::text(output)]))
    }

    #[tool(
        name = "said_subscribe_service",
        description = "Subscribe an agent wallet to a headless merchant service with an optional daily budget"
    )]
    async fn subscribe_service(
        &self,
        Parameters(params): Parameters<SubscribeServiceParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let client = reqwest::Client::new();
        let api_url = params
            .api_url
            .as_deref()
            .unwrap_or("https://ghola-api.onrender.com");

        // Look up the agent wallet (drop lock before async)
        let (_agent_id, body) = {
            let wallet = self.wallet.lock().unwrap();
            let agents: Vec<AgentWallet> =
                wallet.storage().load("agent_wallets").unwrap_or_default();
            let agent = agents
                .iter()
                .find(|a| a.label == params.agent_label)
                .ok_or_else(|| {
                    ErrorData::internal_error(
                        format!("Agent wallet '{}' not found", params.agent_label),
                        None,
                    )
                })?;

            let daily_budget = params.daily_budget_usdc.as_ref().map(|d| {
                (d.parse::<f64>().unwrap_or(0.0) * 1_000_000.0) as i64
            });

            let id = agent.id;
            let body = serde_json::json!({
                "agent_wallet_id": id,
                "daily_budget_micro_usdc": daily_budget,
            });
            (id, body)
        };

        // We need a JWT for this — inform user if not available
        let url = format!("{}/v1/services/{}/subscribe", api_url, params.service_slug);
        let resp = client
            .post(&url)
            .json(&body)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| ErrorData::internal_error(format!("HTTP error: {e}"), None))?;

        let result: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| ErrorData::internal_error(format!("JSON error: {e}"), None))?;

        let output = serde_json::to_string_pretty(&result).unwrap_or_default();
        Ok(CallToolResult::success(vec![Content::text(output)]))
    }

    #[tool(
        name = "said_pay_x402",
        description = "End-to-end x402 agentic payment: probe a URL for a 402 payment requirement, \
            verify the merchant's trust score via Ghola, enforce the agent's spending policy and \
            recipient allowlist, send USDC on Solana, then retry the original request with payment \
            proof. Returns the service response after payment."
    )]
    async fn pay_x402(
        &self,
        Parameters(params): Parameters<PayX402Params>,
    ) -> Result<CallToolResult, ErrorData> {
        self.check_capability(&Capability::PayTransfer)?;

        let rpc_url = params
            .rpc_url
            .unwrap_or_else(|| "https://api.devnet.solana.com".to_string());
        let is_devnet = rpc_url.contains("devnet");
        let ghola_api = params
            .ghola_api_url
            .unwrap_or_else(|| "https://ghola-api.onrender.com/v1".to_string());
        let min_trust = params.min_trust_score.unwrap_or(0.3);
        let method_str = params.method.as_deref().unwrap_or("GET").to_uppercase();

        // ── Step 1: Probe the URL to obtain the 402 payment terms ──
        let http = reqwest::Client::new();
        let probe_req = {
            let m: reqwest::Method = method_str
                .parse()
                .map_err(|_| ErrorData::internal_error(format!("invalid method: {}", method_str), None))?;
            let mut r = http.request(m.clone(), &params.url);
            if let Some(ref b) = params.body {
                r = r.header("Content-Type", "application/json").body(b.clone());
            }
            r
        };

        let probe_resp = probe_req
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| ErrorData::internal_error(format!("probe request failed: {e}"), None))?;

        let probe_status = probe_resp.status().as_u16();
        if probe_status != 402 {
            // Service responded without requiring payment — return directly
            let body = probe_resp.text().await.unwrap_or_default();
            return Ok(CallToolResult::success(vec![Content::text(format!(
                "HTTP {} (no payment required)\n\n{}",
                probe_status, body
            ))]));
        }

        // Extract PAYMENT-REQUIRED header
        let payment_header = probe_resp
            .headers()
            .get("payment-required")
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| ErrorData::internal_error("Missing PAYMENT-REQUIRED header in 402 response".to_string(), None))?
            .to_string();

        let payment_required = GholaX402Client::parse_payment_required(&payment_header)
            .map_err(|e| ErrorData::internal_error(format!("failed to parse payment terms: {e}"), None))?;

        // ── Step 2: Select the best Solana payment option ──
        let option = payment_required
            .best_solana_option(is_devnet)
            .ok_or_else(|| ErrorData::internal_error("No compatible payment option in 402 response".to_string(), None))?
            .clone();

        let amount_micro_usdc = said_x402::X402PaymentRequired::parse_amount(&option.max_amount_required)
            .ok_or_else(|| ErrorData::internal_error(
                format!("unparseable payment amount: {}", option.max_amount_required), None
            ))?;
        let pay_to = option.pay_to.clone();

        // ── Step 3: Assess merchant trust ──
        let trust_client = GholaX402Client::new(&ghola_api);
        let assessment = trust_client
            .assess_merchant(&pay_to)
            .await
            .map_err(|e| ErrorData::internal_error(format!("trust check failed: {e}"), None))?;

        if assessment.trust_score < min_trust && assessment.recommendation == "reject" {
            return Ok(CallToolResult::success(vec![Content::text(format!(
                "Payment blocked: merchant '{}' has trust score {:.2} (minimum: {:.2})\nReason: {}\nRecommendation: {}",
                pay_to, assessment.trust_score, min_trust, assessment.reason, assessment.recommendation
            ))]));
        }

        // ── Step 4: Enforce spending policy + allowlist ──
        let (kp_bytes, agent_id, agent_label, sender_address) = {
            let wallet = self.wallet.lock().unwrap();
            let agent = wallet
                .find_agent_wallet(&params.agent)
                .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

            // Allowlist check
            wallet
                .check_recipient_allowed(agent.id, &pay_to)
                .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

            // Spending limit check
            wallet
                .check_spending_limit(agent.id, &PayCurrency::Usdc, amount_micro_usdc)
                .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

            let kp = wallet.agent_solana_keypair(agent.index);
            let addr = agent.solana_address.clone();
            (kp, agent.id, agent.label.clone(), addr)
        };

        // ── Step 5: Execute the USDC transfer on Solana ──
        let solana = said_solana::SolanaClient::new(&rpc_url, &kp_bytes)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

        let to_bytes = bs58::decode(&pay_to)
            .into_vec()
            .map_err(|e| ErrorData::internal_error(format!("invalid payTo address: {e}"), None))?;
        if to_bytes.len() != 32 {
            return Err(ErrorData::internal_error("payTo must be a 32-byte Solana address".to_string(), None));
        }
        let mut to_arr = [0u8; 32];
        to_arr.copy_from_slice(&to_bytes);

        let tx_sig = solana
            .transfer_usdc(&to_arr, amount_micro_usdc, is_devnet)
            .await
            .map_err(|e| ErrorData::internal_error(format!("USDC transfer failed: {e}"), None))?;

        // ── Step 6: Log the transaction locally ──
        let tx_record = PaymentTransaction {
            id: uuid::Uuid::new_v4(),
            agent_id,
            agent_label: agent_label.clone(),
            direction: TxDirection::Send,
            currency: PayCurrency::Usdc,
            amount: amount_micro_usdc,
            recipient: pay_to.clone(),
            sender: sender_address,
            signature: tx_sig.clone(),
            memo: params.memo.clone(),
            status: TxStatus::Confirmed,
            created_at: chrono::Utc::now(),
        };
        let _ = self.wallet.lock().unwrap().log_transaction(tx_record);

        // ── Step 7: Build x402-Payment proof header ──
        let network = option.network.clone();
        let sender_pubkey = bs58::encode(&kp_bytes[32..]).into_string();
        let proof = X402PaymentPayload::from_solana_tx(&network, &tx_sig, &sender_pubkey);
        let payment_header_value = proof
            .encode()
            .map_err(|e| ErrorData::internal_error(format!("failed to encode payment proof: {e}"), None))?;

        // ── Step 8: Retry the original request with payment proof ──
        let m: reqwest::Method = method_str
            .parse()
            .map_err(|_| ErrorData::internal_error(format!("invalid method: {}", method_str), None))?;
        let mut retry_req = http
            .request(m, &params.url)
            .header("x402-Payment", &payment_header_value);
        if let Some(ref b) = params.body {
            retry_req = retry_req
                .header("Content-Type", "application/json")
                .body(b.clone());
        }

        let final_resp = retry_req
            .timeout(std::time::Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| ErrorData::internal_error(format!("paid request failed: {e}"), None))?;

        let final_status = final_resp.status().as_u16();
        let final_body = final_resp.text().await.unwrap_or_default();

        // Pretty-print JSON if possible
        let final_output = serde_json::from_str::<serde_json::Value>(&final_body)
            .ok()
            .and_then(|v| serde_json::to_string_pretty(&v).ok())
            .unwrap_or(final_body);

        let summary = format!(
            "Paid {:.6} USDC from '{}' to {}\nTX: {}\nTrust: {} ({:.2})\n\nHTTP {} response:\n{}",
            amount_micro_usdc as f64 / 1_000_000.0,
            agent_label,
            pay_to,
            tx_sig,
            assessment.recommendation,
            assessment.trust_score,
            final_status,
            final_output,
        );

        Ok(CallToolResult::success(vec![Content::text(summary)]))
    }

    #[tool(
        name = "said_verify_x402_merchant",
        description = "Before making an x402 payment, check the merchant's trust score via Ghola. Takes the payTo Solana address and returns identity info, trust score, and a pay/caution/reject recommendation."
    )]
    async fn verify_x402_merchant(
        &self,
        Parameters(params): Parameters<VerifyX402MerchantParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let client = reqwest::Client::new();
        let api_url = params
            .api_url
            .as_deref()
            .unwrap_or("https://ghola-api.onrender.com");

        let url = format!("{}/v1/verify/x402/{}", api_url, params.address);

        let resp = client
            .get(&url)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| ErrorData::internal_error(format!("HTTP error: {e}"), None))?;

        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| ErrorData::internal_error(format!("JSON error: {e}"), None))?;

        let output = serde_json::to_string_pretty(&body).unwrap_or_default();
        Ok(CallToolResult::success(vec![Content::text(output)]))
    }

    // ── Service Discovery Tools ──

    #[tool(
        name = "said_discover_services",
        description = "Discover registered services from the on-chain SAID registry. \
            Queries the Solana program for active ServiceRecord accounts and enriches \
            results with cloud reputation scores. Supports filtering by category, tags, \
            price, and minimum reputation. Falls back to cloud-only search if RPC is unavailable."
    )]
    async fn discover_services(
        &self,
        Parameters(params): Parameters<DiscoverServicesParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let rpc_url = params
            .rpc_url
            .unwrap_or_else(|| "https://api.devnet.solana.com".to_string());
        let api_url = params
            .api_url
            .unwrap_or_else(|| "https://ghola-api.onrender.com".to_string());
        let limit = params.limit.unwrap_or(10);
        let max_price_micro = params.max_price_usdc.as_deref().map(|p| {
            (p.parse::<f64>().unwrap_or(f64::MAX) * 1_000_000.0) as u64
        });
        let min_rep = params.min_reputation.unwrap_or(0.0);
        let http = reqwest::Client::new();

        // 1. Fetch on-chain service accounts (best-effort)
        let on_chain = crate::solana_lookup::list_services(&rpc_url, limit * 4)
            .await
            .unwrap_or_default();

        let mut results: Vec<serde_json::Value> = Vec::new();

        if !on_chain.is_empty() {
            // Enrich each on-chain service with cloud metadata and reputation
            for (pubkey, svc) in &on_chain {
                // Price filter
                if let Some(max) = max_price_micro {
                    if svc.price_micro_usdc > max {
                        continue;
                    }
                }

                // Fetch cloud metadata for category/tag filtering and reputation
                let cloud_resp = http
                    .get(format!("{}/v1/services/{}", api_url, svc.slug))
                    .timeout(std::time::Duration::from_secs(5))
                    .send()
                    .await
                    .ok();
                let cloud_meta: Option<serde_json::Value> = match cloud_resp {
                    Some(r) => r.json().await.ok(),
                    None => None,
                };

                let cloud_service = cloud_meta.as_ref().and_then(|m| m.get("service"));

                // Category filter
                if let Some(ref cat_filter) = params.category {
                    let matches = cloud_service
                        .and_then(|s| s.get("category"))
                        .and_then(|c| c.as_str())
                        .map(|c| c.eq_ignore_ascii_case(cat_filter))
                        .unwrap_or(false);
                    if !matches {
                        continue;
                    }
                }

                // Tags filter
                if let Some(ref tag_filter) = params.tags {
                    if !tag_filter.is_empty() {
                        let svc_tags: Vec<String> = cloud_service
                            .and_then(|s| s.get("tags"))
                            .and_then(|t| serde_json::from_value(t.clone()).ok())
                            .unwrap_or_default();
                        let has_tag = tag_filter.iter().any(|tf| {
                            svc_tags.iter().any(|st| st.eq_ignore_ascii_case(tf))
                        });
                        if !has_tag {
                            continue;
                        }
                    }
                }

                // Fetch on-chain reputation attestation
                let on_chain_rep = {
                    let id_record_bytes = svc.identity_record;
                    crate::solana_lookup::lookup_reputation_attestation(&rpc_url, &id_record_bytes)
                        .await
                        .ok()
                        .flatten()
                };

                // Cloud reputation score (from service metadata or separate endpoint)
                let cloud_rep_score: f32 = cloud_service
                    .and_then(|s| s.get("reputation_score").or_else(|| s.get("trust_score")))
                    .and_then(|v| v.as_f64())
                    .map(|s| s as f32)
                    .unwrap_or(0.0);

                // Prefer on-chain score if available, else use cloud
                let rep_score = on_chain_rep
                    .as_ref()
                    .map(|r| r.score_f32())
                    .filter(|&s| s > 0.0)
                    .unwrap_or(cloud_rep_score);

                if rep_score < min_rep {
                    continue;
                }

                results.push(serde_json::json!({
                    "source": "on_chain",
                    "pda": pubkey,
                    "slug": svc.slug,
                    "base_url": svc.base_url,
                    "registry_url": svc.registry_url,
                    "price_usdc": svc.price_usdc(),
                    "price_micro_usdc": svc.price_micro_usdc,
                    "authority": svc.authority_bs58(),
                    "identity_record_pda": svc.identity_record_bs58(),
                    "active": svc.active,
                    "reputation_score": rep_score,
                    "on_chain_reputation": on_chain_rep.as_ref().map(|r| serde_json::json!({
                        "overall_score": r.score_f32(),
                        "confidence": r.confidence_f32(),
                        "total_transactions": r.total_transactions,
                        "attested_at": r.attested_at,
                    })),
                    "cloud_metadata": cloud_meta,
                }));

                if results.len() >= limit {
                    break;
                }
            }
        }

        // 2. Fall back to cloud-only if on-chain returned nothing
        if results.is_empty() {
            let mut url = format!("{}/v1/services", api_url);
            let mut sep = '?';
            if let Some(ref cat) = params.category {
                url.push_str(&format!("{}category={}", sep, cat));
                sep = '&';
            }
            if let Some(ref tags) = params.tags {
                if !tags.is_empty() {
                    url.push_str(&format!("{}tags={}", sep, tags.join(",")));
                    sep = '&';
                }
            }
            if let Some(ref price) = params.max_price_usdc {
                let micro = (price.parse::<f64>().unwrap_or(0.0) * 1_000_000.0) as i64;
                url.push_str(&format!("{}max_price_micro_usdc={}", sep, micro));
                sep = '&';
            }
            url.push_str(&format!("{}limit={}", sep, limit));

            let resp = http
                .get(&url)
                .timeout(std::time::Duration::from_secs(15))
                .send()
                .await
                .map_err(|e| ErrorData::internal_error(format!("HTTP error: {e}"), None))?;

            let body: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| ErrorData::internal_error(format!("JSON error: {e}"), None))?;

            let output = serde_json::to_string_pretty(&body).unwrap_or_default();
            return Ok(CallToolResult::success(vec![Content::text(format!(
                "(on-chain registry empty or unavailable — cloud results)\n\n{}",
                output
            ))]));
        }

        // Sort by reputation descending
        results.sort_by(|a, b| {
            let sa = a.get("reputation_score").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let sb = b.get("reputation_score").and_then(|v| v.as_f64()).unwrap_or(0.0);
            sb.partial_cmp(&sa).unwrap_or(std::cmp::Ordering::Equal)
        });

        let output = serde_json::to_string_pretty(&serde_json::json!({
            "count": results.len(),
            "services": results,
        }))
        .unwrap_or_default();
        Ok(CallToolResult::success(vec![Content::text(output)]))
    }

    #[tool(
        name = "said_evaluate_service",
        description = "Evaluate the trustworthiness of a service before paying. \
            Checks on-chain reputation attestation, delegation records, and cloud reputation scores. \
            Returns a composite trust assessment with recommendation: pay / caution / reject."
    )]
    async fn evaluate_service(
        &self,
        Parameters(params): Parameters<EvaluateServiceParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let api_url = params
            .api_url
            .unwrap_or_else(|| "https://ghola-api.onrender.com".to_string());
        let rpc_url = params
            .rpc_url
            .unwrap_or_else(|| "https://api.devnet.solana.com".to_string());
        let http = reqwest::Client::new();

        // 1. Fetch service metadata from cloud registry
        let svc_resp = http
            .get(format!("{}/v1/services/{}", api_url, params.slug))
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await
            .map_err(|e| ErrorData::internal_error(format!("Service lookup failed: {e}"), None))?;

        let svc_data: serde_json::Value = svc_resp
            .json()
            .await
            .map_err(|e| ErrorData::internal_error(format!("JSON error: {e}"), None))?;

        let service = svc_data.get("service").ok_or_else(|| {
            ErrorData::internal_error(
                format!("Service '{}' not found in registry", params.slug),
                None,
            )
        })?;

        let provider_did = service
            .get("provider_did")
            .or_else(|| service.get("did"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let base_url = service
            .get("base_url")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        // 2. Fetch cloud reputation
        let (cloud_score, cloud_confidence, cloud_components) = if !provider_did.is_empty() {
            let rep_resp = http
                .get(format!("{}/v1/reputation/{}", api_url, provider_did))
                .timeout(std::time::Duration::from_secs(10))
                .send()
                .await
                .ok();
            let rep_data: serde_json::Value = match rep_resp {
                Some(r) => r.json().await.unwrap_or_default(),
                None => serde_json::Value::Null,
            };
            let score = rep_data.get("overall_score").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32;
            let conf = rep_data.get("confidence").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32;
            let components = rep_data.get("components").cloned();
            (score, conf, components)
        } else {
            (0.0f32, 0.0f32, None)
        };

        // 3. Check on-chain reputation attestation via identity_pda in cloud resolve response
        let on_chain_attestation = if !provider_did.is_empty() {
            let resolve_resp = http
                .get(format!("{}/v1/resolve/{}", api_url, provider_did))
                .timeout(std::time::Duration::from_secs(5))
                .send()
                .await
                .ok();
            let resolve_data: Option<serde_json::Value> = match resolve_resp {
                Some(r) => r.json().await.ok(),
                None => None,
            };

            // If the cloud resolve response has an identity_pda, look up on-chain attestation
            let pda_bytes: Option<[u8; 32]> = resolve_data
                .as_ref()
                .and_then(|v| v.get("identity_pda"))
                .and_then(|p| p.as_str())
                .and_then(|pda_b58| bs58::decode(pda_b58).into_vec().ok())
                .and_then(|bytes| {
                    if bytes.len() == 32 {
                        let mut arr = [0u8; 32];
                        arr.copy_from_slice(&bytes);
                        Some(arr)
                    } else {
                        None
                    }
                });

            if let Some(pda) = pda_bytes {
                crate::solana_lookup::lookup_reputation_attestation(&rpc_url, &pda)
                    .await
                    .ok()
                    .flatten()
            } else {
                None
            }
        } else {
            None
        };

        // 4. Delegation records count
        let delegation_count = svc_data
            .get("delegations")
            .and_then(|d| d.as_array())
            .map(|d| d.len())
            .unwrap_or(0);

        // 5. Composite trust score
        let identity_found = !provider_did.is_empty();
        let verified_badge = service.get("verified").and_then(|v| v.as_bool()).unwrap_or(false);
        let on_chain_registered = on_chain_attestation.is_some()
            || service.get("on_chain_registered").and_then(|v| v.as_bool()).unwrap_or(false);

        let mut composite_score = on_chain_attestation
            .as_ref()
            .map(|a| a.score_f32())
            .filter(|&s| s > 0.0)
            .unwrap_or(cloud_score);
        if verified_badge {
            composite_score = (composite_score + 0.1).min(1.0);
        }
        if on_chain_registered {
            composite_score = (composite_score + 0.05).min(1.0);
        }
        if delegation_count > 0 {
            composite_score = (composite_score + 0.05).min(1.0);
        }

        let (recommendation, reason) = if !identity_found {
            ("caution", "Service has no verifiable DID. Unverified provider — proceed with caution.")
        } else if composite_score >= 0.7 {
            ("pay", "Service is verified with good reputation. Safe to proceed.")
        } else if composite_score >= 0.3 {
            ("caution", "Service found but reputation is moderate. Consider the amount before proceeding.")
        } else {
            ("reject", "Service has low reputation score. Payment not recommended.")
        };

        let assessment = serde_json::json!({
            "slug": params.slug,
            "base_url": base_url,
            "provider_did": provider_did,
            "identity_found": identity_found,
            "verified_badge": verified_badge,
            "on_chain_registered": on_chain_registered,
            "on_chain_attestation": on_chain_attestation.as_ref().map(|a| serde_json::json!({
                "overall_score": a.score_f32(),
                "confidence": a.confidence_f32(),
                "total_transactions": a.total_transactions,
                "attested_at": a.attested_at,
            })),
            "delegation_count": delegation_count,
            "cloud_reputation": {
                "overall_score": cloud_score,
                "confidence": cloud_confidence,
                "components": cloud_components,
            },
            "composite_trust_score": composite_score,
            "confidence": cloud_confidence,
            "recommendation": recommendation,
            "reason": reason,
            "service_metadata": service,
        });

        let output = serde_json::to_string_pretty(&assessment).unwrap_or_default();
        Ok(CallToolResult::success(vec![Content::text(output)]))
    }

    #[tool(
        name = "said_discover_and_pay",
        description = "Full autonomous service-discovery → trust-evaluation → x402-payment flow in one call. \
            Discovers services matching a task description, ranks by reputation, evaluates the top \
            candidate, executes a USDC x402 payment if the trust threshold is met, and returns the \
            service response. Enforces agent spending limits throughout."
    )]
    async fn discover_and_pay(
        &self,
        Parameters(params): Parameters<DiscoverAndPayParams>,
    ) -> Result<CallToolResult, ErrorData> {
        self.check_capability(&Capability::PayTransfer)?;

        let rpc_url = params
            .rpc_url
            .clone()
            .unwrap_or_else(|| "https://api.devnet.solana.com".to_string());
        let api_url = params
            .api_url
            .clone()
            .unwrap_or_else(|| "https://ghola-api.onrender.com".to_string());
        let min_trust = params.min_trust_score.unwrap_or(0.5);
        let is_devnet = rpc_url.contains("devnet");
        let http = reqwest::Client::new();

        // ── Step 1: Discover matching services ────────────────────────────────
        let mut discover_url = format!("{}/v1/services/resolve?task={}", api_url, params.task);
        if let Some(ref cat) = params.category {
            discover_url.push_str(&format!("&category={}", cat));
        }
        if let Some(ref max_price) = params.max_price_usdc {
            let micro = (max_price.parse::<f64>().unwrap_or(0.0) * 1_000_000.0) as i64;
            discover_url.push_str(&format!("&max_price_micro_usdc={}", micro));
        }
        discover_url.push_str("&limit=5");

        let discover_data: serde_json::Value = http
            .get(&discover_url)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| ErrorData::internal_error(format!("Discovery failed: {e}"), None))?
            .json()
            .await
            .map_err(|e| ErrorData::internal_error(format!("Discovery JSON error: {e}"), None))?;

        let top_slug = discover_data
            .get("services")
            .and_then(|s| s.as_array())
            .and_then(|arr| arr.first())
            .and_then(|svc| svc.get("slug").or_else(|| svc.get("id")))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| {
                ErrorData::internal_error(
                    format!("No services found matching: '{}'", params.task),
                    None,
                )
            })?;

        // ── Step 2: Fetch service details ─────────────────────────────────────
        let svc_data: serde_json::Value = http
            .get(format!("{}/v1/services/{}", api_url, top_slug))
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await
            .map_err(|e| ErrorData::internal_error(format!("Service lookup failed: {e}"), None))?
            .json()
            .await
            .map_err(|e| ErrorData::internal_error(format!("JSON error: {e}"), None))?;

        let service = svc_data.get("service").ok_or_else(|| {
            ErrorData::internal_error(format!("Service '{}' metadata missing", top_slug), None)
        })?;

        let base_url = service
            .get("base_url")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ErrorData::internal_error("Service has no base_url".to_string(), None))?
            .to_string();

        let provider_did = service
            .get("provider_did")
            .or_else(|| service.get("did"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let price_micro_usdc = service
            .get("price_micro_usdc")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);

        // ── Step 3: Evaluate trust ─────────────────────────────────────────────
        let trust_score: f32 = if !provider_did.is_empty() {
            let rep_resp = http
                .get(format!("{}/v1/reputation/{}", api_url, provider_did))
                .timeout(std::time::Duration::from_secs(8))
                .send()
                .await
                .ok();
            let rep_data: serde_json::Value = match rep_resp {
                Some(r) => r.json().await.unwrap_or_default(),
                None => serde_json::Value::Null,
            };
            rep_data.get("overall_score").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32
        } else {
            0.0
        };

        if trust_score < min_trust {
            return Ok(CallToolResult::success(vec![Content::text(format!(
                "ABORTED: Service '{}' trust score ({:.2}) is below minimum ({:.2}).\n\
                 Provider: {}\n\
                 Run said_evaluate_service for a full breakdown.",
                top_slug, trust_score, min_trust, provider_did
            ))]));
        }

        // ── Step 4: Spending limit check ───────────────────────────────────────
        let (kp_bytes, agent_id, agent_label, sender) = {
            let wallet = self.wallet.lock().unwrap();
            let agent = wallet
                .find_agent_wallet(&params.agent)
                .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
            wallet
                .check_spending_limit(agent.id, &PayCurrency::Usdc, price_micro_usdc)
                .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
            let kp = wallet.agent_solana_keypair(agent.index);
            (kp, agent.id, agent.label.clone(), agent.solana_address.clone())
        };

        // ── Step 5: Initial service call (may return 402) ─────────────────────
        let endpoint_url = base_url.trim_end_matches('/').to_string();
        let initial_resp = if let Some(ref body) = params.request_body {
            http.post(&endpoint_url)
                .header("Content-Type", "application/json")
                .body(body.clone())
        } else {
            http.get(&endpoint_url)
        }
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| ErrorData::internal_error(format!("Service call failed: {e}"), None))?;

        let status = initial_resp.status().as_u16();

        if status == 402 {
            // ── x402: Parse PAYMENT-REQUIRED header ───────────────────────────
            let payment_header = initial_resp
                .headers()
                .get("payment-required")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());

            let pay_to = if let Some(ref header) = payment_header {
                use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
                B64.decode(header)
                    .ok()
                    .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
                    .and_then(|v| {
                        v.get("accepts")
                            .and_then(|a| a.as_array())
                            .and_then(|arr| arr.first())
                            .and_then(|opt| opt.get("payTo"))
                            .and_then(|pt| pt.as_str())
                            .map(|s| s.to_string())
                    })
            } else {
                None
            }
            .ok_or_else(|| {
                ErrorData::internal_error(
                    "Service returned 402 but PAYMENT-REQUIRED header is missing or malformed"
                        .to_string(),
                    None,
                )
            })?;

            // ── x402: Execute USDC payment ────────────────────────────────────
            let to_bytes = bs58::decode(&pay_to)
                .into_vec()
                .map_err(|e| ErrorData::internal_error(format!("Invalid payTo: {e}"), None))?;
            if to_bytes.len() != 32 {
                return Err(ErrorData::internal_error("payTo must be 32 bytes".to_string(), None));
            }
            let mut to_arr = [0u8; 32];
            to_arr.copy_from_slice(&to_bytes);

            let solana = said_solana::SolanaClient::new(&rpc_url, &kp_bytes)
                .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

            let signature = solana
                .transfer_usdc(&to_arr, price_micro_usdc, is_devnet)
                .await
                .map_err(|e| ErrorData::internal_error(format!("Payment failed: {e}"), None))?;

            // Log the payment transaction
            {
                let wallet = self.wallet.lock().unwrap();
                let _ = wallet.log_transaction(PaymentTransaction {
                    id: uuid::Uuid::new_v4(),
                    agent_id,
                    agent_label: agent_label.clone(),
                    direction: TxDirection::Send,
                    currency: PayCurrency::Usdc,
                    amount: price_micro_usdc,
                    recipient: pay_to.clone(),
                    sender,
                    signature: signature.clone(),
                    memo: Some(format!("x402 payment for service: {}", top_slug)),
                    status: TxStatus::Confirmed,
                    created_at: chrono::Utc::now(),
                });
            }

            // ── x402: Re-call service with payment proof ──────────────────────
            let paid_resp = if let Some(ref body) = params.request_body {
                http.post(&endpoint_url)
                    .header("Content-Type", "application/json")
                    .header("X-Payment-Signature", &signature)
                    .body(body.clone())
            } else {
                http.get(&endpoint_url)
                    .header("X-Payment-Signature", &signature)
            }
            .timeout(std::time::Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| {
                ErrorData::internal_error(format!("Post-payment call failed: {e}"), None)
            })?;

            let paid_status = paid_resp.status().as_u16();
            let paid_body = paid_resp.text().await.unwrap_or_else(|_| "<empty>".into());

            Ok(CallToolResult::success(vec![Content::text(format!(
                "=== said_discover_and_pay: SUCCESS ===\n\n\
                 Service:       {slug}\n\
                 Base URL:      {base_url}\n\
                 Trust Score:   {trust:.2}\n\
                 Payment:       {price:.6} USDC → {pay_to}\n\
                 TX Signature:  {sig}\n\
                 Explorer:      https://explorer.solana.com/tx/{sig}?cluster=devnet\n\n\
                 --- Service Response (HTTP {code}) ---\n{body}",
                slug = top_slug,
                base_url = base_url,
                trust = trust_score,
                price = price_micro_usdc as f64 / 1_000_000.0,
                pay_to = pay_to,
                sig = signature,
                code = paid_status,
                body = paid_body,
            ))]))
        } else {
            // Service responded directly — no payment needed
            let body_text = initial_resp.text().await.unwrap_or_else(|_| "<empty>".into());
            Ok(CallToolResult::success(vec![Content::text(format!(
                "=== said_discover_and_pay: Direct response (no x402) ===\n\n\
                 Service:     {slug}\n\
                 Base URL:    {base_url}\n\
                 Trust Score: {trust:.2}\n\
                 HTTP {code}\n\n{body}",
                slug = top_slug,
                base_url = base_url,
                trust = trust_score,
                code = status,
                body = body_text,
            ))]))
        }
    }

    // ── Enterprise tools ──────────────────────────────────────────────────────

    #[tool(
        name = "said_audit_log",
        description = "Query the tamper-evident audit trail for a tenant. Returns structured audit events \
                       (wallet ops, payments, policy changes, circuit breaker trips, UCAN delegations). \
                       Each event is part of a SHA-256 hash chain so any gap or mutation is detectable. \
                       Useful for compliance reviews, incident investigations, and SOC 2 evidence export.\n\n\
                       Parameters:\n\
                       - tenant_id: filter to a specific tenant (UUID)\n\
                       - event_type: e.g. 'payment', 'wallet_op', 'ucan_delegation', 'circuit_breaker', 'settlement_completed'\n\
                       - since: ISO-8601 start time (e.g. '2025-01-01T00:00:00Z')\n\
                       - limit: max results (default 50)\n\
                       - token: your SAID bearer JWT"
    )]
    async fn audit_log(
        &self,
        Parameters(params): Parameters<AuditLogParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let client = reqwest::Client::new();
        let api_url = params
            .api_url
            .as_deref()
            .unwrap_or("https://ghola-api.onrender.com");

        let mut query_params: Vec<(&str, String)> = Vec::new();
        if let Some(ref tid) = params.tenant_id {
            query_params.push(("tenant_id", tid.clone()));
        }
        if let Some(ref et) = params.event_type {
            query_params.push(("event_type", et.clone()));
        }
        if let Some(ref did) = params.actor_did {
            query_params.push(("actor_did", did.clone()));
        }
        if let Some(ref since) = params.since {
            query_params.push(("since", since.clone()));
        }
        if let Some(limit) = params.limit {
            query_params.push(("limit", limit.to_string()));
        }

        let mut req = client
            .get(format!("{api_url}/v1/audit"))
            .query(&query_params)
            .timeout(std::time::Duration::from_secs(15));

        if let Some(ref token) = params.token {
            req = req.header("Authorization", format!("Bearer {token}"));
        }

        let resp = req
            .send()
            .await
            .map_err(|e| ErrorData::internal_error(format!("HTTP error: {e}"), None))?;

        let status = resp.status();
        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| ErrorData::internal_error(format!("JSON error: {e}"), None))?;

        if !status.is_success() {
            let msg = body
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown error");
            return Err(ErrorData::internal_error(
                format!("Audit API error {status}: {msg}"),
                None,
            ));
        }

        let output = serde_json::to_string_pretty(&body).unwrap_or_default();
        Ok(CallToolResult::success(vec![Content::text(output)]))
    }

    #[tool(
        name = "said_treasury_status",
        description = "Check treasury pool balances, department budget allocations, and spending for a \
                       tenant. Returns funding wallet address, total/allocated/spent amounts (in micro-USDC, \
                       where 1 USDC = 1,000,000 micro-USDC), approval threshold, and per-department budgets.\n\n\
                       Parameters:\n\
                       - tenant_id: the tenant UUID to query (required)\n\
                       - pool_id: specific pool UUID — omit to list all pools\n\
                       - token: your SAID bearer JWT"
    )]
    async fn treasury_status(
        &self,
        Parameters(params): Parameters<TreasuryStatusParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let client = reqwest::Client::new();
        let api_url = params
            .api_url
            .as_deref()
            .unwrap_or("https://ghola-api.onrender.com");

        let mut req_builder = if let Some(ref pool_id) = params.pool_id {
            client
                .get(format!("{api_url}/v1/treasury/pools/{pool_id}"))
                .timeout(std::time::Duration::from_secs(15))
        } else {
            client
                .get(format!("{api_url}/v1/treasury/pools"))
                .query(&[("tenant_id", &params.tenant_id)])
                .timeout(std::time::Duration::from_secs(15))
        };

        if let Some(ref token) = params.token {
            req_builder = req_builder.header("Authorization", format!("Bearer {token}"));
        }

        let resp = req_builder
            .send()
            .await
            .map_err(|e| ErrorData::internal_error(format!("HTTP error: {e}"), None))?;

        let status = resp.status();
        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| ErrorData::internal_error(format!("JSON error: {e}"), None))?;

        if !status.is_success() {
            let msg = body
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown error");
            return Err(ErrorData::internal_error(
                format!("Treasury API error {status}: {msg}"),
                None,
            ));
        }

        let enrich = |v: &serde_json::Value| -> serde_json::Value {
            let mut out = v.clone();
            for field in &[
                "total_budget_micro_usdc",
                "allocated_micro_usdc",
                "spent_micro_usdc",
                "approval_threshold_micro_usdc",
            ] {
                if let Some(micro) = v.get(field).and_then(|x| x.as_i64()) {
                    let key = field.replace("micro_usdc", "usdc");
                    out[key] = serde_json::json!(micro as f64 / 1_000_000.0);
                }
            }
            out
        };

        let enriched = match &body {
            serde_json::Value::Array(pools) => {
                serde_json::Value::Array(pools.iter().map(enrich).collect())
            }
            other => enrich(other),
        };

        let output = serde_json::to_string_pretty(&enriched).unwrap_or_default();
        Ok(CallToolResult::success(vec![Content::text(output)]))
    }

    #[tool(
        name = "said_request_approval",
        description = "Submit a treasury payment approval request. Payments below the pool's approval \
                       threshold are auto-approved immediately. Payments above the threshold are queued \
                       for review by a tenant admin.\n\n\
                       Returns the approval request object with its status ('pending' or 'approved'), \
                       ID, and amount. If auto-approved, the payment can proceed immediately using \
                       said_pay_transfer. If pending, poll said_treasury_status or wait for admin action.\n\n\
                       Parameters:\n\
                       - treasury_pool_id: UUID of the funding pool\n\
                       - tenant_id: UUID of the tenant\n\
                       - amount_micro_usdc: amount in micro-USDC (1 USDC = 1,000,000)\n\
                       - recipient_address: Solana address to pay\n\
                       - purpose: human-readable reason for the payment\n\
                       - token: your SAID bearer JWT"
    )]
    async fn request_approval(
        &self,
        Parameters(params): Parameters<RequestApprovalParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let client = reqwest::Client::new();
        let api_url = params
            .api_url
            .as_deref()
            .unwrap_or("https://ghola-api.onrender.com");

        let body = serde_json::json!({
            "treasury_pool_id": params.treasury_pool_id,
            "tenant_id": params.tenant_id,
            "amount_micro_usdc": params.amount_micro_usdc,
            "recipient_address": params.recipient_address,
            "purpose": params.purpose,
        });

        let mut req = client
            .post(format!("{api_url}/v1/treasury/requests"))
            .json(&body)
            .timeout(std::time::Duration::from_secs(15));

        if let Some(ref token) = params.token {
            req = req.header("Authorization", format!("Bearer {token}"));
        }

        let resp = req
            .send()
            .await
            .map_err(|e| ErrorData::internal_error(format!("HTTP error: {e}"), None))?;

        let status = resp.status();
        let resp_body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| ErrorData::internal_error(format!("JSON error: {e}"), None))?;

        if !status.is_success() {
            let msg = resp_body
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown error");
            return Err(ErrorData::internal_error(
                format!("Treasury request error {status}: {msg}"),
                None,
            ));
        }

        let approval_status = resp_body
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");

        let summary = if approval_status == "approved" {
            format!(
                "Approval request auto-approved (below threshold). \
                 Amount: {} micro-USDC ({:.6} USDC). \
                 Proceed with said_pay_transfer to execute the payment.",
                params.amount_micro_usdc,
                params.amount_micro_usdc as f64 / 1_000_000.0,
            )
        } else {
            format!(
                "Approval request submitted (pending admin review). \
                 Amount: {} micro-USDC ({:.6} USDC). \
                 A tenant admin must approve before the payment can be executed.",
                params.amount_micro_usdc,
                params.amount_micro_usdc as f64 / 1_000_000.0,
            )
        };

        let output = format!(
            "{}\n\n{}",
            summary,
            serde_json::to_string_pretty(&resp_body).unwrap_or_default()
        );

        Ok(CallToolResult::success(vec![Content::text(output)]))
    }
}

#[tool_handler]
impl ServerHandler for SaidServer {
    fn get_info(&self) -> ServerInfo {
        let mut info = ServerInfo::default();
        info.instructions = Some(
            "SAID (Sovereign AI Identity) wallet. Access your portable system prompts, \
             memories, preferences, and knowledge base across any AI provider."
                .into(),
        );
        info.capabilities = ServerCapabilities::builder().enable_tools().build();
        info
    }
}

/// Run the MCP server on stdio, loading the wallet from the default directory.
pub async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let wallet_dir = Wallet::default_wallet_dir()?;
    let wallet = Wallet::load(&wallet_dir, None)?;
    let server = SaidServer::new(wallet);

    let service = server.serve(stdio()).await?;
    service.waiting().await?;
    Ok(())
}

#[cfg(test)]
mod auth_tests {
    use super::*;
    use std::sync::Arc;
    use tempfile::TempDir;

    fn fresh_http_server() -> SaidServer {
        let dir = TempDir::new().unwrap();
        let wallet_dir = dir.path().join(".said");
        let (wallet, _phrase) = Wallet::init(&wallet_dir, None).unwrap();
        // Keep the TempDir alive by leaking it into the wallet — fine for tests.
        std::mem::forget(dir);
        SaidServer::new_http(Arc::new(Mutex::new(wallet)))
    }

    #[test]
    fn http_mode_without_session_denies() {
        let server = fresh_http_server();
        let r = server.check_capability(&Capability::ReadPrompts);
        assert!(r.is_err(), "HTTP server with no REQUEST_SESSION must fail closed");
    }

    #[test]
    fn stdio_mode_allows_everything() {
        let dir = TempDir::new().unwrap();
        let wallet_dir = dir.path().join(".said");
        let (wallet, _) = Wallet::init(&wallet_dir, None).unwrap();
        let server = SaidServer::new(wallet);

        for cap in [
            Capability::ReadPrompts,
            Capability::WriteMemories,
            Capability::ReadMemories,
        ] {
            assert!(server.check_capability(&cap).is_ok());
        }
    }

    #[tokio::test]
    async fn task_local_isolates_concurrent_sessions() {
        // The regression test for the cross-talk bug: two concurrent
        // requests with disjoint capabilities must not see each other's
        // grants. Before the fix, a shared Arc<Mutex<Option<...>>> could
        // hand session B's caps to session A's tool dispatch.
        let server = Arc::new(fresh_http_server());

        let server_a = server.clone();
        let task_a = tokio::spawn(async move {
            let session = RequestSession {
                capabilities: vec![Capability::ReadPrompts],
                provider_label: Some("alpha".into()),
                issuer_did: None,
            };
            REQUEST_SESSION
                .scope(session, async move {
                    // Yield so task B has a chance to set its own scope.
                    tokio::task::yield_now().await;
                    let read_prompts =
                        server_a.check_capability(&Capability::ReadPrompts).is_ok();
                    let write_memories =
                        server_a.check_capability(&Capability::WriteMemories).is_ok();
                    (read_prompts, write_memories, server_a.current_provider_label())
                })
                .await
        });

        let server_b = server.clone();
        let task_b = tokio::spawn(async move {
            let session = RequestSession {
                capabilities: vec![Capability::WriteMemories],
                provider_label: Some("beta".into()),
                issuer_did: None,
            };
            REQUEST_SESSION
                .scope(session, async move {
                    tokio::task::yield_now().await;
                    let read_prompts =
                        server_b.check_capability(&Capability::ReadPrompts).is_ok();
                    let write_memories =
                        server_b.check_capability(&Capability::WriteMemories).is_ok();
                    (read_prompts, write_memories, server_b.current_provider_label())
                })
                .await
        });

        let (a_read, a_write, a_label) = task_a.await.unwrap();
        let (b_read, b_write, b_label) = task_b.await.unwrap();

        assert!(a_read, "session A should be able to ReadPrompts");
        assert!(!a_write, "session A must NOT see session B's WriteMemories");
        assert_eq!(a_label.as_deref(), Some("alpha"));

        assert!(b_write, "session B should be able to WriteMemories");
        assert!(!b_read, "session B must NOT see session A's ReadPrompts");
        assert_eq!(b_label.as_deref(), Some("beta"));
    }
}

/// Run the MCP server over HTTP with UCAN auth on the given port.
pub async fn run_http(wallet: Wallet, port: u16) -> Result<(), Box<dyn std::error::Error>> {
    http::run_http_server(wallet, port).await
}
