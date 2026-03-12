pub mod discovery;

use std::fs;
use std::path::PathBuf;

/// Run the daemon process.
pub async fn run(port: u16) -> Result<(), Box<dyn std::error::Error>> {
    let wallet_dir = said_core::Wallet::default_wallet_dir()?;

    // Write PID file
    let pid_path = wallet_dir.join("daemon.pid");
    fs::write(&pid_path, std::process::id().to_string())?;

    // Set up logging to file
    let file_appender = tracing_appender::rolling::never(&wallet_dir, "daemon.log");
    tracing_subscriber::fmt()
        .with_writer(file_appender)
        .with_env_filter("info")
        .init();

    tracing::info!("SAID daemon starting on port {}", port);

    // Load wallet
    // Support SAID_PASSWORD env var for headless operation
    let password = std::env::var("SAID_PASSWORD").ok();
    let wallet = said_core::Wallet::load(&wallet_dir, password.as_deref())?;

    // Auto-discover AI clients
    let results = discovery::auto_discover(port);
    for r in &results {
        if r.configured {
            tracing::info!("Configured: {}", r.name);
            eprintln!("  \u{2713} {} configured", r.name);
        } else if let Some(reason) = r.reason {
            tracing::info!("Skipped {}: {}", r.name, reason);
            eprintln!("  \u{2717} {} {}", r.name, reason);
        }
    }

    // Set up graceful shutdown
    let pid_path_clone = pid_path.clone();
    tokio::spawn(async move {
        let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("Failed to set up SIGTERM handler");
        sigterm.recv().await;
        tracing::info!("Received SIGTERM, shutting down");
        let _ = fs::remove_file(&pid_path_clone);
        std::process::exit(0);
    });

    // Run HTTP MCP server (reuse existing)
    said_mcp::run_http(wallet, port).await?;

    // Cleanup on normal exit
    let _ = fs::remove_file(&pid_path);
    Ok(())
}

/// Check if daemon is running. Returns PID if running.
pub fn is_running(wallet_dir: &PathBuf) -> Option<u32> {
    let pid_path = wallet_dir.join("daemon.pid");
    let pid_str = fs::read_to_string(&pid_path).ok()?;
    let pid: u32 = pid_str.trim().parse().ok()?;

    // Check if process is alive
    use std::process::Command;
    let status = Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .ok()?;

    if status.success() {
        Some(pid)
    } else {
        None
    }
}

/// Stop the daemon.
pub fn stop(wallet_dir: &PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    let pid_path = wallet_dir.join("daemon.pid");
    let pid_str = fs::read_to_string(&pid_path)?;
    let pid: u32 = pid_str.trim().parse()?;

    use std::process::Command;
    Command::new("kill").args([&pid.to_string()]).status()?;

    let _ = fs::remove_file(&pid_path);
    Ok(())
}
