use clap::Parser;

#[derive(Parser)]
#[command(
    name = "said-daemon",
    about = "SAID background daemon — serves MCP over HTTP"
)]
struct Args {
    /// Port to listen on
    #[arg(long, default_value = "3000")]
    port: u16,
}

#[tokio::main]
async fn main() {
    let args = Args::parse();

    if let Err(e) = said_daemon::run(args.port).await {
        eprintln!("Fatal: {}", e);
        std::process::exit(1);
    }
}
