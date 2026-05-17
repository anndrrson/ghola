use clap::{Parser, Subcommand};
use tracing_subscriber::EnvFilter;

#[derive(Parser, Debug)]
#[command(name = "thumper-relay", about = "Ghola relay server (OHTTP gateway + WS hub)")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Mint a fresh OHTTP gateway X25519 keypair and print it on stdout
    /// (hex-encoded) for ops to seed into SSM. Use:
    ///
    ///   thumper-relay generate-ohttp-key
    ///
    /// then copy the secret line into the SSM parameter that boots the
    /// relay (`GHOLA_OHTTP_KEY_SECRET_HEX`) and publish the public line
    /// as the keyconfig for clients.
    GenerateOhttpKey {
        /// Key id to embed in the keyconfig header (0..=255).
        #[arg(long, default_value_t = thumper_relay::config::DEFAULT_OHTTP_KEY_ID)]
        key_id: u8,
    },
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let cli = Cli::parse();

    match cli.command {
        Some(Command::GenerateOhttpKey { key_id }) => {
            let kp = thumper_relay::ohttp::OhttpKeypair::generate(key_id);
            // Print secret + public + keyconfig. We deliberately keep this
            // unceremonious — operators are expected to redirect the
            // secret line into a secret store immediately.
            println!("# OHTTP gateway keypair (RFC 9458)");
            println!("# key_id = {key_id}");
            println!("GHOLA_OHTTP_KEY_SECRET_HEX={}", hex::encode(kp.secret.to_bytes()));
            println!("GHOLA_OHTTP_KEY_PUBLIC_HEX={}", hex::encode(kp.public.as_bytes()));
            println!("GHOLA_OHTTP_KEYCONFIG_HEX={}", hex::encode(kp.key_config()));
            return;
        }
        None => {}
    }

    if let Err(e) = thumper_relay::run_relay().await {
        eprintln!("Error: {}", e);
        std::process::exit(1);
    }
}
