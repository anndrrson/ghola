//! Devnet end-to-end flow test.
//!
//! Runs the full: wallet init → fund via airdrop → create agent →
//! discover service (via mock agents.txt) → x402 probe → assess →
//! SOL transfer → confirm transaction.
//!
//! Requires a reachable Solana devnet RPC (set SOLANA_RPC_URL, or uses the
//! public devnet endpoint).  The test airdrops 1 SOL to the generated
//! addresses via the RPC `requestAirdrop` endpoint.
//!
//! Run with:
//!   cargo run --example devnet_flow

use said_core::{discovery::parse_agents_txt, Wallet};
use said_types::{PayCurrency, SpendingPolicy};
use std::time::Duration;
use tempfile::TempDir;
use tokio::time::sleep;

const DEFAULT_RPC: &str = "https://api.devnet.solana.com";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let rpc_url = std::env::var("SOLANA_RPC_URL").unwrap_or_else(|_| DEFAULT_RPC.to_string());

    println!("=== Ghola Devnet Flow Test ===");
    println!("RPC: {}", rpc_url);

    // ── 1. Wallet setup ──────────────────────────────────────────────────
    println!("\n[1/6] Initializing test wallet...");
    let dir = TempDir::new()?;
    let wallet_dir = dir.path().join(".said");
    let (wallet, phrase) = Wallet::init(&wallet_dir, None)?;

    let owner_pubkey = wallet.solana_pubkey_bytes();
    let owner_address = bs58::encode(&owner_pubkey).into_string();
    println!("  Owner address:  {}", owner_address);
    println!("  Mnemonic (ephemeral, not reused): {}...", &phrase[..40]);

    // ── 2. Create agent wallet ───────────────────────────────────────────
    println!("\n[2/6] Creating agent wallet with spending limits...");
    let policy = SpendingPolicy {
        daily_limit_lamports: Some(2_000_000_000), // 2 SOL/day
        per_tx_limit_lamports: Some(500_000_000),  // 0.5 SOL/tx
        daily_limit_usdc_micro: Some(5_000_000),   // $5/day
        per_tx_limit_usdc_micro: Some(1_000_000),  // $1/tx
        allowed_recipients: vec![],
    };
    let agent = wallet.create_agent_wallet("devnet-test-agent", policy)?;
    println!("  Agent label:    {}", agent.label);
    println!("  Agent address:  {}", agent.solana_address);

    // ── 3. Airdrop SOL to owner and agent via RPC ────────────────────────
    println!("\n[3/6] Requesting devnet airdrops...");

    let owner_kp = wallet.solana_keypair_bytes();
    let owner_client = said_solana::SolanaClient::new(&rpc_url, &owner_kp)?;
    match owner_client.request_airdrop(1_000_000_000).await {
        Ok(sig) => println!("  Owner airdrop TX: {}", sig),
        Err(e) => println!("  Owner airdrop failed (may be rate-limited): {}", e),
    }

    let agent_kp = wallet.agent_solana_keypair(agent.index);
    let agent_client = said_solana::SolanaClient::new(&rpc_url, &agent_kp)?;
    match agent_client.request_airdrop(1_000_000_000).await {
        Ok(sig) => println!("  Agent airdrop TX: {}", sig),
        Err(e) => println!("  Agent airdrop failed (may be rate-limited): {}", e),
    }

    println!("  Waiting 5s for confirmations...");
    sleep(Duration::from_secs(5)).await;

    let agent_bal = agent_client
        .get_balance_of(&agent.solana_address)
        .await
        .unwrap_or(0);
    println!("  Agent balance:  {:.9} SOL", agent_bal as f64 / 1e9);

    if agent_bal < 100_000 {
        println!("  WARNING: balance very low — airdrop may be rate-limited on devnet.");
        println!("  Skipping transfer step. Re-run after a short delay.");
    }

    // ── 4. Service discovery via agents.txt ──────────────────────────────
    println!("\n[4/6] Simulating domain discovery (agents.txt parsing)...");
    let agents_txt_content = format!(
        "Identity: did:key:z6MkDevnetMerchant\n\
         Service: echo-api https://echo.free.beeceptor.com\n\
         Service: info-api https://info.free.beeceptor.com\n\
         Payment: {addr} usdc https://example-merchant.com/said/verify\n",
        addr = agent.solana_address
    );

    let discovered = parse_agents_txt(&agents_txt_content)?;
    println!("  Identity:       {:?}", discovered.identity);
    println!("  Services found: {}", discovered.services.len());
    for svc in &discovered.services {
        println!("    - {} → {}", svc.name, svc.url);
    }

    // ── 5. x402 trust check ──────────────────────────────────────────────
    println!("\n[5/6] Checking x402 merchant trust via Ghola cloud...");
    let ghola_url = std::env::var("GHOLA_API_URL")
        .unwrap_or_else(|_| "https://ghola-api.onrender.com/v1".to_string());
    let x402_client = said_x402::GholaX402Client::new(&ghola_url);

    match x402_client.assess_merchant(&agent.solana_address).await {
        Ok(assessment) => {
            println!("  Trust score:    {:.2}", assessment.trust_score);
            println!("  Recommendation: {}", assessment.recommendation);
            println!("  Reason:         {}", assessment.reason);
        }
        Err(e) => {
            println!("  Trust check failed (cloud API unreachable?): {}", e);
            println!("  Continuing without trust check.");
        }
    }

    // ── 6. SOL transfer with spending policy enforcement ─────────────────
    println!("\n[6/6] Testing SOL transfer with spending policy...");
    let transfer_amount = 50_000_000u64; // 0.05 SOL

    // Pre-flight: verify spending limit allows the amount
    match wallet.check_spending_limit(agent.id, &PayCurrency::Sol, transfer_amount) {
        Ok(()) => println!("  Spending limit check: PASS (0.05 SOL within policy)"),
        Err(e) => {
            println!("  Spending limit check FAILED: {}", e);
            return Ok(());
        }
    }

    if agent_bal >= transfer_amount + 5_000 {
        let mut recipient = [0u8; 32];
        recipient.copy_from_slice(&owner_pubkey);

        match agent_client.transfer_sol(&recipient, transfer_amount).await {
            Ok(sig) => {
                println!("  Transfer TX:    {}", sig);
                println!(
                    "  Explorer:       https://explorer.solana.com/tx/{}?cluster=devnet",
                    sig
                );

                wallet.record_payment_success(agent.id)?;
                wallet.log_transaction(said_types::PaymentTransaction {
                    id: uuid::Uuid::new_v4(),
                    agent_id: agent.id,
                    agent_label: agent.label.clone(),
                    direction: said_types::TxDirection::Send,
                    currency: said_types::PayCurrency::Sol,
                    amount: transfer_amount,
                    recipient: bs58::encode(&owner_pubkey).into_string(),
                    sender: agent.solana_address.clone(),
                    signature: sig,
                    memo: Some("devnet flow test".to_string()),
                    status: said_types::TxStatus::Confirmed,
                    created_at: chrono::Utc::now(),
                })?;

                println!("  Waiting 5s for settlement confirmation...");
                sleep(Duration::from_secs(5)).await;

                let post_bal = agent_client
                    .get_balance_of(&agent.solana_address)
                    .await
                    .unwrap_or(0);
                println!("  Post-transfer balance: {:.9} SOL", post_bal as f64 / 1e9);

                let delta = agent_bal.saturating_sub(post_bal);
                println!("  Delta (inc. fees): {:.9} SOL", delta as f64 / 1e9);
                if delta >= transfer_amount {
                    println!("  Transaction settlement VERIFIED.");
                } else {
                    println!("  WARNING: balance delta less than expected (devnet lag?).");
                }
            }
            Err(e) => {
                let breaker = wallet.record_payment_failure(agent.id, 3)?;
                println!("  Transfer failed: {}", e);
                if breaker.tripped {
                    println!(
                        "  CIRCUIT BREAKER TRIPPED after {} consecutive failures!",
                        breaker.consecutive_failures
                    );
                    println!("  Call unlock_circuit_breaker to re-enable agent spending.");
                } else {
                    println!(
                        "  Failure count: {}/3 (circuit breaker not yet tripped)",
                        breaker.consecutive_failures
                    );
                }
            }
        }
    } else {
        println!("  Skipping transfer — insufficient balance after airdrop.");
    }

    // ── Final spending status ─────────────────────────────────────────────
    println!("\n=== Final spending status ===");
    let status = wallet.spending_status(agent.id)?;
    println!(
        "  Spent today (SOL):  {:.9}",
        status.spend_today_sol_lamports as f64 / 1e9
    );
    println!(
        "  Remaining (SOL):    {:?}",
        status
            .remaining_sol_lamports
            .map(|v| format!("{:.9} SOL", v as f64 / 1e9))
    );
    println!(
        "  Circuit breaker:    {}",
        if status.circuit_breaker_tripped {
            "TRIPPED"
        } else {
            "OK"
        }
    );
    println!("  Consecutive fails:  {}", status.consecutive_failures);

    println!("\n=== Devnet flow test complete ===");
    Ok(())
}
