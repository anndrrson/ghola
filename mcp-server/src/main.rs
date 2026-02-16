#[tokio::main]
async fn main() {
    if let Err(e) = said_mcp::run().await {
        eprintln!("Error: {}", e);
        std::process::exit(1);
    }
}
