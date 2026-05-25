//! Devnet smoke test for the chain-submission code path.
//!
//! Sends a 1-lamport self-transfer from the relayer keypair through
//! [`RpcSubmitter`] (via [`RpcSubmitter::submit_decoy`]), then polls
//! for confirmation. This validates:
//!   - Keypair loading from `RELAYER_KEYPAIR_PATH` (defaults to
//!     `~/.config/solana/id.json`).
//!   - JSON-RPC plumbing (`getLatestBlockhash`, `sendTransaction`,
//!     `getSignatureStatuses`).
//!   - Ed25519 message construction and signature.
//!
//! It does NOT exercise the said-shielded-pool program — the goal is
//! to confirm the submission stack works end-to-end before we wire it
//! into a real `withdraw` ix (which depends on a valid Groth16 proof
//! and a populated escrow).
//!
//! Marked `#[ignore]` because it requires:
//!   - Network access to `api.devnet.solana.com`.
//!   - A funded keypair on devnet (a few thousand lamports is plenty).
//!
//! Run with:
//! ```bash
//! cargo test -p said-shielded-pool-relayer --test devnet_submit \
//!     -- --ignored --nocapture
//! ```

use std::path::PathBuf;

use said_shielded_pool_relayer::submit::{RpcSubmitter, Submitter};

fn keypair_path() -> PathBuf {
    if let Ok(p) = std::env::var("RELAYER_KEYPAIR_PATH") {
        return p.into();
    }
    let home = std::env::var("HOME").expect("HOME must be set");
    PathBuf::from(home).join(".config/solana/id.json")
}

fn rpc_url() -> String {
    std::env::var("RPC_URL").unwrap_or_else(|_| "https://api.devnet.solana.com".to_string())
}

#[tokio::test]
#[ignore = "requires devnet + funded keypair; run explicitly via --ignored"]
async fn devnet_self_transfer_confirms() {
    let kp = keypair_path();
    assert!(
        kp.exists(),
        "keypair must exist at {} — set RELAYER_KEYPAIR_PATH to override",
        kp.display()
    );

    let url = rpc_url();
    eprintln!("submitting 1-lamport self-transfer via {url}");
    let submitter = RpcSubmitter::new(url, kp);

    // submit_decoy() builds a 1-lamport self-transfer, signs, sends,
    // and confirms. If it returns Ok the full RPC + signing chain
    // works end-to-end.
    let res = submitter.submit_decoy().await;
    match res {
        Ok(()) => {
            eprintln!("ok: decoy self-transfer confirmed on devnet");
            let pk = submitter.signer_pubkey().expect("signer pubkey");
            eprintln!("relayer pubkey: {}", bs58::encode(pk).into_string());
        }
        Err(e) => panic!("devnet submit failed: {e}"),
    }
}
