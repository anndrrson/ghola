#[tokio::main]
async fn main() {
    if let Err(e) = thumper_mcp::run().await {
        eprintln!("Error: {}", e);
        std::process::exit(1);
    }
}
