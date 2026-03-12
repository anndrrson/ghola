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
    Capability, ConversationEntry, KnowledgeDoc, McpConfig, Memory, Preference, Secret,
    SystemPrompt,
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
