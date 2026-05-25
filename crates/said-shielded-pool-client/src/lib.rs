//! # said-shielded-pool-client
//!
//! Client SDK for the Ghola Solana-native shielded pool.
//!
//! Used by:
//! - CLI (`crates/thumper-cli`, `cli/`) for interactive deposit / transfer / withdraw.
//! - Daemon (`daemon/`) for background scanning + auto-merge of received notes.
//! - Downstream SDK consumers (Rust-side bindings, eventually WASM via
//!   `said-wasm`).
//!
//! ## Surface
//!
//! - [`ShieldedKeypair`] / [`FullViewingKey`] / [`IncomingViewingKey`] —
//!   derivation entry points. See [`keypair`].
//! - [`NoteBuilder`] — construct a fresh shielded note with random
//!   blinding and the owner pubkey derived from the spending key. See
//!   [`note`].
//! - [`WitnessBuilder`] — bundle input notes + Merkle paths + outputs into
//!   a [`TransferWitness`](said_shielded_pool_types::TransferWitness)
//!   ready for the prover service. See [`witness`].
//! - [`ProverClient`] — async HTTP client that hits the prover service
//!   (`POST /prove`) and returns a
//!   [`ProofBundle`](said_shielded_pool_types::ProofBundle). See
//!   [`prover_client`].
//! - [`RelayerClient`] — async HTTP client that queues fully-built
//!   withdraw instructions with the Solana shielded-pool relayer.
//! - [`tx_builder`] — assemble Solana instructions (`build_deposit_ix`,
//!   `build_transfer_ix`, `build_withdraw_ix`) targeting the
//!   said-shielded-pool program. Mirrors the no-`solana-sdk` style used
//!   by `said-solana`.
//! - [`encryption`] — note-memo encryption (ChaCha20-Poly1305 + HKDF).
//!   Marked **TO-BE-AUDITED** — separable component, expect API drift.
//! - [`Scanner`] — given an IVK, walk on-chain commitments to discover
//!   incoming notes. Currently `unimplemented!()` stubs.
//!
//! ## Example
//!
//! ```no_run
//! use said_shielded_pool_client::{ShieldedKeypair, NoteBuilder, ProverClient};
//! # async fn run() -> Result<(), Box<dyn std::error::Error>> {
//! // 1. Derive keys from an Ed25519 secret.
//! let sk_bytes = [0u8; 32];
//! let kp = ShieldedKeypair::from_seed(&sk_bytes);
//! let fvk = kp.fvk();
//! let ivk = kp.ivk();
//!
//! // 2. Build a fresh output note.
//! let note = NoteBuilder::new()
//!     .amount(1_000_000)
//!     .asset_id_from_mint(&[0u8; 32])
//!     .owner_from_keypair(&kp)
//!     .build();
//!
//! // 3. Ship a witness to the prover.
//! let prover = ProverClient::new("https://prover.ghola.xyz");
//! // let bundle = prover.prove(&witness).await?;
//! # Ok(())
//! # }
//! ```

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod encryption;
pub mod error;
pub mod keypair;
pub mod note;
pub mod poseidon;
pub mod prover_client;
pub mod relayer_client;
pub mod scan;
pub mod tx_builder;
pub mod witness;

// Re-exports — flat namespace for the most common SDK entry points.
pub use error::{Error, Result};
pub use keypair::ShieldedKeypair;
pub use note::NoteBuilder;
pub use prover_client::ProverClient;
pub use relayer_client::{RelayResponse, RelayerClient};
pub use scan::Scanner;
pub use witness::WitnessBuilder;

pub use said_shielded_pool_types as types;

/// The Ghola shielded-pool program ID, base58-encoded.
///
/// Source: `Anchor.toml` (`[programs.localnet] said_shielded_pool`).
pub const PROGRAM_ID_B58: &str = "ShLdPooL11111111111111111111111111111111111";

/// Raw 32-byte program ID. Decoded once at SDK init via [`program_id()`].
///
/// Note that `ShLdPooL11111111111111111111111111111111111` is a *vanity*
/// placeholder address (not on the ed25519 curve in any useful way — it
/// will be replaced when the program is built and a real keypair is
/// generated). The bytes here are the bs58 decoding of the placeholder.
pub fn program_id() -> [u8; 32] {
    let decoded = bs58::decode(PROGRAM_ID_B58)
        .into_vec()
        .expect("PROGRAM_ID_B58 is a hard-coded constant — must decode");
    let mut out = [0u8; 32];
    // bs58 of a 32-byte program id is 43–44 chars and decodes to exactly 32 bytes.
    // Defensive: if the placeholder ever decodes to less, left-pad with zeros.
    let start = 32usize.saturating_sub(decoded.len());
    out[start..].copy_from_slice(&decoded[..decoded.len().min(32)]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn program_id_decodes() {
        // The placeholder may decode to <32 bytes; we just want to make
        // sure the call doesn't panic.
        let _ = program_id();
    }
}
