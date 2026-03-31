use std::io::Write;
use std::path::PathBuf;
use std::process::{Command as ProcessCommand, Stdio};
use std::time::Duration;

use clap::{Parser, Subcommand};
use ed25519_dalek::Signer;

use said_core::Wallet;
use said_types::{
    Capability, KeyType, KnowledgeDoc, McpConfig, Memory, PayCurrency, Preference, Provider,
    Secret, SpendingPolicy, SystemPrompt, TxDirection, TxStatus,
};

#[derive(Parser)]
#[command(name = "said", about = "Sovereign AI Identity — portable AI data wallet")]
struct Cli {
    /// Custom wallet directory (default: ~/.said)
    #[arg(long, global = true)]
    wallet_dir: Option<PathBuf>,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Initialize a new SAID vault
    Init {
        /// Number of words in the mnemonic (12 or 24)
        #[arg(long, default_value = "24")]
        words: usize,
        /// Encrypt the seed file with a password (recommended)
        #[arg(long)]
        password: bool,
    },
    /// Recover a wallet from a mnemonic phrase
    Recover,
    /// Show wallet status
    Status,
    /// Import data into the wallet
    Import {
        #[command(subcommand)]
        what: ImportTarget,
    },
    /// Export data from the wallet
    Export {
        #[command(subcommand)]
        what: ExportTarget,
    },
    /// Manage secrets (API keys, tokens, credentials)
    Secret {
        #[command(subcommand)]
        action: SecretAction,
    },
    /// Manage provider access sessions
    Provider {
        #[command(subcommand)]
        action: ProviderAction,
    },
    /// Start the MCP server
    Serve {
        /// Use HTTP transport instead of stdio
        #[arg(long)]
        http: bool,
        /// Port for HTTP server (default: 3000)
        #[arg(long, default_value = "3000")]
        port: u16,
    },
    /// Output portable context from the wallet
    Context {
        /// Only show context relevant to this topic
        #[arg(long)]
        topic: Option<String>,
        /// Only output the system prompt
        #[arg(long)]
        prompt_only: bool,
    },
    /// Wrap a command with SAID context injected
    Wrap {
        /// Append --system <context> to the command args
        #[arg(long)]
        inject_system: bool,
        /// The command and its arguments to run
        #[arg(trailing_var_arg = true, required = true)]
        command: Vec<String>,
    },
    /// Manage the SAID background daemon
    Daemon {
        #[command(subcommand)]
        action: DaemonAction,
    },
    /// Run the daemon process (internal, not shown in help)
    #[command(hide = true)]
    DaemonRun {
        #[arg(long, default_value = "3000")]
        port: u16,
    },
    /// Solana on-chain identity registry
    Solana {
        #[command(subcommand)]
        action: SolanaAction,
    },
    /// Audit vault for credential hygiene issues
    Audit {
        /// Auto-apply safe fixes without prompting
        #[arg(long)]
        fix: bool,
        /// Output report as JSON
        #[arg(long)]
        json: bool,
        /// Minimum severity to show (low, medium, high, critical)
        #[arg(long, default_value = "low")]
        severity: String,
    },
    /// Agent payment infrastructure
    Pay {
        #[command(subcommand)]
        action: PayAction,
    },
    /// Service discovery — list and evaluate services from the on-chain SAID registry
    Discover {
        #[command(subcommand)]
        action: DiscoverAction,
    },
}

#[derive(Subcommand)]
enum DaemonAction {
    /// Start the daemon in the background
    Start {
        /// Port for the HTTP MCP server
        #[arg(long, default_value = "3000")]
        port: u16,
    },
    /// Stop the running daemon
    Stop,
    /// Check daemon status
    Status,
    /// Remove SAID from all AI tool configs
    Unregister,
}

#[derive(Subcommand)]
enum ImportTarget {
    /// Import system prompts from a JSON file
    Prompts { file: PathBuf },
    /// Import memories from a JSON file
    Memories { file: PathBuf },
    /// Import preferences from a JSON file
    Preferences { file: PathBuf },
    /// Import knowledge docs from a JSON file
    Knowledge { file: PathBuf },
    /// Import MCP server configs from a JSON file
    McpConfigs { file: PathBuf },
}

#[derive(Subcommand)]
enum ExportTarget {
    /// Export system prompts as JSON
    Prompts,
    /// Export memories as JSON
    Memories,
    /// Export preferences as JSON
    Preferences,
    /// Export knowledge docs as JSON
    Knowledge,
    /// Export MCP server configs as JSON
    McpConfigs,
}

#[derive(Subcommand)]
enum SecretAction {
    /// Add or update a secret
    Set {
        /// Secret name (e.g. "stripe", "openai")
        name: String,
        /// Secret value (will prompt interactively if omitted)
        value: Option<String>,
        /// Description
        #[arg(long)]
        description: Option<String>,
        /// Tags (comma-separated)
        #[arg(long, value_delimiter = ',')]
        tags: Option<Vec<String>>,
        /// Restrict to specific providers (comma-separated: openai,anthropic)
        #[arg(long, value_delimiter = ',')]
        providers: Option<Vec<String>>,
    },
    /// Get a secret value
    Get {
        /// Secret name
        name: String,
    },
    /// List all secrets (names only, no values)
    List,
    /// Remove a secret
    Remove {
        /// Secret name
        name: String,
    },
}

#[derive(Subcommand)]
enum ProviderAction {
    /// Grant a provider access to your wallet
    Grant {
        /// Provider name: master, openai, anthropic, google, local
        #[arg(long)]
        provider: String,
        /// Capabilities (comma-separated): read-prompts, read-preferences, read-memories,
        /// write-memories, read-knowledge, read-conversations, read-mcp-configs, read-all, all
        #[arg(long, value_delimiter = ',')]
        capabilities: Vec<String>,
        /// Expiry duration: e.g. 1h, 7d, 30d, 1y
        #[arg(long, default_value = "30d")]
        expires: String,
        /// Human-readable label for this session
        #[arg(long)]
        label: Option<String>,
    },
    /// Revoke a provider's access
    Revoke {
        /// Session ID (UUID) to revoke
        #[arg(long)]
        id: String,
    },
    /// List all provider sessions
    List,
}

const DEFAULT_RPC_URL: &str = "https://api.devnet.solana.com";

#[derive(Subcommand)]
enum SolanaAction {
    /// Register your SAID identity on-chain
    Register {
        /// Solana RPC URL
        #[arg(long, default_value = DEFAULT_RPC_URL)]
        rpc_url: String,
    },
    /// Look up an identity by DID or master public key
    Lookup {
        /// DID (did:key:...) or base58-encoded master public key
        query: String,
        /// Solana RPC URL
        #[arg(long, default_value = DEFAULT_RPC_URL)]
        rpc_url: String,
    },
    /// Deactivate your on-chain identity
    Deactivate {
        /// Solana RPC URL
        #[arg(long, default_value = DEFAULT_RPC_URL)]
        rpc_url: String,
    },
    /// Reactivate your on-chain identity
    Reactivate {
        /// Solana RPC URL
        #[arg(long, default_value = DEFAULT_RPC_URL)]
        rpc_url: String,
    },
    /// Show on-chain identity status
    Status {
        /// Solana RPC URL
        #[arg(long, default_value = DEFAULT_RPC_URL)]
        rpc_url: String,
    },
    /// Show Solana address and request devnet airdrop
    Fund {
        /// Solana RPC URL
        #[arg(long, default_value = DEFAULT_RPC_URL)]
        rpc_url: String,
    },
    /// Transfer on-chain identity authority to a new account
    UpdateAuthority {
        /// New authority (base58 Solana public key)
        new_authority: String,
        /// Solana RPC URL
        #[arg(long, default_value = DEFAULT_RPC_URL)]
        rpc_url: String,
    },
}

#[derive(Subcommand)]
enum PayAction {
    /// Show SOL and USDC balances
    Balance {
        /// Agent wallet label
        #[arg(long)]
        agent: Option<String>,
        /// Solana RPC URL
        #[arg(long, default_value = DEFAULT_RPC_URL)]
        rpc_url: String,
    },
    /// Show Solana deposit address
    Address {
        /// Agent wallet label
        #[arg(long)]
        agent: Option<String>,
    },
    /// Send SOL or USDC
    Transfer {
        /// Recipient Solana address
        to: String,
        /// Amount to send (e.g. "0.5")
        amount: String,
        /// Currency: sol or usdc (default: sol)
        #[arg(long, default_value = "sol")]
        currency: String,
        /// Agent wallet label to send from
        #[arg(long)]
        agent: Option<String>,
        /// Optional memo
        #[arg(long)]
        memo: Option<String>,
        /// Solana RPC URL
        #[arg(long, default_value = DEFAULT_RPC_URL)]
        rpc_url: String,
    },
    /// Manage agent wallets
    Agents {
        #[command(subcommand)]
        action: AgentAction,
    },
    /// View payment transaction history
    History {
        /// Agent wallet label
        #[arg(long)]
        agent: Option<String>,
        /// Max transactions to show
        #[arg(long, default_value = "20")]
        limit: usize,
    },
    /// Discover a service by task description and pay via x402 autonomously
    DiscoverAndPay {
        /// Natural language task description (e.g. "current weather in NYC")
        task: String,
        /// Agent wallet label to pay from
        #[arg(long)]
        agent: String,
        /// Filter by service category
        #[arg(long)]
        category: Option<String>,
        /// Maximum price per request in USDC (e.g. "0.05")
        #[arg(long)]
        max_price: Option<String>,
        /// Minimum trust score to proceed (0.0–1.0, default: 0.5)
        #[arg(long, default_value = "0.5")]
        min_trust: f32,
        /// JSON request body to send to the service
        #[arg(long)]
        body: Option<String>,
        /// Solana RPC URL
        #[arg(long, default_value = DEFAULT_RPC_URL)]
        rpc_url: String,
        /// SAID Cloud API base URL
        #[arg(long, default_value = "https://ghola-api.onrender.com")]
        api_url: String,
    },
}

#[derive(Subcommand)]
enum AgentAction {
    /// Create a new agent wallet
    Create {
        /// Human-readable label
        label: String,
        /// Daily USDC limit in dollars
        #[arg(long)]
        daily_usdc_limit: Option<f64>,
        /// Per-transaction USDC limit in dollars
        #[arg(long)]
        per_tx_usdc_limit: Option<f64>,
        /// Daily SOL limit
        #[arg(long)]
        daily_sol_limit: Option<f64>,
        /// Per-transaction SOL limit
        #[arg(long)]
        per_tx_sol_limit: Option<f64>,
    },
    /// List all agent wallets
    List,
    /// Show spending limits and 24h usage
    Limits {
        /// Agent wallet label
        agent: String,
        /// Update daily USDC limit
        #[arg(long)]
        daily_usdc_limit: Option<f64>,
        /// Update per-tx USDC limit
        #[arg(long)]
        per_tx_usdc_limit: Option<f64>,
        /// Update daily SOL limit
        #[arg(long)]
        daily_sol_limit: Option<f64>,
        /// Update per-tx SOL limit
        #[arg(long)]
        per_tx_sol_limit: Option<f64>,
    },
    /// Deactivate an agent wallet
    Deactivate {
        /// Agent wallet label
        agent: String,
    },
}

#[derive(Subcommand)]
enum DiscoverAction {
    /// List active services from the on-chain SAID registry (+ cloud fallback)
    Services {
        /// Filter by category (e.g. data, inference, commerce, finance)
        #[arg(long)]
        category: Option<String>,
        /// Filter by tags (comma-separated, e.g. weather,realtime)
        #[arg(long, value_delimiter = ',')]
        tags: Option<Vec<String>>,
        /// Maximum price per request in USDC (e.g. "0.01")
        #[arg(long)]
        max_price: Option<String>,
        /// Minimum reputation score 0.0–1.0
        #[arg(long)]
        min_reputation: Option<f32>,
        /// Maximum results (default: 10)
        #[arg(long, default_value = "10")]
        limit: usize,
        /// Solana RPC URL
        #[arg(long, default_value = DEFAULT_RPC_URL)]
        rpc_url: String,
        /// SAID Cloud API base URL
        #[arg(long, default_value = "https://ghola-api.onrender.com")]
        api_url: String,
    },
    /// Evaluate a service's trustworthiness before paying
    Evaluate {
        /// Service slug (e.g. "acme-weather-api")
        slug: String,
        /// Solana RPC URL
        #[arg(long, default_value = DEFAULT_RPC_URL)]
        rpc_url: String,
        /// SAID Cloud API base URL
        #[arg(long, default_value = "https://ghola-api.onrender.com")]
        api_url: String,
    },
}

fn parse_provider(name: &str) -> Result<Provider, String> {
    match name.to_lowercase().as_str() {
        "master" => Ok(Provider::Master),
        "openai" => Ok(Provider::OpenAI),
        "anthropic" => Ok(Provider::Anthropic),
        "google" => Ok(Provider::Google),
        "local" => Ok(Provider::Local),
        "solana" => Ok(Provider::Solana),
        "agent" => Ok(Provider::Agent),
        _ => Err(format!(
            "unknown provider '{}': use master, openai, anthropic, google, local, solana, or agent",
            name
        )),
    }
}

fn parse_capabilities(caps: &[String]) -> Result<Vec<Capability>, String> {
    caps.iter()
        .map(|s| {
            Capability::from_cli_str(s.as_str())
                .ok_or_else(|| format!("unknown capability '{}': use read-prompts, read-preferences, read-memories, write-memories, read-knowledge, read-conversations, read-mcp-configs, read-all, or all", s))
        })
        .collect()
}

/// Load wallet, prompting for password if the seed is encrypted.
fn load_wallet(dir: &std::path::PathBuf) -> Result<Wallet, Box<dyn std::error::Error>> {
    match Wallet::load(dir, None) {
        Ok(w) => Ok(w),
        Err(said_core::SaidError::PasswordRequired) => {
            let pw = rpassword::prompt_password("Vault password: ")?;
            Ok(Wallet::load(dir, Some(&pw))?)
        }
        Err(e) => Err(e.into()),
    }
}

fn parse_duration(s: &str) -> Result<Duration, String> {
    let s = s.trim();
    if let Some(num) = s.strip_suffix('h') {
        let n: u64 = num.parse().map_err(|_| format!("invalid duration: {}", s))?;
        Ok(Duration::from_secs(n * 3600))
    } else if let Some(num) = s.strip_suffix('d') {
        let n: u64 = num.parse().map_err(|_| format!("invalid duration: {}", s))?;
        Ok(Duration::from_secs(n * 86400))
    } else if let Some(num) = s.strip_suffix('y') {
        let n: u64 = num.parse().map_err(|_| format!("invalid duration: {}", s))?;
        Ok(Duration::from_secs(n * 365 * 86400))
    } else {
        Err(format!(
            "invalid duration '{}': use e.g. 1h, 7d, 30d, 1y",
            s
        ))
    }
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();

    if let Err(e) = run(cli).await {
        eprintln!("Error: {}", e);
        std::process::exit(1);
    }
}

async fn run(cli: Cli) -> Result<(), Box<dyn std::error::Error>> {
    let dir = cli
        .wallet_dir
        .unwrap_or_else(|| Wallet::default_wallet_dir().expect("could not determine home dir"));

    match cli.command {
        Commands::Init { words, password: use_password } => {
            if words != 12 && words != 24 {
                return Err("--words must be 12 or 24".into());
            }

            // Determine password: --password flag, or prompt interactively
            let password = if use_password {
                let pw = rpassword::prompt_password("Set vault password: ")?;
                let pw2 = rpassword::prompt_password("Confirm password: ")?;
                if pw != pw2 {
                    return Err("Passwords do not match.".into());
                }
                Some(pw)
            } else {
                None
            };

            let (_, phrase) = Wallet::init(&dir, password.as_deref())?;

            println!("Vault initialized at: {}", dir.display());
            if password.is_some() {
                println!("Seed file encrypted with your password.");
            }
            println!();
            println!("Your recovery phrase (keep this somewhere safe — you'll need it to restore your vault on a new machine):");
            println!();

            let word_list: Vec<&str> = phrase.split_whitespace().collect();
            for (i, word) in word_list.iter().enumerate() {
                print!("{:>2}. {:<12}", i + 1, word);
                if (i + 1) % 4 == 0 {
                    println!();
                }
            }
            println!();
        }

        Commands::Recover => {
            println!("Enter your recovery phrase (space-separated words):");

            let mut phrase = String::new();
            std::io::stdin().read_line(&mut phrase)?;
            let phrase = phrase.trim();

            Wallet::recover(phrase, &dir, None)?;
            println!("Vault recovered at: {}", dir.display());
        }

        Commands::Status => {
            let metadata = Wallet::load_metadata(&dir)?;
            let wallet = load_wallet(&dir)?;

            println!("SAID Wallet Status");
            println!("==================");
            println!("Directory:  {}", dir.display());
            println!("Version:    {}", metadata.version);
            println!("Created:    {}", metadata.created_at);
            println!("Public Key: {}", &metadata.master_public_key[..16]);
            println!("DID:        {}", wallet.master_did_key());
            println!();

            println!("Collections:");
            let collections = wallet.storage().list_collections()?;
            if collections.is_empty() {
                println!("  (none — import data with `said import`)");
            } else {
                for name in &collections {
                    let items: Vec<serde_json::Value> =
                        wallet.storage().load(name).unwrap_or_default();
                    println!("  {}: {} items", name, items.len());
                }
            }

            // Show active sessions
            let sessions = wallet.list_sessions()?;
            let active: Vec<_> = sessions.iter().filter(|s| !s.revoked).collect();
            if !active.is_empty() {
                println!();
                println!("Active Sessions: {}", active.len());
                for s in &active {
                    let expired = s.expires_at < chrono::Utc::now();
                    let status = if expired { "expired" } else { "active" };
                    println!(
                        "  {} | {:?} | {} | {} | {}",
                        &s.id.to_string()[..8],
                        s.provider,
                        s.label,
                        status,
                        s.expires_at.format("%Y-%m-%d %H:%M UTC")
                    );
                }
            }
        }

        Commands::Import { what } => {
            let wallet = load_wallet(&dir)?;

            match what {
                ImportTarget::Prompts { file } => {
                    let data = std::fs::read_to_string(&file)?;
                    let items: Vec<SystemPrompt> = serde_json::from_str(&data)?;
                    wallet.storage().save("prompts", &items)?;
                    println!("Imported {} system prompts", items.len());
                }
                ImportTarget::Memories { file } => {
                    let data = std::fs::read_to_string(&file)?;
                    let items: Vec<Memory> = serde_json::from_str(&data)?;
                    wallet.storage().save("memories", &items)?;
                    println!("Imported {} memories", items.len());
                }
                ImportTarget::Preferences { file } => {
                    let data = std::fs::read_to_string(&file)?;
                    let items: Vec<Preference> = serde_json::from_str(&data)?;
                    wallet.storage().save("preferences", &items)?;
                    println!("Imported {} preferences", items.len());
                }
                ImportTarget::Knowledge { file } => {
                    let data = std::fs::read_to_string(&file)?;
                    let items: Vec<KnowledgeDoc> = serde_json::from_str(&data)?;
                    wallet.storage().save("knowledge", &items)?;
                    println!("Imported {} knowledge docs", items.len());
                }
                ImportTarget::McpConfigs { file } => {
                    let data = std::fs::read_to_string(&file)?;
                    let items: Vec<McpConfig> = serde_json::from_str(&data)?;
                    wallet.storage().save("mcp_configs", &items)?;
                    println!("Imported {} MCP configs", items.len());
                }
            }
        }

        Commands::Export { what } => {
            let wallet = load_wallet(&dir)?;

            let json = match what {
                ExportTarget::Prompts => {
                    let items: Vec<SystemPrompt> =
                        wallet.storage().load("prompts").unwrap_or_default();
                    serde_json::to_string_pretty(&items)?
                }
                ExportTarget::Memories => {
                    let items: Vec<Memory> =
                        wallet.storage().load("memories").unwrap_or_default();
                    serde_json::to_string_pretty(&items)?
                }
                ExportTarget::Preferences => {
                    let items: Vec<Preference> =
                        wallet.storage().load("preferences").unwrap_or_default();
                    serde_json::to_string_pretty(&items)?
                }
                ExportTarget::Knowledge => {
                    let items: Vec<KnowledgeDoc> =
                        wallet.storage().load("knowledge").unwrap_or_default();
                    serde_json::to_string_pretty(&items)?
                }
                ExportTarget::McpConfigs => {
                    let items: Vec<McpConfig> =
                        wallet.storage().load("mcp_configs").unwrap_or_default();
                    serde_json::to_string_pretty(&items)?
                }
            };

            println!("{}", json);
        }

        Commands::Secret { action } => {
            let wallet = load_wallet(&dir)?;

            match action {
                SecretAction::Set {
                    name,
                    value,
                    description,
                    tags,
                    providers,
                } => {
                    let value = match value {
                        Some(v) => v,
                        None => {
                            print!("Enter secret value: ");
                            std::io::stdout().flush()?;
                            let mut val = String::new();
                            std::io::stdin().read_line(&mut val)?;
                            val.trim().to_string()
                        }
                    };

                    let mut secrets: Vec<Secret> =
                        wallet.storage().load("secrets").unwrap_or_default();

                    let now = chrono::Utc::now();
                    if let Some(existing) = secrets.iter_mut().find(|s| s.name == name) {
                        existing.value = value;
                        existing.updated_at = now;
                        if let Some(desc) = description {
                            existing.description = Some(desc);
                        }
                        if let Some(t) = tags {
                            existing.tags = t;
                        }
                        if let Some(p) = providers {
                            existing.allowed_providers = p;
                        }
                    } else {
                        secrets.push(Secret {
                            id: uuid::Uuid::new_v4(),
                            name: name.clone(),
                            value,
                            description,
                            tags: tags.unwrap_or_default(),
                            allowed_providers: providers.unwrap_or_default(),
                            created_at: now,
                            updated_at: now,
                        });
                    }

                    wallet.storage().save("secrets", &secrets)?;
                    println!("Secret '{}' saved.", name);
                }

                SecretAction::Get { name } => {
                    let secrets: Vec<Secret> =
                        wallet.storage().load("secrets").unwrap_or_default();

                    if let Some(secret) = secrets.iter().find(|s| s.name == name) {
                        println!("{}", secret.value);
                    } else {
                        println!("Secret '{}' not found.", name);
                    }
                }

                SecretAction::List => {
                    let secrets: Vec<Secret> =
                        wallet.storage().load("secrets").unwrap_or_default();

                    if secrets.is_empty() {
                        println!("No secrets stored. Add one with: said secret set <name> <value>");
                    } else {
                        println!(
                            "{:<20} {:<30} {:<20} {:<20} {:<20}",
                            "Name", "Description", "Tags", "Providers", "Updated"
                        );
                        println!("{}", "-".repeat(110));

                        for s in &secrets {
                            let desc = s
                                .description
                                .as_deref()
                                .unwrap_or("-");
                            let tags = if s.tags.is_empty() {
                                "-".to_string()
                            } else {
                                s.tags.join(", ")
                            };
                            let provs = if s.allowed_providers.is_empty() {
                                "all".to_string()
                            } else {
                                s.allowed_providers.join(", ")
                            };
                            println!(
                                "{:<20} {:<30} {:<20} {:<20} {:<20}",
                                s.name,
                                desc,
                                tags,
                                provs,
                                s.updated_at.format("%Y-%m-%d %H:%M")
                            );
                        }
                    }
                }

                SecretAction::Remove { name } => {
                    let mut secrets: Vec<Secret> =
                        wallet.storage().load("secrets").unwrap_or_default();

                    let before = secrets.len();
                    secrets.retain(|s| s.name != name);

                    if secrets.len() < before {
                        wallet.storage().save("secrets", &secrets)?;
                        println!("Secret '{}' removed.", name);
                    } else {
                        println!("Secret '{}' not found.", name);
                    }
                }
            }
        }

        Commands::Provider { action } => {
            let wallet = load_wallet(&dir)?;

            match action {
                ProviderAction::Grant {
                    provider,
                    capabilities,
                    expires,
                    label,
                } => {
                    let provider = parse_provider(&provider)?;
                    let capabilities = parse_capabilities(&capabilities)?;
                    let expires_in = parse_duration(&expires)?;
                    let label = label.unwrap_or_else(|| format!("{:?}", provider));

                    let session =
                        wallet.grant_provider(provider, &label, capabilities, expires_in)?;

                    println!("Session granted!");
                    println!();
                    println!("  Session ID: {}", session.id);
                    println!("  Provider:   {:?}", session.provider);
                    println!("  Label:      {}", session.label);
                    println!("  Expires:    {}", session.expires_at.format("%Y-%m-%d %H:%M UTC"));
                    println!("  Capabilities:");
                    for cap in &session.capabilities {
                        println!("    - {:?}", cap);
                    }
                    println!();
                    println!("Bearer token (use in Authorization header):");
                    println!();
                    println!("{}", session.token);
                }

                ProviderAction::Revoke { id } => {
                    let uuid: uuid::Uuid = id
                        .parse()
                        .map_err(|e| format!("invalid session ID: {}", e))?;
                    wallet.revoke_session(uuid)?;
                    println!("Session {} revoked.", id);
                }

                ProviderAction::List => {
                    let sessions = wallet.list_sessions()?;
                    if sessions.is_empty() {
                        println!("No provider sessions. Grant one with: said provider grant --provider <name> --capabilities <caps>");
                        return Ok(());
                    }

                    println!(
                        "{:<36} {:<12} {:<20} {:<10} {:<20}",
                        "ID", "Provider", "Label", "Status", "Expires"
                    );
                    println!("{}", "-".repeat(98));

                    for s in &sessions {
                        let now = chrono::Utc::now();
                        let status = if s.revoked {
                            "revoked"
                        } else if s.expires_at < now {
                            "expired"
                        } else {
                            "active"
                        };

                        println!(
                            "{:<36} {:<12} {:<20} {:<10} {:<20}",
                            s.id,
                            format!("{:?}", s.provider),
                            s.label,
                            status,
                            s.expires_at.format("%Y-%m-%d %H:%M")
                        );
                    }
                }
            }
        }

        Commands::Serve { http, port } => {
            if http {
                let wallet = load_wallet(&dir)?;
                said_mcp::run_http(wallet, port).await?;
            } else {
                said_mcp::run().await?;
            }
        }

        Commands::Context {
            topic,
            prompt_only,
        } => {
            let wallet = load_wallet(&dir)?;

            if prompt_only {
                let prompts: Vec<SystemPrompt> =
                    wallet.storage().load("prompts").unwrap_or_default();
                if prompts.is_empty() {
                    println!("(no system prompt configured)");
                } else {
                    // Prefer "default", otherwise first
                    let prompt = prompts
                        .iter()
                        .find(|p| p.name == "default")
                        .unwrap_or(&prompts[0]);
                    println!("{}", prompt.content);
                }
            } else if let Some(ref t) = topic {
                let ctx = wallet.get_relevant_context(t, 10)?;
                println!("{}", ctx);
            } else {
                let ctx = wallet.get_full_context()?;
                println!("{}", ctx);
            }
        }

        Commands::Wrap {
            inject_system,
            command,
        } => {
            let wallet = load_wallet(&dir)?;
            let context = wallet.get_full_context()?;

            let mut cmd = ProcessCommand::new(&command[0]);
            cmd.args(&command[1..]);
            cmd.env("SAID_CONTEXT", &context);

            if inject_system {
                cmd.arg("--system").arg(&context);
            }

            let status = cmd.status()?;
            std::process::exit(status.code().unwrap_or(1));
        }

        Commands::Daemon { action } => match action {
            DaemonAction::Start { port } => {
                if said_daemon::is_running(&dir).is_some() {
                    println!("Daemon is already running.");
                    return Ok(());
                }

                let exe = std::env::current_exe()?;
                let mut cmd = ProcessCommand::new(&exe);
                cmd.args(["daemon-run", "--port", &port.to_string()]);
                cmd.stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .stdin(Stdio::null());

                cmd.spawn()?;

                // Brief pause to let the daemon write its PID file
                tokio::time::sleep(Duration::from_millis(500)).await;

                if let Some(pid) = said_daemon::is_running(&dir) {
                    println!("Daemon started (PID {}, port {}).", pid, port);
                    println!("Auto-discovering AI tool configs...");
                } else {
                    println!("Daemon spawned on port {}. Check ~/.said/daemon.log if issues arise.", port);
                }
            }

            DaemonAction::Stop => {
                if said_daemon::is_running(&dir).is_none() {
                    println!("Daemon is not running.");
                    return Ok(());
                }

                said_daemon::stop(&dir)?;
                println!("Daemon stopped.");
            }

            DaemonAction::Status => {
                if let Some(pid) = said_daemon::is_running(&dir) {
                    println!("Daemon is running (PID {}).", pid);
                } else {
                    println!("Daemon is not running.");
                }
            }

            DaemonAction::Unregister => {
                let removed = said_daemon::discovery::unregister_all();
                if removed.is_empty() {
                    println!("SAID was not configured in any AI tools.");
                } else {
                    println!("Removed SAID from:");
                    for r in &removed {
                        println!("  - {}", r);
                    }
                }
            }
        },

        Commands::DaemonRun { port } => {
            said_daemon::run(port).await?;
        }

        Commands::Solana { action } => {
            handle_solana(action, &dir).await?;
        }

        Commands::Pay { action } => {
            handle_pay(action, &dir).await?;
        }

        Commands::Discover { action } => {
            handle_discover(action).await?;
        }

        Commands::Audit {
            fix,
            json,
            severity,
        } => {
            let min_severity = said_core::audit::parse_severity(&severity)
                .ok_or_else(|| {
                    format!(
                        "invalid severity '{}': use low, medium, high, or critical",
                        severity
                    )
                })?;

            let wallet = load_wallet(&dir)?;
            let report = said_core::audit::build_report(&wallet);

            if json {
                println!("{}", said_core::audit::format_report_json(&report));
            } else {
                print!("{}", said_core::audit::format_report(&report, min_severity));

                let auto_fixable: Vec<_> = report
                    .findings
                    .iter()
                    .filter(|f| f.auto_fixable)
                    .collect();

                if !auto_fixable.is_empty() {
                    if fix {
                        // Auto-apply all safe fixes
                        let applied =
                            said_core::audit::apply_auto_fixes(&wallet, &report.findings);
                        if applied.is_empty() {
                            println!("No fixes were applicable.");
                        } else {
                            println!("Applied {} fix{}:", applied.len(), if applied.len() == 1 { "" } else { "es" });
                            for a in &applied {
                                println!("  - {}", a);
                            }
                        }
                    } else {
                        // Interactive prompt
                        print!(
                            "\nApply {} auto-fix{}? [y/N]: ",
                            auto_fixable.len(),
                            if auto_fixable.len() == 1 { "" } else { "es" },
                        );
                        std::io::stdout().flush()?;
                        let mut answer = String::new();
                        std::io::stdin().read_line(&mut answer)?;
                        if answer.trim().eq_ignore_ascii_case("y") {
                            let applied =
                                said_core::audit::apply_auto_fixes(&wallet, &report.findings);
                            if applied.is_empty() {
                                println!("No fixes were applicable.");
                            } else {
                                println!(
                                    "Applied {} fix{}:",
                                    applied.len(),
                                    if applied.len() == 1 { "" } else { "es" }
                                );
                                for a in &applied {
                                    println!("  - {}", a);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(())
}

async fn handle_solana(
    action: SolanaAction,
    wallet_dir: &PathBuf,
) -> std::result::Result<(), Box<dyn std::error::Error>> {
    let wallet = load_wallet(wallet_dir)?;
    let solana_kp = wallet.solana_keypair_bytes();

    match action {
        SolanaAction::Register { rpc_url } => {
            let client = said_solana::SolanaClient::new(&rpc_url, &solana_kp)?;
            let did_key = wallet.master_did_key();

            // Sign the register message with the SAID master key
            let master_xprv =
                wallet.derive_provider_key(Provider::Master, KeyType::Signing, 0);
            let master_signing = said_core::ucan::xprv_to_signing_key(&master_xprv);
            let master_pub_bytes = master_signing.verifying_key().to_bytes();

            let message =
                said_solana::build_register_message(&master_pub_bytes, &did_key);
            let sig = master_signing.sign(message.as_bytes());

            println!("Registering identity on-chain...");
            println!("  DID:      {}", did_key);
            println!("  Payer:    {}", client.payer_pubkey_bs58());
            println!("  Master:   {}", bs58::encode(&master_pub_bytes).into_string());

            let tx_sig = client
                .register(&master_pub_bytes, &did_key, &sig.to_bytes())
                .await?;
            println!("  TX:       {}", tx_sig);
            println!("Identity registered successfully!");
        }

        SolanaAction::Lookup { query, rpc_url } => {
            let client = said_solana::SolanaClient::new(&rpc_url, &solana_kp)?;

            // Determine if query is a DID or base58 pubkey
            let pubkey_bytes = if query.starts_with("did:key:") {
                // Parse did:key to extract the Ed25519 public key
                let z_part = query
                    .strip_prefix("did:key:")
                    .ok_or("invalid DID format")?;
                let decoded = bs58::decode(z_part).into_vec()?;
                // Skip 2-byte multicodec prefix (0xed, 0x01)
                if decoded.len() < 34 || decoded[0] != 0xed || decoded[1] != 0x01 {
                    return Err("invalid did:key (expected Ed25519 multicodec)".into());
                }
                let mut pk = [0u8; 32];
                pk.copy_from_slice(&decoded[2..34]);
                pk
            } else {
                let decoded = bs58::decode(&query).into_vec()?;
                let mut pk = [0u8; 32];
                if decoded.len() != 32 {
                    return Err("expected 32-byte base58-encoded public key".into());
                }
                pk.copy_from_slice(&decoded);
                pk
            };

            match client.lookup_by_pubkey(&pubkey_bytes).await {
                Ok(record) => {
                    println!("Identity Record");
                    println!("===============");
                    println!("  DID:          {}", record.did_key);
                    println!("  Authority:    {}", record.authority_bs58());
                    println!("  Master Key:   {}", record.master_pubkey_bs58());
                    println!("  Active:       {}", record.active);
                    if !record.profile_uri.is_empty() {
                        println!("  Profile URI:  {}", record.profile_uri);
                    }
                    println!(
                        "  Registered:   {}",
                        chrono::DateTime::from_timestamp(record.registered_at, 0)
                            .map(|d| d.to_string())
                            .unwrap_or_else(|| record.registered_at.to_string())
                    );
                    println!(
                        "  Updated:      {}",
                        chrono::DateTime::from_timestamp(record.updated_at, 0)
                            .map(|d| d.to_string())
                            .unwrap_or_else(|| record.updated_at.to_string())
                    );
                }
                Err(said_solana::SolanaError::IdentityNotFound) => {
                    println!("No identity found for: {}", query);
                }
                Err(e) => return Err(e.into()),
            }
        }

        SolanaAction::Deactivate { rpc_url } => {
            let client = said_solana::SolanaClient::new(&rpc_url, &solana_kp)?;
            let master_xprv =
                wallet.derive_provider_key(Provider::Master, KeyType::Signing, 0);
            let master_signing = said_core::ucan::xprv_to_signing_key(&master_xprv);
            let master_pub_bytes = master_signing.verifying_key().to_bytes();

            println!("Deactivating identity...");
            let tx_sig = client.deactivate(&master_pub_bytes).await?;
            println!("  TX: {}", tx_sig);
            println!("Identity deactivated.");
        }

        SolanaAction::Reactivate { rpc_url } => {
            let client = said_solana::SolanaClient::new(&rpc_url, &solana_kp)?;
            let master_xprv =
                wallet.derive_provider_key(Provider::Master, KeyType::Signing, 0);
            let master_signing = said_core::ucan::xprv_to_signing_key(&master_xprv);
            let master_pub_bytes = master_signing.verifying_key().to_bytes();

            println!("Reactivating identity...");
            let tx_sig = client.reactivate(&master_pub_bytes).await?;
            println!("  TX: {}", tx_sig);
            println!("Identity reactivated.");
        }

        SolanaAction::Status { rpc_url } => {
            let client = said_solana::SolanaClient::new(&rpc_url, &solana_kp)?;
            let master_xprv =
                wallet.derive_provider_key(Provider::Master, KeyType::Signing, 0);
            let master_signing = said_core::ucan::xprv_to_signing_key(&master_xprv);
            let master_pub_bytes = master_signing.verifying_key().to_bytes();

            println!("Solana Identity Status");
            println!("=====================");
            println!("  Payer:    {}", client.payer_pubkey_bs58());

            let balance = client.get_balance().await?;
            println!(
                "  Balance:  {} SOL",
                balance as f64 / 1_000_000_000.0
            );

            match client.lookup_by_pubkey(&master_pub_bytes).await {
                Ok(record) => {
                    println!("  DID:      {}", record.did_key);
                    println!("  Active:   {}", record.active);
                    if !record.profile_uri.is_empty() {
                        println!("  Profile:  {}", record.profile_uri);
                    }
                    println!(
                        "  Registered: {}",
                        chrono::DateTime::from_timestamp(record.registered_at, 0)
                            .map(|d| d.to_string())
                            .unwrap_or_else(|| record.registered_at.to_string())
                    );
                }
                Err(said_solana::SolanaError::IdentityNotFound) => {
                    println!("  Identity: not registered");
                }
                Err(e) => return Err(e.into()),
            }
        }

        SolanaAction::Fund { rpc_url } => {
            let client = said_solana::SolanaClient::new(&rpc_url, &solana_kp)?;
            let pubkey = client.payer_pubkey_bs58();

            let balance = client.get_balance().await?;
            println!("Solana Address: {}", pubkey);
            println!(
                "Balance:        {} SOL",
                balance as f64 / 1_000_000_000.0
            );

            if rpc_url.contains("devnet") || rpc_url.contains("localhost") || rpc_url.contains("127.0.0.1") {
                println!("Requesting 1 SOL airdrop...");
                match client.request_airdrop(1_000_000_000).await {
                    Ok(sig) => {
                        println!("Airdrop TX: {}", sig);
                        // Wait briefly for confirmation
                        tokio::time::sleep(Duration::from_secs(2)).await;
                        let new_balance = client.get_balance().await?;
                        println!(
                            "New Balance: {} SOL",
                            new_balance as f64 / 1_000_000_000.0
                        );
                    }
                    Err(e) => {
                        println!("Airdrop failed: {}. Try again or use https://faucet.solana.com", e);
                    }
                }
            } else {
                println!("(Airdrop only available on devnet/localhost)");
            }
        }

        SolanaAction::UpdateAuthority {
            new_authority,
            rpc_url,
        } => {
            let client = said_solana::SolanaClient::new(&rpc_url, &solana_kp)?;
            let master_xprv =
                wallet.derive_provider_key(Provider::Master, KeyType::Signing, 0);
            let master_signing = said_core::ucan::xprv_to_signing_key(&master_xprv);
            let master_pub_bytes = master_signing.verifying_key().to_bytes();

            let new_auth_bytes = bs58::decode(&new_authority).into_vec()?;
            if new_auth_bytes.len() != 32 {
                return Err("new authority must be a 32-byte base58 public key".into());
            }
            let mut new_auth = [0u8; 32];
            new_auth.copy_from_slice(&new_auth_bytes);

            println!("Updating authority to: {}", new_authority);
            let tx_sig = client
                .update_authority(&master_pub_bytes, &new_auth)
                .await?;
            println!("  TX: {}", tx_sig);
            println!("Authority updated.");
        }
    }

    Ok(())
}

async fn handle_pay(
    action: PayAction,
    wallet_dir: &PathBuf,
) -> std::result::Result<(), Box<dyn std::error::Error>> {
    let wallet = load_wallet(wallet_dir)?;

    match action {
        PayAction::Balance { agent, rpc_url } => {
            let is_devnet = rpc_url.contains("devnet");

            let (address, label) = if let Some(ref agent_label) = agent {
                let a = wallet.find_agent_wallet(agent_label)?;
                (a.solana_address.clone(), a.label.clone())
            } else {
                let pubkey = wallet.solana_pubkey_bytes();
                (bs58::encode(&pubkey).into_string(), "owner".to_string())
            };

            // Use a dummy keypair — we only need RPC reads
            let dummy_kp = [0u8; 64];
            let client = said_solana::SolanaClient::new(&rpc_url, &dummy_kp)?;

            let sol_balance = client.get_balance_of(&address).await.unwrap_or(0);

            let wallet_bytes = bs58::decode(&address).into_vec()?;
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

            println!("Wallet: {} ({})", label, address);
            println!(
                "SOL:  {:.9}",
                sol_balance as f64 / 1_000_000_000.0
            );
            println!(
                "USDC: {:.6}",
                usdc_balance as f64 / 1_000_000.0
            );
        }

        PayAction::Address { agent } => {
            let (address, label) = if let Some(ref agent_label) = agent {
                let a = wallet.find_agent_wallet(agent_label)?;
                (a.solana_address.clone(), a.label.clone())
            } else {
                let pubkey = wallet.solana_pubkey_bytes();
                (bs58::encode(&pubkey).into_string(), "owner".to_string())
            };
            println!("{}: {}", label, address);
        }

        PayAction::Transfer {
            to,
            amount,
            currency,
            agent,
            memo,
            rpc_url,
        } => {
            let is_devnet = rpc_url.contains("devnet");
            let currency_enum = match currency.as_str() {
                "usdc" => PayCurrency::Usdc,
                _ => PayCurrency::Sol,
            };

            let amount_float: f64 = amount.parse()?;
            let amount_units = match currency_enum {
                PayCurrency::Sol => (amount_float * 1_000_000_000.0) as u64,
                PayCurrency::Usdc => (amount_float * 1_000_000.0) as u64,
            };

            // Determine which wallet to send from
            let (kp_bytes, agent_id, agent_label, sender) = if let Some(ref agent_label) = agent {
                let a = wallet.find_agent_wallet(agent_label)?;
                wallet.check_spending_limit(a.id, &currency_enum, amount_units)?;
                let kp = wallet.agent_solana_keypair(a.index);
                (kp, a.id, a.label.clone(), a.solana_address.clone())
            } else {
                let kp = wallet.solana_keypair_bytes();
                let pubkey = wallet.solana_pubkey_bytes();
                let addr = bs58::encode(&pubkey).into_string();
                (kp, uuid::Uuid::nil(), "owner".to_string(), addr)
            };

            let client = said_solana::SolanaClient::new(&rpc_url, &kp_bytes)?;

            let to_bytes = bs58::decode(&to).into_vec()?;
            if to_bytes.len() != 32 {
                return Err("recipient must be a 32-byte Solana address".into());
            }
            let mut to_arr = [0u8; 32];
            to_arr.copy_from_slice(&to_bytes);

            println!("Sending {} {} from '{}'...", amount, currency, agent_label);

            let signature = match currency_enum {
                PayCurrency::Sol => client.transfer_sol(&to_arr, amount_units).await?,
                PayCurrency::Usdc => client.transfer_usdc(&to_arr, amount_units, is_devnet).await?,
            };

            // Log transaction
            let tx = said_types::PaymentTransaction {
                id: uuid::Uuid::new_v4(),
                agent_id,
                agent_label: agent_label.clone(),
                direction: TxDirection::Send,
                currency: currency_enum,
                amount: amount_units,
                recipient: to.clone(),
                sender,
                signature: signature.clone(),
                memo,
                status: TxStatus::Confirmed,
                created_at: chrono::Utc::now(),
            };
            let _ = wallet.log_transaction(tx);

            println!("TX:       {}", signature);
            println!(
                "Explorer: https://explorer.solana.com/tx/{}?cluster=devnet",
                signature
            );
        }

        PayAction::Agents { action } => match action {
            AgentAction::Create {
                label,
                daily_usdc_limit,
                per_tx_usdc_limit,
                daily_sol_limit,
                per_tx_sol_limit,
            } => {
                let policy = SpendingPolicy {
                    daily_limit_lamports: daily_sol_limit
                        .map(|v| (v * 1_000_000_000.0) as u64),
                    daily_limit_usdc_micro: daily_usdc_limit
                        .map(|v| (v * 1_000_000.0) as u64),
                    per_tx_limit_lamports: per_tx_sol_limit
                        .map(|v| (v * 1_000_000_000.0) as u64),
                    per_tx_limit_usdc_micro: per_tx_usdc_limit
                        .map(|v| (v * 1_000_000.0) as u64),
                    allowed_recipients: vec![],
                };

                let agent = wallet.create_agent_wallet(&label, policy)?;
                println!("Agent wallet created:");
                println!("  Label:   {}", agent.label);
                println!("  Address: {}", agent.solana_address);
                println!("  ID:      {}", agent.id);

                let p = &agent.spending_policy;
                if let Some(d) = p.daily_limit_usdc_micro {
                    println!("  Daily USDC Limit:  ${:.2}", d as f64 / 1_000_000.0);
                }
                if let Some(t) = p.per_tx_limit_usdc_micro {
                    println!("  Per-TX USDC Limit: ${:.2}", t as f64 / 1_000_000.0);
                }
                if let Some(d) = p.daily_limit_lamports {
                    println!("  Daily SOL Limit:   {:.9} SOL", d as f64 / 1e9);
                }
                if let Some(t) = p.per_tx_limit_lamports {
                    println!("  Per-TX SOL Limit:  {:.9} SOL", t as f64 / 1e9);
                }
            }

            AgentAction::List => {
                let agents = wallet.list_agent_wallets()?;
                if agents.is_empty() {
                    println!("No agent wallets. Create one with: said pay agents create <label>");
                    return Ok(());
                }

                println!(
                    "{:<20} {:<48} {:<8} {:<20}",
                    "Label", "Address", "Active", "Created"
                );
                println!("{}", "-".repeat(96));

                for a in &agents {
                    println!(
                        "{:<20} {:<48} {:<8} {:<20}",
                        a.label,
                        a.solana_address,
                        if a.active { "yes" } else { "no" },
                        a.created_at.format("%Y-%m-%d %H:%M")
                    );
                }
            }

            AgentAction::Limits {
                agent,
                daily_usdc_limit,
                per_tx_usdc_limit,
                daily_sol_limit,
                per_tx_sol_limit,
            } => {
                let a = wallet.find_agent_wallet(&agent)?;

                // If any limit flags are set, update the policy
                if daily_usdc_limit.is_some()
                    || per_tx_usdc_limit.is_some()
                    || daily_sol_limit.is_some()
                    || per_tx_sol_limit.is_some()
                {
                    let mut policy = a.spending_policy.clone();
                    if let Some(v) = daily_usdc_limit {
                        policy.daily_limit_usdc_micro = Some((v * 1_000_000.0) as u64);
                    }
                    if let Some(v) = per_tx_usdc_limit {
                        policy.per_tx_limit_usdc_micro = Some((v * 1_000_000.0) as u64);
                    }
                    if let Some(v) = daily_sol_limit {
                        policy.daily_limit_lamports = Some((v * 1_000_000_000.0) as u64);
                    }
                    if let Some(v) = per_tx_sol_limit {
                        policy.per_tx_limit_lamports = Some((v * 1_000_000_000.0) as u64);
                    }
                    wallet.update_agent_policy(a.id, policy)?;
                    println!("Spending policy updated for '{}'.", agent);

                    // Re-fetch
                    let a = wallet.find_agent_wallet(&agent)?;
                    print_agent_limits(&wallet, &a)?;
                } else {
                    print_agent_limits(&wallet, &a)?;
                }
            }

            AgentAction::Deactivate { agent } => {
                let a = wallet.find_agent_wallet(&agent)?;
                wallet.deactivate_agent(a.id)?;
                println!("Agent '{}' deactivated.", agent);
            }
        },

        PayAction::History { agent, limit } => {
            let agent_id = if let Some(ref agent_label) = agent {
                let a = wallet.find_agent_wallet(agent_label)?;
                Some(a.id)
            } else {
                None
            };

            let txs = wallet.transaction_history(agent_id, limit)?;
            if txs.is_empty() {
                println!("No transactions found.");
                return Ok(());
            }

            println!(
                "{:<12} {:<6} {:<8} {:<15} {:<48} {:<20}",
                "Direction", "Curr", "Status", "Amount", "Recipient", "Date"
            );
            println!("{}", "-".repeat(109));

            for tx in &txs {
                let amount_str = match tx.currency {
                    PayCurrency::Sol => format!("{:.9} SOL", tx.amount as f64 / 1e9),
                    PayCurrency::Usdc => format!("{:.6} USDC", tx.amount as f64 / 1e6),
                };
                println!(
                    "{:<12} {:<6} {:<8} {:<15} {:<48} {:<20}",
                    format!("{:?}", tx.direction),
                    format!("{:?}", tx.currency),
                    format!("{:?}", tx.status),
                    amount_str,
                    &tx.recipient,
                    tx.created_at.format("%Y-%m-%d %H:%M")
                );
            }
        }

        PayAction::DiscoverAndPay {
            task,
            agent,
            category,
            max_price,
            min_trust,
            body: request_body,
            rpc_url,
            api_url,
        } => {
            // Step 1: Discover matching services via cloud resolve
            let http = reqwest::Client::new();
            let mut discover_url = format!("{}/v1/services/resolve?task={}", api_url, task);
            if let Some(ref cat) = category {
                discover_url.push_str(&format!("&category={}", cat));
            }
            if let Some(ref price) = max_price {
                let micro = (price.parse::<f64>().unwrap_or(0.0) * 1_000_000.0) as i64;
                discover_url.push_str(&format!("&max_price_micro_usdc={}", micro));
            }
            discover_url.push_str("&limit=5");

            println!("Discovering services for: '{}'", task);
            let discover_data: serde_json::Value = http
                .get(&discover_url)
                .timeout(Duration::from_secs(15))
                .send()
                .await
                .map_err(|e| format!("Discovery failed: {e}"))?
                .json()
                .await
                .map_err(|e| format!("Discovery JSON error: {e}"))?;

            let top_slug = discover_data
                .get("services")
                .and_then(|s| s.as_array())
                .and_then(|arr| arr.first())
                .and_then(|svc| svc.get("slug").or_else(|| svc.get("id")))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .ok_or_else(|| format!("No services found matching: '{}'", task))?;

            println!("Top match: {}", top_slug);

            // Step 2: Fetch service details
            let svc_data: serde_json::Value = http
                .get(format!("{}/v1/services/{}", api_url, top_slug))
                .timeout(Duration::from_secs(10))
                .send()
                .await
                .map_err(|e| format!("Service lookup failed: {e}"))?
                .json()
                .await
                .map_err(|e| format!("JSON error: {e}"))?;

            let service = svc_data
                .get("service")
                .ok_or_else(|| format!("Service '{}' metadata missing", top_slug))?;

            let base_url = service
                .get("base_url")
                .and_then(|v| v.as_str())
                .ok_or("Service has no base_url")?
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

            // Step 3: Trust check
            let trust_score: f32 = if !provider_did.is_empty() {
                let rep_resp = http
                    .get(format!("{}/v1/reputation/{}", api_url, provider_did))
                    .timeout(Duration::from_secs(8))
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

            println!(
                "Trust score: {:.2} (minimum: {:.2})",
                trust_score, min_trust
            );

            if trust_score < min_trust {
                eprintln!(
                    "ABORTED: trust score {:.2} is below minimum {:.2}.\n\
                     Run `said discover evaluate {}` for a full breakdown.",
                    trust_score, min_trust, top_slug
                );
                std::process::exit(1);
            }

            // Step 4: Spending limit check
            let (kp_bytes, agent_id, agent_label, sender) = {
                let a = wallet.find_agent_wallet(&agent)?;
                wallet.check_spending_limit(a.id, &PayCurrency::Usdc, price_micro_usdc)?;
                let kp = wallet.agent_solana_keypair(a.index);
                (kp, a.id, a.label.clone(), a.solana_address.clone())
            };

            // Step 5: Initial service call
            let is_devnet = rpc_url.contains("devnet");
            let endpoint_url = base_url.trim_end_matches('/').to_string();
            let initial_resp = if let Some(ref b) = request_body {
                http.post(&endpoint_url)
                    .header("Content-Type", "application/json")
                    .body(b.clone())
            } else {
                http.get(&endpoint_url)
            }
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| format!("Service call failed: {e}"))?;

            let status = initial_resp.status().as_u16();

            if status == 402 {
                // Step 6: Parse x402 header
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
                .ok_or("Service returned 402 but PAYMENT-REQUIRED header is missing or malformed")?;

                // Step 7: Execute payment
                let to_bytes = bs58::decode(&pay_to).into_vec()?;
                if to_bytes.len() != 32 {
                    return Err("payTo must be 32 bytes".into());
                }
                let mut to_arr = [0u8; 32];
                to_arr.copy_from_slice(&to_bytes);

                println!(
                    "Paying {:.6} USDC to {}...",
                    price_micro_usdc as f64 / 1_000_000.0,
                    pay_to
                );

                let client = said_solana::SolanaClient::new(&rpc_url, &kp_bytes)?;
                let signature = client.transfer_usdc(&to_arr, price_micro_usdc, is_devnet).await?;

                // Log it
                let _ = wallet.log_transaction(said_types::PaymentTransaction {
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

                println!("TX:       {}", signature);
                println!(
                    "Explorer: https://explorer.solana.com/tx/{}?cluster=devnet",
                    signature
                );

                // Step 8: Re-call with payment proof
                let paid_resp = if let Some(ref b) = request_body {
                    http.post(&endpoint_url)
                        .header("Content-Type", "application/json")
                        .header("X-Payment-Signature", &signature)
                        .body(b.clone())
                } else {
                    http.get(&endpoint_url)
                        .header("X-Payment-Signature", &signature)
                }
                .timeout(Duration::from_secs(30))
                .send()
                .await
                .map_err(|e| format!("Post-payment call failed: {e}"))?;

                let paid_status = paid_resp.status().as_u16();
                let paid_body = paid_resp.text().await.unwrap_or_else(|_| "<empty>".into());
                println!("\n--- Service Response (HTTP {}) ---\n{}", paid_status, paid_body);
            } else {
                let body_text = initial_resp.text().await.unwrap_or_else(|_| "<empty>".into());
                println!("HTTP {} (no x402)\n{}", status, body_text);
            }
        }
    }

    Ok(())
}

async fn handle_discover(
    action: DiscoverAction,
) -> std::result::Result<(), Box<dyn std::error::Error>> {
    let http = reqwest::Client::new();

    match action {
        DiscoverAction::Services {
            category,
            tags,
            max_price,
            min_reputation,
            limit,
            rpc_url: _rpc_url, // RPC is used by the MCP tool; CLI goes via cloud
            api_url,
        } => {
            println!("Discovering services...");
            println!();

            let mut url = format!("{}/v1/services", api_url);
            let mut sep = '?';
            if let Some(ref cat) = category {
                url.push_str(&format!("{}category={}", sep, cat));
                sep = '&';
            }
            if let Some(ref tag_list) = tags {
                if !tag_list.is_empty() {
                    url.push_str(&format!("{}tags={}", sep, tag_list.join(",")));
                    sep = '&';
                }
            }
            if let Some(ref price) = max_price {
                let micro = (price.parse::<f64>().unwrap_or(0.0) * 1_000_000.0) as i64;
                url.push_str(&format!("{}max_price_micro_usdc={}", sep, micro));
                sep = '&';
            }
            if let Some(min_rep) = min_reputation {
                url.push_str(&format!("{}min_reputation={}", sep, min_rep));
                sep = '&';
            }
            url.push_str(&format!("{}limit={}", sep, limit));

            let body: serde_json::Value = http
                .get(&url)
                .timeout(Duration::from_secs(15))
                .send()
                .await
                .map_err(|e| format!("HTTP error: {e}"))?
                .json()
                .await
                .map_err(|e| format!("JSON error: {e}"))?;

            let services = body.get("services").and_then(|s| s.as_array());
            match services {
                None => println!("No services found (or unexpected API response)."),
                Some(svcs) if svcs.is_empty() => println!("No services found."),
                Some(svcs) => {
                    println!(
                        "{:<30} {:<50} {:<14} {:<12}",
                        "Slug / ID", "Base URL", "Price (USDC)", "Category"
                    );
                    println!("{}", "-".repeat(106));
                    for svc in svcs.iter().take(limit) {
                        let slug = svc
                            .get("slug")
                            .or_else(|| svc.get("id"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("-");
                        let base = svc.get("base_url").and_then(|v| v.as_str()).unwrap_or("-");
                        let price = svc
                            .get("price_micro_usdc")
                            .and_then(|v| v.as_u64())
                            .map(|p| p as f64 / 1_000_000.0)
                            .unwrap_or(0.0);
                        let cat = svc.get("category").and_then(|v| v.as_str()).unwrap_or("-");
                        println!("{:<30} {:<50} {:<14.6} {:<12}", slug, base, price, cat);
                    }
                    println!();
                    println!("  {} service(s) found.", svcs.len().min(limit));
                    println!("  Run `said discover evaluate <slug>` for a trust assessment.");
                }
            }
        }

        DiscoverAction::Evaluate { slug, rpc_url, api_url } => {
            println!("Evaluating service: {}", slug);
            println!();

            // Fetch service details from cloud
            let svc_data: serde_json::Value = http
                .get(format!("{}/v1/services/{}", api_url, slug))
                .timeout(Duration::from_secs(10))
                .send()
                .await
                .map_err(|e| format!("Service lookup failed: {e}"))?
                .json()
                .await
                .map_err(|e| format!("JSON error: {e}"))?;

            let service = svc_data
                .get("service")
                .ok_or_else(|| format!("Service '{}' not found", slug))?;

            let provider_did = service
                .get("provider_did")
                .or_else(|| service.get("did"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let base_url = service.get("base_url").and_then(|v| v.as_str()).unwrap_or("-");
            let price_micro = service.get("price_micro_usdc").and_then(|v| v.as_u64()).unwrap_or(0);

            // Fetch cloud reputation
            let (cloud_score, cloud_confidence) = if !provider_did.is_empty() {
                let rep_resp = http
                    .get(format!("{}/v1/reputation/{}", api_url, provider_did))
                    .timeout(Duration::from_secs(8))
                    .send()
                    .await
                    .ok();
                let rep_data: serde_json::Value = match rep_resp {
                    Some(r) => r.json().await.unwrap_or_default(),
                    None => serde_json::Value::Null,
                };
                let score = rep_data.get("overall_score").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32;
                let conf = rep_data.get("confidence").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32;
                (score, conf)
            } else {
                (0.0f32, 0.0f32)
            };

            // Resolve identity for on-chain PDA info
            let identity_pda: Option<String> = if !provider_did.is_empty() {
                let resolve_resp = http
                    .get(format!("{}/v1/resolve/{}", api_url, provider_did))
                    .timeout(Duration::from_secs(5))
                    .send()
                    .await
                    .ok();
                let resolve_data: serde_json::Value = match resolve_resp {
                    Some(r) => r.json().await.unwrap_or_default(),
                    None => serde_json::Value::Null,
                };
                resolve_data
                    .get("identity_pda")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            } else {
                None
            };

            let verified = service.get("verified").and_then(|v| v.as_bool()).unwrap_or(false);
            let on_chain_registered = identity_pda.is_some()
                || service.get("on_chain_registered").and_then(|v| v.as_bool()).unwrap_or(false);

            let mut composite = cloud_score;
            if verified {
                composite = (composite + 0.1).min(1.0);
            }
            if on_chain_registered {
                composite = (composite + 0.05).min(1.0);
            }

            let recommendation = if composite >= 0.7 {
                "pay  (good reputation)"
            } else if composite >= 0.3 {
                "caution  (moderate reputation)"
            } else {
                "reject  (low reputation)"
            };

            println!("  Service:        {}", slug);
            println!("  Base URL:       {}", base_url);
            println!("  Price:          {:.6} USDC", price_micro as f64 / 1_000_000.0);
            println!("  Provider DID:   {}", if provider_did.is_empty() { "(none)" } else { &provider_did });
            println!("  Verified:       {}", verified);
            println!("  On-chain:       {} (RPC: {})", on_chain_registered, rpc_url);
            if let Some(ref pda) = identity_pda {
                println!("  Identity PDA:   {}", pda);
            }
            println!("  Cloud Score:    {:.2}  (confidence: {:.2})", cloud_score, cloud_confidence);
            println!("  Composite:      {:.2}", composite);
            println!("  Recommendation: {}", recommendation);
        }
    }

    Ok(())
}

fn print_agent_limits(
    wallet: &Wallet,
    agent: &said_types::AgentWallet,
) -> std::result::Result<(), Box<dyn std::error::Error>> {
    let txs = wallet.transaction_history(Some(agent.id), 1000)?;
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

    let p = &agent.spending_policy;
    println!("Agent: {} ({})", agent.label, agent.solana_address);
    println!("Active: {}", agent.active);
    println!();

    println!("SOL Limits (24h):");
    if let Some(daily) = p.daily_limit_lamports {
        println!(
            "  Daily:   {:.9} / {:.9} SOL",
            sol_spent as f64 / 1e9,
            daily as f64 / 1e9
        );
    } else {
        println!("  Daily:   {:.9} SOL (unlimited)", sol_spent as f64 / 1e9);
    }
    if let Some(per_tx) = p.per_tx_limit_lamports {
        println!("  Per-TX:  {:.9} SOL", per_tx as f64 / 1e9);
    }

    println!();
    println!("USDC Limits (24h):");
    if let Some(daily) = p.daily_limit_usdc_micro {
        println!(
            "  Daily:   {:.6} / {:.6} USDC",
            usdc_spent as f64 / 1e6,
            daily as f64 / 1e6
        );
    } else {
        println!("  Daily:   {:.6} USDC (unlimited)", usdc_spent as f64 / 1e6);
    }
    if let Some(per_tx) = p.per_tx_limit_usdc_micro {
        println!("  Per-TX:  {:.6} USDC", per_tx as f64 / 1e6);
    }

    if !p.allowed_recipients.is_empty() {
        println!();
        println!("Allowed Recipients:");
        for r in &p.allowed_recipients {
            println!("  - {}", r);
        }
    }

    Ok(())
}
