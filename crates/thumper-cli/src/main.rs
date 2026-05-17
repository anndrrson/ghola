use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Instant;

use clap::{Parser, Subcommand};
use futures::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use axum::extract::Query;
use axum::response::Html;
use tracing_subscriber::EnvFilter;

#[derive(Parser)]
#[command(
    name = "ghola",
    about = "Ghola — your AI, your hardware",
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
    /// Set up or view the config file (~/.ghola/config.toml)
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
    /// Log in via browser and save API key
    Login {
        /// Cloud URL to authenticate against
        #[arg(long, default_value = "https://ghola.xyz")]
        cloud_url: String,
    },
    /// Serve GPU inference to the Ghola network
    GpuServe {
        /// Local inference server URL (default: http://localhost:11434 for Ollama)
        #[arg(long, default_value = "http://localhost:11434")]
        inference_url: String,
        /// Relay server URL
        #[arg(long)]
        relay_url: Option<String>,
        /// Cloud API URL for registration
        #[arg(long)]
        cloud_url: Option<String>,
        /// Provider display name
        #[arg(long, default_value = "GPU Provider")]
        name: String,
        /// Price per 1K input tokens in micro-USDC
        #[arg(long, default_value = "10")]
        price_input: u64,
        /// Price per 1K output tokens in micro-USDC
        #[arg(long, default_value = "30")]
        price_output: u64,
        /// Max concurrent inference requests
        #[arg(long, default_value = "2")]
        max_concurrent: u32,
        /// GPU VRAM in MB
        #[arg(long, default_value = "0")]
        vram: u32,
        /// JWT auth token (or set GHOLA_TOKEN env var)
        #[arg(long)]
        token: Option<String>,
        /// Wallet address for receiving payments
        #[arg(long)]
        wallet_address: Option<String>,
    },
    /// Install, check Ollama, auto-pull a model, authenticate, and start earning — all in one command
    Up {
        /// Local inference server URL
        #[arg(long, default_value = "http://localhost:11434")]
        inference_url: String,
        /// Provider display name (defaults to hostname)
        #[arg(long)]
        name: Option<String>,
    },
}

#[tokio::main]
async fn main() {
    migrate_config_dir();

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
        Commands::Login { cloud_url } => cmd_login(cloud_url).await,
        Commands::GpuServe {
            inference_url,
            relay_url,
            cloud_url,
            name,
            price_input,
            price_output,
            max_concurrent,
            vram,
            token,
            wallet_address,
        } => {
            init_tracing();
            cmd_gpu_serve(
                inference_url,
                relay_url,
                cloud_url,
                name,
                price_input,
                price_output,
                max_concurrent,
                vram,
                token,
                wallet_address,
            )
            .await;
        }
        Commands::Up {
            inference_url,
            name,
        } => {
            init_tracing();
            cmd_up(inference_url, name).await;
        }
    }
}

/// Migrate config from ~/.thumper/ to ~/.ghola/ if needed.
fn migrate_config_dir() {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let old_dir = home.join(".thumper");
    let new_dir = home.join(".ghola");

    if old_dir.exists() && !new_dir.exists() {
        std::fs::create_dir_all(&new_dir).ok();
        // Copy config.toml
        let old_config = old_dir.join("config.toml");
        if old_config.exists() {
            std::fs::copy(&old_config, new_dir.join("config.toml")).ok();
        }
        // Copy mcp_key
        let old_key = old_dir.join("mcp_key");
        if old_key.exists() {
            std::fs::copy(&old_key, new_dir.join("mcp_key")).ok();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(
                    new_dir.join("mcp_key"),
                    std::fs::Permissions::from_mode(0o600),
                )
                .ok();
            }
        }
        println!("Migrated config from ~/.thumper/ to ~/.ghola/");
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
        println!("\nConfig:      not found (run `ghola config` to create)");
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
        println!("  (Secret key saved to ~/.ghola/mcp_key)");

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
            println!("  ghola config --relay-url ws://localhost:8080/ws --generate-key");
            println!("\nOr set environment variables:");
            println!("  THUMPER_RELAY_URL, THUMPER_MCP_PUBKEY, THUMPER_DEVICE_PUBKEY");
        }
    }
}

/// Print the Claude Code MCP server config snippet.
fn cmd_install() {
    // Find the ghola binary path
    let ghola_path = std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "ghola".to_string());

    // Use the serve subcommand explicitly
    let config = serde_json::json!({
        "mcpServers": {
            "ghola": {
                "command": ghola_path,
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

    println!("Scan this QR code with the Ghola Android app:\n");

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

/// Perform browser-based OAuth login and return the token.
async fn do_browser_login(cloud_url: String) -> String {
    // Bind a local HTTP server on a random port
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("failed to bind local callback server");
    let port = listener.local_addr().unwrap().port();

    println!("Opening browser for authentication...");
    let auth_url = format!("{}/auth/cli?callback_port={}", cloud_url, port);

    // Try to open browser
    if let Err(e) = open::that(&auth_url) {
        println!("Could not open browser automatically: {}", e);
        println!("Please open this URL manually:\n  {}", auth_url);
    }

    // Set up single-use callback server
    let (tx, mut rx) = tokio::sync::oneshot::channel::<String>();
    let tx = std::sync::Arc::new(tokio::sync::Mutex::new(Some(tx)));

    #[derive(serde::Deserialize)]
    struct CallbackParams {
        token: Option<String>,
        error: Option<String>,
    }

    let tx_clone = tx.clone();
    let app = axum::Router::new().route(
        "/callback",
        axum::routing::get(move |Query(params): Query<CallbackParams>| {
            let tx = tx_clone.clone();
            async move {
                if let Some(token) = params.token {
                    if let Some(sender) = tx.lock().await.take() {
                        let _ = sender.send(token);
                    }
                    Html(
                        "<html><body style=\"background:#08090d;color:#eef1f8;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0\">\
                        <div style=\"text-align:center\"><h1>Authenticated!</h1><p>You can close this tab and return to your terminal.</p></div>\
                        </body></html>"
                            .to_string(),
                    )
                } else {
                    let msg = params.error.unwrap_or_else(|| "Unknown error".to_string());
                    Html(format!(
                        "<html><body style=\"background:#08090d;color:#eef1f8;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0\">\
                        <div style=\"text-align:center\"><h1>Authentication Failed</h1><p>{}</p></div>\
                        </body></html>",
                        msg
                    ))
                }
            }
        }),
    );

    println!("Waiting for authentication (listening on port {})...", port);

    // Serve with a timeout
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.ok();
    });

    // Wait for token with 5-minute timeout
    let token = tokio::select! {
        result = &mut rx => {
            match result {
                Ok(t) => t,
                Err(_) => {
                    eprintln!("Authentication was cancelled.");
                    std::process::exit(1);
                }
            }
        }
        _ = tokio::time::sleep(std::time::Duration::from_secs(300)) => {
            eprintln!("Authentication timed out after 5 minutes.");
            std::process::exit(1);
        }
    };

    server.abort();
    token
}

/// Log in via browser OAuth and save the provider API key locally.
async fn cmd_login(cloud_url: String) {
    let token = do_browser_login(cloud_url).await;

    // Save token to config
    let config_path = config_file_path();
    let config_dir = config_path.parent().unwrap();
    std::fs::create_dir_all(config_dir).ok();

    let mut config = if config_path.exists() {
        let contents = std::fs::read_to_string(&config_path).unwrap_or_default();
        toml::from_str::<toml::Table>(&contents).unwrap_or_default()
    } else {
        toml::Table::new()
    };

    config.insert("token".into(), toml::Value::String(token));

    let toml_str = toml::to_string_pretty(&config).expect("failed to serialize config");
    std::fs::write(&config_path, toml_str).expect("failed to write config");

    println!("Logged in successfully! Token saved to {}", config_path.display());
    println!("\nRun `ghola up` to start providing GPU compute.");
}

/// `ghola up` — the 2-command onboarding experience.
/// Checks Ollama, auto-pulls a model, authenticates if needed, and starts serving.
async fn cmd_up(inference_url: String, name: Option<String>) {
    println!("\n\x1b[1m━━━ Ghola Provider Setup ━━━━━━━━━━━━━━━━━━━\x1b[0m\n");

    // 1. Check Ollama
    print!("  Checking Ollama at {}... ", inference_url);
    std::io::stdout().flush().ok();
    let client = reqwest::Client::new();
    let base = inference_url.trim_end_matches('/');
    match client.get(format!("{}/api/tags", base)).send().await {
        Ok(resp) if resp.status().is_success() => {
            println!("\x1b[32m✓ running\x1b[0m");
        }
        _ => {
            println!("\x1b[31m✗ not reachable\x1b[0m");
            println!();
            println!("  Ollama is not running. Install and start it first:");
            println!("    curl -fsSL https://ollama.ai/install.sh | sh");
            println!("    ollama serve");
            println!();
            println!("  Then re-run: ghola up");
            std::process::exit(1);
        }
    }

    // 2. Check models
    let discovered_models = discover_models(&inference_url).await;
    if discovered_models.is_empty() {
        println!("  No models found. Pulling llama3.2...\n");
        let pull_status = std::process::Command::new("ollama")
            .args(["pull", "llama3.2"])
            .stdout(std::process::Stdio::inherit())
            .stderr(std::process::Stdio::inherit())
            .status();
        match pull_status {
            Ok(s) if s.success() => {
                println!();
            }
            _ => {
                eprintln!("\n  Failed to pull llama3.2. Pull a model manually:");
                eprintln!("    ollama pull llama3.2");
                std::process::exit(1);
            }
        }
    } else {
        println!("  Models: {} found ({})", discovered_models.len(),
            discovered_models.iter().take(3).cloned().collect::<Vec<_>>().join(", "));
    }

    // 3. Check auth
    let auth_token = std::env::var("GHOLA_TOKEN").ok()
        .or_else(|| load_config_value("token"))
        .unwrap_or_default();

    let auth_token = if auth_token.is_empty() {
        println!("  No auth token found. Logging in via browser...\n");
        let token = do_browser_login("https://ghola.xyz".to_string()).await;

        // Save token
        let config_path = config_file_path();
        let config_dir = config_path.parent().unwrap();
        std::fs::create_dir_all(config_dir).ok();
        let mut config = if config_path.exists() {
            let contents = std::fs::read_to_string(&config_path).unwrap_or_default();
            toml::from_str::<toml::Table>(&contents).unwrap_or_default()
        } else {
            toml::Table::new()
        };
        config.insert("token".into(), toml::Value::String(token.clone()));
        let toml_str = toml::to_string_pretty(&config).expect("failed to serialize config");
        std::fs::write(&config_path, toml_str).expect("failed to write config");
        println!("  \x1b[32m✓ Logged in\x1b[0m — token saved to {}", config_path.display());

        token
    } else {
        println!("  \x1b[32m✓ Authenticated\x1b[0m");
        auth_token
    };

    // 4. Resolve provider name
    let provider_name = name.unwrap_or_else(|| {
        std::process::Command::new("hostname")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "GPU Provider".to_string())
    });

    println!("  Name: {}", provider_name);
    println!();

    // 5. Delegate to gpu-serve with defaults
    cmd_gpu_serve(
        inference_url,
        None,          // relay_url — use default
        None,          // cloud_url — use default
        provider_name,
        10,            // price_input
        30,            // price_output
        2,             // max_concurrent
        0,             // vram
        Some(auth_token),
        None,          // wallet_address
    )
    .await;
}

/// Run the GPU inference provider, connecting to the relay and forwarding
/// inference requests to a local model server (Ollama / OpenAI-compatible).
async fn cmd_gpu_serve(
    inference_url: String,
    relay_url: Option<String>,
    cloud_url: Option<String>,
    name: String,
    price_input: u64,
    price_output: u64,
    max_concurrent: u32,
    vram: u32,
    token: Option<String>,
    wallet_address: Option<String>,
) {
    // 1. Auth token
    let auth_token = token
        .or_else(|| std::env::var("GHOLA_TOKEN").ok())
        .or_else(|| load_config_value("token"))
        .unwrap_or_default();

    if auth_token.is_empty() {
        eprintln!("Error: No auth token provided. Run `ghola up` or `ghola login` first.");
        std::process::exit(1);
    }

    // 2. Discover models from local inference server
    let discovered_models = discover_models(&inference_url).await;
    if discovered_models.is_empty() {
        println!("Warning: No models discovered from {}. Provider will advertise an empty model list.", inference_url);
    } else {
        println!("Discovered {} model(s):", discovered_models.len());
        for m in &discovered_models {
            println!("  - {}", m);
        }
    }

    // 3. Build model info
    let model_infos: Vec<thumper_types::ProviderModelInfo> = discovered_models
        .iter()
        .map(|model_id| thumper_types::ProviderModelInfo {
            model_id: model_id.clone(),
            context_length: 8192,
            price_per_1k_input: price_input,
            price_per_1k_output: price_output,
        })
        .collect();

    // 4. Register with cloud (optional)
    let mcp_pubkey = load_config_value("mcp_pubkey").unwrap_or_else(|| "unknown".to_string());
    let wallet = wallet_address
        .or_else(|| load_config_value("wallet_address"))
        .unwrap_or_default();

    let cloud_url = cloud_url.unwrap_or_else(|| "https://ghola.xyz".to_string());
    {
        let cloud = &cloud_url;
        println!("Registering with cloud at {}...", cloud);
        let client = reqwest::Client::new();
        let reg_body = serde_json::json!({
            "relay_pubkey": mcp_pubkey,
            "display_name": name,
            "models": model_infos,
            "vram_mb": vram,
            "max_concurrent": max_concurrent,
            "wallet_address": wallet,
        });

        match client
            .post(format!("{}/api/compute/providers/register", cloud))
            .bearer_auth(&auth_token)
            .json(&reg_body)
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                println!("Cloud registration successful.");
            }
            Ok(resp) => {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                println!(
                    "Warning: Cloud registration failed ({}): {}. Continuing without cloud.",
                    status, body
                );
            }
            Err(e) => {
                println!(
                    "Warning: Could not reach cloud ({}). Continuing without cloud.",
                    e
                );
            }
        }
    }

    // 5. Resolve relay URL
    let relay = relay_url
        .or_else(|| load_config_value("relay_url"))
        .unwrap_or_else(|| "wss://thumper-relay.onrender.com/ws".to_string());

    // 6. Load or generate keypair
    let config_dir = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".ghola");
    let key_path = config_dir.join("mcp_key");

    let (signing_key, pubkey_b58) = if key_path.exists() {
        let key_data = std::fs::read_to_string(&key_path).unwrap_or_default();
        let key_bytes =
            base64::Engine::decode(&base64::engine::general_purpose::STANDARD, key_data.trim())
                .expect("failed to decode mcp_key");
        let sk = ed25519_dalek::SigningKey::from_bytes(
            key_bytes[..32]
                .try_into()
                .expect("mcp_key must be at least 32 bytes"),
        );
        let pk = sk.verifying_key();
        let pk_b58 = bs58_encode(pk.as_bytes());
        println!("Loaded keypair: {}", pk_b58);
        (sk, pk_b58)
    } else {
        let kp = generate_ed25519_keypair();
        std::fs::create_dir_all(&config_dir).ok();
        std::fs::write(&key_path, &kp.secret).ok();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600)).ok();
        }
        println!("Generated new keypair: {}", kp.pubkey);
        // Decode secret to get SigningKey
        let key_bytes = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            kp.secret.trim(),
        )
        .expect("failed to decode generated key");
        let sk = ed25519_dalek::SigningKey::from_bytes(
            key_bytes[..32]
                .try_into()
                .expect("key must be at least 32 bytes"),
        );
        (sk, kp.pubkey)
    };

    let active_jobs = Arc::new(AtomicU32::new(0));
    let total_requests = Arc::new(AtomicU32::new(0));
    let start_time = Instant::now();
    let model_names: Vec<String> = discovered_models.clone();
    let model_count = model_names.len();

    // 7 & 8. Connect to relay with reconnection loop
    let mut backoff_secs: u64 = 1;

    loop {
        println!("Connecting to relay at {}...", relay);

        let ws_result = tokio_tungstenite::connect_async(&relay).await;
        let (ws_stream, _response) = match ws_result {
            Ok(pair) => {
                backoff_secs = 1; // reset on successful connect
                pair
            }
            Err(e) => {
                eprintln!("Failed to connect to relay: {}. Retrying in {}s...", e, backoff_secs);
                tokio::time::sleep(std::time::Duration::from_secs(backoff_secs)).await;
                backoff_secs = (backoff_secs * 2).min(60);
                continue;
            }
        };

        let (mut ws_write, mut ws_read) = ws_stream.split();

        // Send auth payload
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let nonce = uuid::Uuid::new_v4().to_string();

        let auth_msg = thumper_types::AuthMessage {
            pubkey: pubkey_b58.clone(),
            timestamp,
            nonce,
            role: thumper_types::ConnectionRole::GpuProvider,
        };

        let sig_bytes = {
            use ed25519_dalek::Signer;
            signing_key.sign(&auth_msg.canonical_bytes())
        };
        let sig_b64 =
            base64::Engine::encode(&base64::engine::general_purpose::STANDARD, sig_bytes.to_bytes());

        let auth_payload = thumper_types::AuthPayload {
            message: auth_msg,
            signature: sig_b64,
        };

        let auth_json = serde_json::to_string(&auth_payload).unwrap();
        if let Err(e) = ws_write
            .send(tokio_tungstenite::tungstenite::Message::Text(auth_json.into()))
            .await
        {
            eprintln!("Failed to send auth: {}. Reconnecting...", e);
            tokio::time::sleep(std::time::Duration::from_secs(backoff_secs)).await;
            backoff_secs = (backoff_secs * 2).min(60);
            continue;
        }

        // Wait for auth response
        match ws_read.next().await {
            Some(Ok(msg)) => {
                let text = msg.to_text().unwrap_or("");
                if text.contains("error") || text.contains("Error") {
                    eprintln!("Auth rejected: {}. Exiting.", text);
                    std::process::exit(1);
                }
                println!("Authenticated with relay.");
            }
            Some(Err(e)) => {
                eprintln!("Auth response error: {}. Reconnecting...", e);
                tokio::time::sleep(std::time::Duration::from_secs(backoff_secs)).await;
                backoff_secs = (backoff_secs * 2).min(60);
                continue;
            }
            None => {
                eprintln!("Connection closed during auth. Reconnecting...");
                tokio::time::sleep(std::time::Duration::from_secs(backoff_secs)).await;
                backoff_secs = (backoff_secs * 2).min(60);
                continue;
            }
        }

        // Send ProviderAdvertise
        let advertise = thumper_types::Envelope::new(thumper_types::MessageType::ProviderAdvertise(
            thumper_types::ProviderAdvertisePayload {
                name: name.clone(),
                models: model_infos.clone(),
                vram_mb: vram,
                max_concurrent,
                wallet_address: wallet.clone(),
            },
        ));
        let adv_json = serde_json::to_string(&advertise).unwrap();
        if let Err(e) = ws_write
            .send(tokio_tungstenite::tungstenite::Message::Text(adv_json.into()))
            .await
        {
            eprintln!("Failed to send advertise: {}. Reconnecting...", e);
            continue;
        }

        // Wait for ProviderAdvertiseAck
        match ws_read.next().await {
            Some(Ok(msg)) => {
                let text = msg.to_text().unwrap_or("");
                if let Ok(env) = serde_json::from_str::<thumper_types::Envelope>(text) {
                    match &env.message {
                        thumper_types::MessageType::ProviderAdvertiseAck(ack) => {
                            if ack.accepted {
                                println!(
                                    "Provider registered. {}",
                                    ack.message.as_deref().unwrap_or("")
                                );
                            } else {
                                eprintln!(
                                    "Provider registration rejected: {}",
                                    ack.message.as_deref().unwrap_or("unknown reason")
                                );
                                std::process::exit(1);
                            }
                        }
                        _ => {
                            println!("Received unexpected message during registration, continuing...");
                        }
                    }
                } else {
                    println!("Received non-envelope response during advertise, continuing...");
                }
            }
            Some(Err(e)) => {
                eprintln!("Error waiting for advertise ack: {}. Reconnecting...", e);
                continue;
            }
            None => {
                eprintln!("Connection closed during advertise. Reconnecting...");
                continue;
            }
        }

        // Print live status block
        print_status_block(model_count, total_requests.load(Ordering::Relaxed), &start_time);

        // Create channel for sending messages back to the WebSocket
        let (tx, mut rx) = mpsc::unbounded_channel::<tokio_tungstenite::tungstenite::Message>();

        // Spawn heartbeat task
        let heartbeat_tx = tx.clone();
        let heartbeat_active = active_jobs.clone();
        let heartbeat_models = model_names.clone();
        let heartbeat_handle = tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
            loop {
                interval.tick().await;
                let hb = thumper_types::Envelope::new(
                    thumper_types::MessageType::ProviderHeartbeat(
                        thumper_types::ProviderHeartbeatPayload {
                            active_jobs: heartbeat_active.load(Ordering::Relaxed),
                            models: heartbeat_models.clone(),
                            vram_free_mb: None,
                        },
                    ),
                );
                let json = serde_json::to_string(&hb).unwrap();
                if heartbeat_tx
                    .send(tokio_tungstenite::tungstenite::Message::Text(json.into()))
                    .is_err()
                {
                    break;
                }
            }
        });

        // Spawn write task: forwards messages from the channel to the WebSocket
        let write_handle = tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if ws_write.send(msg).await.is_err() {
                    break;
                }
            }
        });

        // Main read loop
        #[allow(unused_assignments)]
        let mut disconnected = false;
        loop {
            tokio::select! {
                msg = ws_read.next() => {
                    match msg {
                        Some(Ok(ws_msg)) => {
                            if ws_msg.is_close() {
                                println!("Relay closed connection.");
                                disconnected = true;
                                break;
                            }
                            let text = match ws_msg.to_text() {
                                Ok(t) => t,
                                Err(_) => continue,
                            };
                            if let Ok(envelope) = serde_json::from_str::<thumper_types::Envelope>(text) {
                                match &envelope.message {
                                    thumper_types::MessageType::InferenceRequest(payload) => {
                                        let inf_url = inference_url.clone();
                                        let sender = tx.clone();
                                        let jobs = active_jobs.clone();
                                        let total = total_requests.clone();
                                        let mc = model_count;
                                        let st = start_time;
                                        let env_clone = envelope.clone();
                                        let payload_clone = payload.clone();
                                        jobs.fetch_add(1, Ordering::Relaxed);
                                        tokio::spawn(async move {
                                            handle_inference_request(
                                                &inf_url,
                                                &env_clone,
                                                &payload_clone,
                                                &sender,
                                            )
                                            .await;
                                            jobs.fetch_sub(1, Ordering::Relaxed);
                                            let reqs = total.fetch_add(1, Ordering::Relaxed) + 1;
                                            print_status_update(mc, reqs, &st);
                                        });
                                    }
                                    thumper_types::MessageType::Ping => {
                                        let pong = envelope.response(thumper_types::MessageType::Pong);
                                        let json = serde_json::to_string(&pong).unwrap();
                                        let _ = tx.send(tokio_tungstenite::tungstenite::Message::Text(json.into()));
                                    }
                                    other => {
                                        println!("Received unhandled message type: {:?}", std::mem::discriminant(other));
                                    }
                                }
                            }
                        }
                        Some(Err(e)) => {
                            eprintln!("WebSocket error: {}.", e);
                            disconnected = true;
                            break;
                        }
                        None => {
                            println!("WebSocket stream ended.");
                            disconnected = true;
                            break;
                        }
                    }
                }
                _ = tokio::signal::ctrl_c() => {
                    println!("\nShutting down GPU provider...");
                    heartbeat_handle.abort();
                    write_handle.abort();
                    return;
                }
            }
        }

        heartbeat_handle.abort();
        write_handle.abort();

        if disconnected {
            eprintln!("Disconnected. Reconnecting in {}s...", backoff_secs);
            tokio::time::sleep(std::time::Duration::from_secs(backoff_secs)).await;
            backoff_secs = (backoff_secs * 2).min(60);
        }
    }
}

/// Print the initial status block after connecting.
fn print_status_block(model_count: usize, total_reqs: u32, start_time: &Instant) {
    let elapsed = start_time.elapsed();
    let hours = elapsed.as_secs() / 3600;
    let mins = (elapsed.as_secs() % 3600) / 60;
    println!();
    println!("\x1b[1m━━━ Ghola Provider ━━━━━━━━━━━━━━━━━━━━\x1b[0m");
    println!("  \x1b[32mOnline\x1b[0m · {} model{} · {} request{}",
        model_count,
        if model_count == 1 { "" } else { "s" },
        total_reqs,
        if total_reqs == 1 { "" } else { "s" },
    );
    println!("  Earnings: $0.0000 USDC");
    println!("  Uptime: {}h {}m", hours, mins);
    println!("  Press Ctrl+C to stop");
    println!("\x1b[1m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m");
    println!();
}

/// Print a one-line status update after each completed request.
fn print_status_update(model_count: usize, total_reqs: u32, start_time: &Instant) {
    let elapsed = start_time.elapsed();
    let hours = elapsed.as_secs() / 3600;
    let mins = (elapsed.as_secs() % 3600) / 60;
    println!(
        "  \x1b[32m●\x1b[0m {} model{} · {} request{} · uptime {}h {}m",
        model_count,
        if model_count == 1 { "" } else { "s" },
        total_reqs,
        if total_reqs == 1 { "" } else { "s" },
        hours,
        mins,
    );
}

/// Discover available models from a local inference server.
/// Tries Ollama format first (`/api/tags`), then OpenAI format (`/v1/models`).
async fn discover_models(inference_url: &str) -> Vec<String> {
    let client = reqwest::Client::new();
    let base = inference_url.trim_end_matches('/');

    // Try Ollama format: GET /api/tags
    if let Ok(resp) = client.get(format!("{}/api/tags", base)).send().await {
        if resp.status().is_success() {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                if let Some(models) = json.get("models").and_then(|m| m.as_array()) {
                    let names: Vec<String> = models
                        .iter()
                        .filter_map(|m| m.get("name").and_then(|n| n.as_str()).map(String::from))
                        .collect();
                    if !names.is_empty() {
                        return names;
                    }
                }
            }
        }
    }

    // Try OpenAI format: GET /v1/models
    if let Ok(resp) = client.get(format!("{}/v1/models", base)).send().await {
        if resp.status().is_success() {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                if let Some(data) = json.get("data").and_then(|d| d.as_array()) {
                    let ids: Vec<String> = data
                        .iter()
                        .filter_map(|m| m.get("id").and_then(|id| id.as_str()).map(String::from))
                        .collect();
                    if !ids.is_empty() {
                        return ids;
                    }
                }
            }
        }
    }

    Vec::new()
}

/// Handle an incoming inference request by forwarding it to the local inference server.
async fn handle_inference_request(
    inference_url: &str,
    envelope: &thumper_types::Envelope,
    payload: &thumper_types::InferenceRequestPayload,
    ws_sender: &mpsc::UnboundedSender<tokio_tungstenite::tungstenite::Message>,
) {
    let client = reqwest::Client::new();

    // Build OpenAI-compatible messages
    let mut messages = Vec::new();
    if let Some(ref system) = payload.system {
        messages.push(serde_json::json!({"role": "system", "content": system}));
    }
    for msg in &payload.messages {
        messages.push(serde_json::json!({"role": &msg.role, "content": &msg.content}));
    }

    let start = std::time::Instant::now();

    let body = serde_json::json!({
        "model": &payload.model_id,
        "messages": messages,
        "max_tokens": payload.max_tokens,
        "temperature": payload.temperature.unwrap_or(0.7),
        "stream": payload.stream,
    });

    let base = inference_url.trim_end_matches('/');
    let resp = client
        .post(format!("{}/v1/chat/completions", base))
        .json(&body)
        .send()
        .await;

    match resp {
        Ok(response) if response.status().is_success() => {
            if payload.stream {
                // Streaming mode: read SSE chunks
                let mut bytes_stream = response.bytes_stream();
                let mut tokens_so_far: u32 = 0;
                let mut full_text = String::new();

                while let Some(chunk_result) = bytes_stream.next().await {
                    match chunk_result {
                        Ok(bytes) => {
                            let text = String::from_utf8_lossy(&bytes);
                            for line in text.lines() {
                                let line = line.trim();
                                if line.is_empty() || line == "data: [DONE]" {
                                    continue;
                                }
                                if let Some(data) = line.strip_prefix("data: ") {
                                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                                        if let Some(delta) = json
                                            .get("choices")
                                            .and_then(|c| c.get(0))
                                            .and_then(|c| c.get("delta"))
                                            .and_then(|d| d.get("content"))
                                            .and_then(|c| c.as_str())
                                        {
                                            tokens_so_far += 1;
                                            full_text.push_str(delta);

                                            let chunk_env = envelope.response(
                                                thumper_types::MessageType::InferenceStreamChunk(
                                                    thumper_types::InferenceStreamChunk {
                                                        job_id: payload.job_id.clone(),
                                                        text: delta.to_string(),
                                                        tokens_so_far,
                                                    },
                                                ),
                                            );
                                            let json_str = serde_json::to_string(&chunk_env).unwrap();
                                            let _ = ws_sender.send(
                                                tokio_tungstenite::tungstenite::Message::Text(
                                                    json_str.into(),
                                                ),
                                            );
                                        }
                                    }
                                }
                            }
                        }
                        Err(e) => {
                            eprintln!("Stream read error: {}", e);
                            break;
                        }
                    }
                }

                let latency_ms = start.elapsed().as_millis() as u64;
                // Rough token estimate: ~4 chars per token for the full text
                let output_tokens = (full_text.len() as u32 / 4).max(tokens_so_far);
                let input_tokens = messages
                    .iter()
                    .map(|m| {
                        m.get("content")
                            .and_then(|c| c.as_str())
                            .map(|s| s.len() as u32 / 4)
                            .unwrap_or(0)
                    })
                    .sum::<u32>();

                let end_env = envelope.response(
                    thumper_types::MessageType::InferenceStreamEnd(
                        thumper_types::InferenceStreamEnd {
                            job_id: payload.job_id.clone(),
                            input_tokens,
                            output_tokens,
                            latency_ms,
                        },
                    ),
                );
                let json_str = serde_json::to_string(&end_env).unwrap();
                let _ = ws_sender.send(tokio_tungstenite::tungstenite::Message::Text(
                    json_str.into(),
                ));

                println!(
                    "Completed streaming job {} ({} chunks, {}ms)",
                    payload.job_id, tokens_so_far, latency_ms
                );
            } else {
                // Non-streaming mode
                match response.json::<serde_json::Value>().await {
                    Ok(json) => {
                        let text = json
                            .get("choices")
                            .and_then(|c| c.get(0))
                            .and_then(|c| c.get("message"))
                            .and_then(|m| m.get("content"))
                            .and_then(|c| c.as_str())
                            .unwrap_or("")
                            .to_string();

                        let usage = json.get("usage");
                        let input_tokens = usage
                            .and_then(|u| u.get("prompt_tokens"))
                            .and_then(|t| t.as_u64())
                            .unwrap_or(0) as u32;
                        let output_tokens = usage
                            .and_then(|u| u.get("completion_tokens"))
                            .and_then(|t| t.as_u64())
                            .unwrap_or(0) as u32;

                        let latency_ms = start.elapsed().as_millis() as u64;

                        let resp_env = envelope.response(
                            thumper_types::MessageType::InferenceResponse(
                                thumper_types::InferenceResponsePayload {
                                    job_id: payload.job_id.clone(),
                                    text,
                                    input_tokens,
                                    output_tokens,
                                    latency_ms,
                                },
                            ),
                        );
                        let json_str = serde_json::to_string(&resp_env).unwrap();
                        let _ = ws_sender.send(
                            tokio_tungstenite::tungstenite::Message::Text(json_str.into()),
                        );

                        println!(
                            "Completed job {} ({}+{} tokens, {}ms)",
                            payload.job_id, input_tokens, output_tokens, latency_ms
                        );
                    }
                    Err(e) => {
                        send_error(envelope, &payload.job_id, &format!("Failed to parse inference response: {}", e), ws_sender);
                    }
                }
            }
        }
        Ok(response) => {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            send_error(
                envelope,
                &payload.job_id,
                &format!("Inference server returned {}: {}", status, body),
                ws_sender,
            );
        }
        Err(e) => {
            send_error(
                envelope,
                &payload.job_id,
                &format!("Failed to reach inference server: {}", e),
                ws_sender,
            );
        }
    }
}

/// Send an error envelope back through the WebSocket.
fn send_error(
    envelope: &thumper_types::Envelope,
    job_id: &str,
    message: &str,
    ws_sender: &mpsc::UnboundedSender<tokio_tungstenite::tungstenite::Message>,
) {
    eprintln!("Error for job {}: {}", job_id, message);
    let err_env = envelope.response(thumper_types::MessageType::Error(
        thumper_types::ErrorPayload {
            code: "inference_error".to_string(),
            message: message.to_string(),
        },
    ));
    let json_str = serde_json::to_string(&err_env).unwrap();
    let _ = ws_sender.send(tokio_tungstenite::tungstenite::Message::Text(
        json_str.into(),
    ));
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
        .join(".ghola")
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
