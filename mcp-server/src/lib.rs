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
    PaymentTransaction, Preference, Secret, SpendingPolicy, SystemPrompt, TxDirection, TxStatus,
};

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

// ── MCP Server ──

#[derive(Clone)]
pub struct SaidServer {
    wallet: Arc<Mutex<Wallet>>,
    tool_router: ToolRouter<Self>,
    /// When Some, capability checks are enforced (HTTP mode).
    /// When None, all tools are allowed (stdio / local trust mode).
    allowed_capabilities: Option<Vec<Capability>>,
    /// The provider label from the authenticated session (HTTP mode only).
    /// Used to enforce per-secret `allowed_providers` restrictions.
    provider_label: Option<String>,
}

impl SaidServer {
    /// Check that the current session has the required capability.
    /// In stdio mode (allowed_capabilities = None), always succeeds.
    fn check_capability(&self, cap: &Capability) -> Result<(), ErrorData> {
        if let Some(ref caps) = self.allowed_capabilities {
            if !caps.iter().any(|c| c.grants(cap)) {
                return Err(ErrorData::internal_error(
                    format!("insufficient capability: {:?}", cap),
                    None,
                ));
            }
        }
        Ok(())
    }
}

#[tool_router]
impl SaidServer {
    /// Create a new server in stdio mode (no auth, all tools allowed).
    pub fn new(wallet: Wallet) -> Self {
        Self {
            wallet: Arc::new(Mutex::new(wallet)),
            tool_router: Self::tool_router(),
            allowed_capabilities: None,
            provider_label: None,
        }
    }

    /// Create a new server with shared wallet, specific capabilities, and provider label (HTTP auth mode).
    pub fn new_with_auth(
        wallet: Arc<Mutex<Wallet>>,
        capabilities: Vec<Capability>,
        provider_label: Option<String>,
    ) -> Self {
        Self {
            wallet,
            tool_router: Self::tool_router(),
            allowed_capabilities: Some(capabilities),
            provider_label,
        }
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
                    if let Some(ref label) = self.provider_label {
                        if !secret.allowed_providers.iter().any(|p| p == label) {
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
        let (agent_id, body) = {
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
}

#[tool_handler]
impl ServerHandler for SaidServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            instructions: Some(
                "SAID (Sovereign AI Identity) wallet. Access your portable system prompts, \
                 memories, preferences, and knowledge base across any AI provider."
                    .into(),
            ),
            capabilities: ServerCapabilities::builder().enable_tools().build(),
            ..Default::default()
        }
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

/// Run the MCP server over HTTP with UCAN auth on the given port.
pub async fn run_http(wallet: Wallet, port: u16) -> Result<(), Box<dyn std::error::Error>> {
    http::run_http_server(wallet, port).await
}
