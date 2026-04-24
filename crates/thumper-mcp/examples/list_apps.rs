//! Quick utility: connect to relay and list all installed apps on the device.
//! Usage: cargo run -p thumper-mcp --example list_apps [filter]
//! Example: cargo run -p thumper-mcp --example list_apps dapp

use std::time::Duration;
use thumper_types::*;

#[path = "../src/config.rs"]
mod config;
#[path = "../src/connection.rs"]
mod connection;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing_subscriber::fmt()
        .with_env_filter("info")
        .with_writer(std::io::stderr)
        .init();

    let filter = std::env::args().nth(1);

    let cfg = config::ThumperConfig::load()?;
    eprintln!("Connecting to relay at {} ...", cfg.relay_url);
    eprintln!("Device pubkey: {}", cfg.device_pubkey);

    let conn = connection::RelayConnection::connect(&cfg).await?;
    eprintln!("Connected. Querying installed apps...\n");

    let envelope =
        Envelope::new(MessageType::ListInstalledApps).with_target(cfg.device_pubkey.clone());

    let response = conn.send_command(envelope, Duration::from_secs(15)).await?;

    match response.message {
        MessageType::InstalledAppsResult(result) => {
            let mut apps = result.apps;
            apps.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));

            if let Some(ref f) = filter {
                let f_lower = f.to_lowercase();
                let filtered: Vec<_> = apps
                    .iter()
                    .filter(|a| {
                        a.label.to_lowercase().contains(&f_lower)
                            || a.package.to_lowercase().contains(&f_lower)
                    })
                    .collect();

                println!(
                    "=== Apps matching '{}' ({} results) ===\n",
                    f,
                    filtered.len()
                );
                for app in &filtered {
                    println!("  {} — {}", app.label, app.package);
                }
                if filtered.is_empty() {
                    println!("  (no matches)");
                    println!("\nShowing all {} apps:\n", apps.len());
                    for app in &apps {
                        println!("  {} — {}", app.label, app.package);
                    }
                }
            } else {
                println!("=== All installed apps ({}) ===\n", apps.len());
                for app in &apps {
                    println!("  {} — {}", app.label, app.package);
                }
            }
        }
        MessageType::Error(e) => {
            eprintln!("Device error: {} - {}", e.code, e.message);
        }
        other => {
            eprintln!("Unexpected response: {:?}", other);
        }
    }

    Ok(())
}
