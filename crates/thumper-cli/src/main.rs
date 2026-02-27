use std::io::Write;
use std::path::PathBuf;

use clap::{Parser, Subcommand};
use tracing_subscriber::EnvFilter;

#[derive(Parser)]
#[command(
    name = "thumper",
    about = "Thumper — AI-powered remote control for Android devices",
    version
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand)]
enum Commands {
    /// Start the MCP server over stdio (default if no subcommand given)
    Serve,
    /// Start the relay server
    Relay {
        /// Bind address (overrides THUMPER_RELAY_BIND env var)
        #[arg(short, long)]
        bind: Option<String>,
        /// Enable dev mode (skip signature verification)
        #[arg(long)]
        dev: bool,
    },
    /// Check relay and device connectivity
    Status {
        /// Relay URL to check (default: from config)
        #[arg(short, long)]
        relay_url: Option<String>,
    },
    /// Set up or view the config file (~/.thumper/config.toml)
    Config {
        /// Set relay URL
        #[arg(long)]
        relay_url: Option<String>,
        /// Set MCP client pubkey
        #[arg(long)]
        mcp_pubkey: Option<String>,
        /// Set target device pubkey
        #[arg(long)]
        device_pubkey: Option<String>,
        /// Generate a new Ed25519 keypair for the MCP client
        #[arg(long)]
        generate_key: bool,
    },
    /// Print the Claude Code MCP server config snippet
    Install,
    /// Generate a QR code for Android device configuration
    Qr {
        /// Relay URL to encode (default: from config)
        #[arg(long)]
        relay_url: Option<String>,
    },
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();

    match cli.command.unwrap_or(Commands::Serve) {
        Commands::Serve => cmd_serve().await,
        Commands::Relay { bind, dev } => cmd_relay(bind, dev).await,
        Commands::Status { relay_url } => cmd_status(relay_url).await,
        Commands::Config {
            relay_url,
            mcp_pubkey,
            device_pubkey,
            generate_key,
        } => cmd_config(relay_url, mcp_pubkey, device_pubkey, generate_key),
        Commands::Install => cmd_install(),
        Commands::Qr { relay_url } => cmd_qr(relay_url),
    }
}

/// Start the MCP server over stdio.
async fn cmd_serve() {
    if let Err(e) = thumper_mcp::run().await {
        eprintln!("Error: {}", e);
        std::process::exit(1);
    }
}

/// Start the relay server.
async fn cmd_relay(bind: Option<String>, dev: bool) {
    // Set env vars before relay reads them
    if let Some(addr) = bind {
        std::env::set_var("THUMPER_RELAY_BIND", &addr);
    }
    if dev {
        std::env::set_var("THUMPER_DEV_MODE", "true");
    }

    init_tracing();

    if let Err(e) = thumper_relay::run_relay().await {
        eprintln!("Error: {}", e);
        std::process::exit(1);
    }
}

/// Check relay and device connectivity.
async fn cmd_status(relay_url_override: Option<String>) {
    let relay_url = relay_url_override
        .or_else(|| {
            load_config_value("relay_url")
                .map(|u| u.replace("ws://", "http://").replace("wss://", "https://"))
                .map(|u| {
                    // Strip /ws path to get base URL for /health
                    if u.ends_with("/ws") {
                        u[..u.len() - 3].to_string()
                    } else {
                        u
                    }
                })
        })
        .unwrap_or_else(|| "http://localhost:8080".to_string());

    let health_url = if relay_url.ends_with("/health") {
        relay_url.clone()
    } else {
        format!("{}/health", relay_url.trim_end_matches('/'))
    };

    println!("Checking relay at {}...", health_url);

    match reqwest::get(&health_url).await {
        Ok(resp) => {
            if resp.status().is_success() {
                match resp.json::<serde_json::Value>().await {
                    Ok(body) => {
                        let status = body.get("status").and_then(|v| v.as_str()).unwrap_or("unknown");
                        let devices = body.get("devices").and_then(|v| v.as_u64()).unwrap_or(0);
                        let mcp_clients = body.get("mcp_clients").and_then(|v| v.as_u64()).unwrap_or(0);

                        println!("Relay:       {} ({})", if status == "ok" { "ONLINE" } else { status }, relay_url);
                        println!("Devices:     {}", devices);
                        println!("MCP Clients: {}", mcp_clients);
                    }
                    Err(e) => {
                        println!("Relay responded but returned invalid JSON: {}", e);
                    }
                }
            } else {
                println!("Relay returned status {}", resp.status());
            }
        }
        Err(e) => {
            println!("Relay:       OFFLINE");
            println!("Error:       {}", e);
        }
    }

    // Show config info
    let config_path = config_file_path();
    if config_path.exists() {
        println!("\nConfig:      {}", config_path.display());
        if let Some(dpk) = load_config_value("device_pubkey") {
            println!("Device Key:  {}", dpk);
        }
        if let Some(mpk) = load_config_value("mcp_pubkey") {
            println!("MCP Key:     {}", mpk);
        }
    } else {
        println!("\nConfig:      not found (run `thumper config` to create)");
    }
}

/// Set up or view configuration.
fn cmd_config(
    relay_url: Option<String>,
    mcp_pubkey: Option<String>,
    device_pubkey: Option<String>,
    generate_key: bool,
) {
    let config_path = config_file_path();
    let config_dir = config_path.parent().unwrap();

    // Load existing config or start fresh
    let mut config = if config_path.exists() {
        let contents = std::fs::read_to_string(&config_path).unwrap_or_default();
        toml::from_str::<toml::Table>(&contents).unwrap_or_default()
    } else {
        toml::Table::new()
    };

    let mut changed = false;

    if let Some(url) = relay_url {
        config.insert("relay_url".into(), toml::Value::String(url));
        changed = true;
    }

    if let Some(pk) = mcp_pubkey {
        config.insert("mcp_pubkey".into(), toml::Value::String(pk));
        changed = true;
    }

    if let Some(pk) = device_pubkey {
        config.insert("device_pubkey".into(), toml::Value::String(pk));
        changed = true;
    }

    if generate_key {
        let keypair = generate_ed25519_keypair();
        config.insert("mcp_pubkey".into(), toml::Value::String(keypair.pubkey.clone()));
        changed = true;
        println!("Generated new MCP keypair:");
        println!("  Public key:  {}", keypair.pubkey);
        println!("  Secret key:  {}", keypair.secret);
        println!("  (Secret key saved to ~/.thumper/mcp_key)");

        // Save secret key separately
        std::fs::create_dir_all(config_dir).ok();
        let key_path = config_dir.join("mcp_key");
        std::fs::write(&key_path, &keypair.secret).ok();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600)).ok();
        }
    }

    if changed {
        // Ensure defaults exist
        if !config.contains_key("relay_url") {
            config.insert(
                "relay_url".into(),
                toml::Value::String("ws://localhost:8080/ws".into()),
            );
        }
        if !config.contains_key("mcp_pubkey") {
            config.insert(
                "mcp_pubkey".into(),
                toml::Value::String("not_configured".into()),
            );
        }
        if !config.contains_key("device_pubkey") {
            config.insert(
                "device_pubkey".into(),
                toml::Value::String("not_configured".into()),
            );
        }
        if !config.contains_key("timeout_secs") {
            config.insert("timeout_secs".into(), toml::Value::Integer(10));
        }

        std::fs::create_dir_all(config_dir).ok();
        let toml_str = toml::to_string_pretty(&config).unwrap();
        std::fs::write(&config_path, &toml_str).expect("failed to write config");
        println!("Config saved to {}", config_path.display());
    } else {
        // Show current config
        if config_path.exists() {
            let contents = std::fs::read_to_string(&config_path).unwrap_or_default();
            println!("Config file: {}\n", config_path.display());
            println!("{}", contents);
        } else {
            println!("No config file found at {}", config_path.display());
            println!("\nCreate one with:");
            println!("  thumper config --relay-url ws://localhost:8080/ws --generate-key");
            println!("\nOr set environment variables:");
            println!("  THUMPER_RELAY_URL, THUMPER_MCP_PUBKEY, THUMPER_DEVICE_PUBKEY");
        }
    }
}

/// Print the Claude Code MCP server config snippet.
fn cmd_install() {
    // Find the thumper binary path
    let thumper_path = std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "thumper".to_string());

    // Use the serve subcommand explicitly
    let config = serde_json::json!({
        "mcpServers": {
            "thumper": {
                "command": thumper_path,
                "args": ["serve"],
                "env": {}
            }
        }
    });

    let pretty = serde_json::to_string_pretty(&config).unwrap();

    println!("Add this to your Claude Code MCP config:\n");
    println!("{}", pretty);
    println!();
    println!("Config locations:");
    println!("  Claude Code:  ~/.claude/claude_desktop_config.json");
    println!("  Cursor:       .cursor/mcp.json");
    println!();

    // Also offer to copy to clipboard on macOS
    #[cfg(target_os = "macos")]
    {
        if let Ok(mut child) = std::process::Command::new("pbcopy")
            .stdin(std::process::Stdio::piped())
            .spawn()
        {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(pretty.as_bytes());
            }
            let _ = child.wait();
            println!("(Copied to clipboard)");
        }
    }
}

/// Generate a QR code for Android device configuration.
fn cmd_qr(relay_url_override: Option<String>) {
    let relay_url = relay_url_override
        .or_else(|| load_config_value("relay_url"))
        .unwrap_or_else(|| "ws://localhost:8080/ws".to_string());

    let mcp_pubkey = load_config_value("mcp_pubkey").unwrap_or_else(|| "not_configured".to_string());

    // Encode config as a simple JSON payload
    let payload = serde_json::json!({
        "relay_url": relay_url,
        "mcp_pubkey": mcp_pubkey,
    });

    let payload_str = serde_json::to_string(&payload).unwrap();

    println!("Scan this QR code with the Thumper Android app:\n");

    // Generate QR code for terminal display
    match qrcode::QrCode::new(payload_str.as_bytes()) {
        Ok(code) => {
            let string = code
                .render::<char>()
                .quiet_zone(true)
                .module_dimensions(2, 1)
                .build();
            println!("{}", string);
        }
        Err(e) => {
            eprintln!("Failed to generate QR code: {}", e);
            std::process::exit(1);
        }
    }

    println!("\nEncoded data:");
    println!("  Relay URL: {}", relay_url);
    println!("  MCP Key:   {}", mcp_pubkey);
    println!("\nOr manually enter the relay URL in the Android app:");
    println!("  {}", relay_url);
}

// -- Helpers --

fn init_tracing() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();
}

fn config_file_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".thumper")
        .join("config.toml")
}

fn load_config_value(key: &str) -> Option<String> {
    let path = config_file_path();
    if !path.exists() {
        return None;
    }
    let contents = std::fs::read_to_string(&path).ok()?;
    let table: toml::Table = toml::from_str(&contents).ok()?;
    table.get(key)?.as_str().map(|s| s.to_string())
}

struct KeypairOutput {
    pubkey: String,
    secret: String,
}

fn generate_ed25519_keypair() -> KeypairOutput {
    use ed25519_dalek::SigningKey;
    use rand::rngs::OsRng;

    let signing_key = SigningKey::generate(&mut OsRng);
    let verifying_key = signing_key.verifying_key();

    // Encode pubkey as base58 (Solana-style)
    let pubkey = bs58_encode(verifying_key.as_bytes());
    // Encode full 64-byte keypair as base64
    let mut full_key = [0u8; 64];
    full_key[..32].copy_from_slice(&signing_key.to_bytes());
    full_key[32..].copy_from_slice(verifying_key.as_bytes());
    let secret = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &full_key);

    KeypairOutput { pubkey, secret }
}

fn bs58_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

    if bytes.is_empty() {
        return String::new();
    }

    // Count leading zeros
    let mut leading_zeros = 0;
    for &b in bytes {
        if b == 0 {
            leading_zeros += 1;
        } else {
            break;
        }
    }

    // Convert to base58
    let mut digits: Vec<u8> = Vec::new();
    for &b in bytes {
        let mut carry = b as u32;
        for d in digits.iter_mut() {
            let val = (*d as u32) * 256 + carry;
            *d = (val % 58) as u8;
            carry = val / 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }

    let mut result = String::new();
    for _ in 0..leading_zeros {
        result.push(ALPHABET[0] as char);
    }
    for &d in digits.iter().rev() {
        result.push(ALPHABET[d as usize] as char);
    }

    result
}
