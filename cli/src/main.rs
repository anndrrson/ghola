use std::path::PathBuf;

use clap::{Parser, Subcommand};

use said_core::Wallet;
use said_types::{KnowledgeDoc, McpConfig, Memory, Preference, SystemPrompt};

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
    /// Start the MCP server (stdio transport)
    Serve,
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

        Commands::Serve => {
            said_mcp::run().await?;
        }
    }

    Ok(())
}
