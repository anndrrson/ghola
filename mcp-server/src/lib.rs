pub mod http;

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
    Capability, ConversationEntry, KnowledgeDoc, McpConfig, Memory, Preference, SystemPrompt,
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

// ── MCP Server ──

#[derive(Clone)]
pub struct SaidServer {
    wallet: Arc<Mutex<Wallet>>,
    tool_router: ToolRouter<Self>,
    /// When Some, capability checks are enforced (HTTP mode).
    /// When None, all tools are allowed (stdio / local trust mode).
    allowed_capabilities: Option<Vec<Capability>>,
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
        }
    }

    /// Create a new server with shared wallet and specific capabilities (HTTP auth mode).
    pub fn new_with_auth(
        wallet: Arc<Mutex<Wallet>>,
        capabilities: Vec<Capability>,
    ) -> Self {
        Self {
            wallet,
            tool_router: Self::tool_router(),
            allowed_capabilities: Some(capabilities),
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
    let wallet = Wallet::load(&wallet_dir)?;
    let server = SaidServer::new(wallet);

    let service = server.serve(stdio()).await?;
    service.waiting().await?;
    Ok(())
}

/// Run the MCP server over HTTP with UCAN auth on the given port.
pub async fn run_http(wallet: Wallet, port: u16) -> Result<(), Box<dyn std::error::Error>> {
    http::run_http_server(wallet, port).await
}
