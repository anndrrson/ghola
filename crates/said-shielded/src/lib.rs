//! # said-shielded
//!
//! Tier 2K shielded-payment plumbing. Implements three pieces of the
//! Aleo-routed shielded rail described in
//! `docs/security/tier-2k-shielded-payments.md`:
//!
//! 1. **Account derivation** — [`account::derive_aleo_account`] turns a
//!    Turnkey Ed25519 signature into a deterministic Aleo account via
//!    HKDF-SHA256 under the `ghola-aleo-account-v1` label. The user
//!    never sees a second wallet (§4.3).
//! 2. **Transition payload builder** — [`transition::ShieldedTransitionRequest`]
//!    is the unsigned request the client ships to the broadcaster.
//! 3. **Adapter broadcaster client** — [`broadcaster::AdapterClient`]
//!    POSTs the request to the adapter's `/verify` endpoint, validates
//!    the adapter's Ed25519 signature, and replay-checks the
//!    `(provider, receipt_or_nullifier)` tuple via a pluggable
//!    [`broadcaster::ReplayCache`].
//!
//! Real snarkVM key derivation and proof generation are intentionally
//! deferred behind the [`account::AleoKeyDerivation`] trait — see
//! `account.rs` for the rationale.

#![warn(missing_docs)]

pub mod account;
pub mod broadcaster;
pub mod error;
pub mod transition;

pub use account::{derive_aleo_account, AleoAccount, AleoKeyDerivation, StubAleoKeyDerivation, ALEO_ACCOUNT_LABEL};
pub use broadcaster::{
    canonical_message_for_signature, verify_receipt, AdapterClient, AdapterReceipt,
    AdapterTransport, MemoryReplayCache, ReplayCache, ReqwestTransport, VerifiedReceipt,
};
pub use error::ShieldedError;
pub use transition::ShieldedTransitionRequest;

use said_x402::settlement::X402SettlementProof;

/// Map a verified adapter receipt to the on-wire
/// [`X402SettlementProof::AleoShielded`] variant. The settlement enum
/// is intentionally minimal (proof + nullifier + epoch) — anything
/// richer stays in the adapter receipt and is never wire-exposed.
///
/// `epoch` ties the proof to a published recipient view-key version,
/// per `said-x402/src/settlement.rs`. Today we derive it from the
/// receipt's `observation_time` clipped to a non-negative `u64`; once
/// the recipient view-key rotation cadence is wired in, this becomes
/// the rotation epoch.
pub fn into_settlement_proof(verified: VerifiedReceipt) -> X402SettlementProof {
    let r = verified.receipt;
    let epoch = if r.observation_time < 0 { 0 } else { r.observation_time as u64 };
    X402SettlementProof::AleoShielded {
        proof_b64: r.proof_digest,
        nullifier_hex: r.receipt_or_nullifier,
        epoch,
    }
}

#[cfg(test)]
mod integration_tests {
    use super::*;

    #[test]
    fn into_settlement_proof_maps_fields() {
        let receipt = AdapterReceipt {
            settled: true,
            amount: 1000,
            receipt_or_nullifier: "deadbeef".into(),
            provider: "aleo".into(),
            network: "aleo:mainnet".into(),
            asset: "USDCx".into(),
            destination: "aleo1dst".into(),
            proof_digest: "cafef00d".into(),
            observation_time: 1_700_000_000,
            expiration_time: 1_700_000_600,
            signature: String::new(),
        };
        let proof = into_settlement_proof(VerifiedReceipt { receipt });
        match proof {
            X402SettlementProof::AleoShielded {
                proof_b64,
                nullifier_hex,
                epoch,
            } => {
                assert_eq!(proof_b64, "cafef00d");
                assert_eq!(nullifier_hex, "deadbeef");
                assert_eq!(epoch, 1_700_000_000);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn into_settlement_proof_clips_negative_observation_time() {
        let receipt = AdapterReceipt {
            settled: true,
            amount: 1,
            receipt_or_nullifier: "n".into(),
            provider: "aleo".into(),
            network: "aleo:mainnet".into(),
            asset: "USDCx".into(),
            destination: "d".into(),
            proof_digest: "p".into(),
            observation_time: -1,
            expiration_time: 1,
            signature: String::new(),
        };
        let proof = into_settlement_proof(VerifiedReceipt { receipt });
        if let X402SettlementProof::AleoShielded { epoch, .. } = proof {
            assert_eq!(epoch, 0);
        } else {
            panic!("wrong variant");
        }
    }
}
