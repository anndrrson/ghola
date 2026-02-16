use std::path::PathBuf;
use std::time::Duration;

use clap::{Parser, Subcommand};

use said_core::Wallet;
use said_types::{
    Capability, KnowledgeDoc, McpConfig, Memory, Preference, Provider, SystemPrompt,
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
    /// Initialize a new SAID wallet
    Init {
        /// Number of words in the mnemonic (12 or 24)
        #[arg(long, default_value = "24")]
        words: usize,
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

fn parse_provider(name: &str) -> Result<Provider, String> {
    match name.to_lowercase().as_str() {
        "master" => Ok(Provider::Master),
        "openai" => Ok(Provider::OpenAI),
        "anthropic" => Ok(Provider::Anthropic),
        "google" => Ok(Provider::Google),
        "local" => Ok(Provider::Local),
        _ => Err(format!(
            "unknown provider '{}': use master, openai, anthropic, google, or local",
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
        Commands::Init { words } => {
            if words != 12 && words != 24 {
                return Err("--words must be 12 or 24".into());
            }
            let (_, phrase) = Wallet::init(&dir)?;

            println!("Wallet initialized at: {}", dir.display());
            println!();
            println!("IMPORTANT: Write down your recovery phrase and store it safely.");
            println!("This is the ONLY way to recover your wallet if lost.");
            println!();
            println!("Recovery phrase ({} words):", words);
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

            Wallet::recover(phrase, &dir)?;
            println!("Wallet recovered at: {}", dir.display());
        }

        Commands::Status => {
            let metadata = Wallet::load_metadata(&dir)?;
            let wallet = Wallet::load(&dir)?;

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
            let wallet = Wallet::load(&dir)?;

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
            let wallet = Wallet::load(&dir)?;

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

        Commands::Provider { action } => {
            let wallet = Wallet::load(&dir)?;

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
                let wallet = Wallet::load(&dir)?;
                said_mcp::run_http(wallet, port).await?;
            } else {
                said_mcp::run().await?;
            }
        }
    }

    Ok(())
}
