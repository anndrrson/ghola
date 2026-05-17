//! Tagged settlement-proof envelope for x402 payments.
//!
//! Tier 2K of the peak-security plan introduces shielded payments to
//! close the metadata leak that comes from public Solana settlements
//! (a chain analyst can build a user→provider graph from public
//! transactions alone). The recommendation in
//! `docs/security/tier-2k-shielded-payments.md` is Aleo-routed
//! shielded transfers with USDC.a bridged in.
//!
//! This module is the **schema-only first PR** that doc names: a
//! tagged enum the x402 receipt envelope can carry today, with the
//! Solana variant active and an `AleoShielded` variant typed but
//! todo!()-stubbed for the validator. The shape exists so:
//!   - The receipt schema can stop assuming Solana-only.
//!   - The relay-side validator dispatch has a place to grow.
//!   - The TS client can type against the same shape via a generated
//!     binding when the time comes.
//!
//! No behavior changes ship until the AleoShielded path is wired up
//! in a follow-up PR.

use serde::{Deserialize, Serialize};

/// Tagged settlement-proof envelope. Future variants slot in as
/// shielded chains land; today's clients always emit `Solana`.
///
/// Serialized as `{"kind": "solana", ...}` / `{"kind": "aleo_shielded", ...}`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum X402SettlementProof {
    /// Public Solana transfer — the current production path.
    /// `signature` is the base58 tx signature returned by
    /// `sendTransaction`; `payer_pubkey` is base58.
    Solana {
        signature: String,
        payer_pubkey: String,
        network: String,
    },
    /// Aleo-routed shielded transfer (Tier 2K).
    ///
    /// `proof_b64` is the base64-encoded Aleo execution proof that
    /// the payment was credited to the recipient's view key on the
    /// shielded ledger. `nullifier_hex` is the spend nullifier — the
    /// merchant-side verifier records this to prevent double-spend.
    /// `epoch` ties the proof to a published recipient view key
    /// version so rotations are unambiguous.
    AleoShielded {
        proof_b64: String,
        nullifier_hex: String,
        epoch: u64,
    },
}

/// Verifier error surface for [`X402SettlementProof`].
#[derive(Debug, thiserror::Error)]
pub enum SettlementVerifyError {
    #[error("solana payment validator not yet routed through this enum (use the existing X402PaymentPayload path)")]
    SolanaNotRouted,
    #[error("aleo shielded payments not yet implemented — Tier 2K follow-up")]
    AleoNotImplemented,
}

impl X402SettlementProof {
    /// Placeholder validator. Today the Solana arm is verified via the
    /// existing `X402PaymentPayload` flow upstream of this enum; the
    /// Aleo arm is intentionally not implemented (the type is reserved
    /// so the schema and follow-up PRs can land in parallel).
    ///
    /// Future PRs will: (1) move Solana verification into this fn,
    /// (2) implement Aleo execution-proof verification + nullifier
    /// recording, (3) drop the parallel `X402PaymentPayload` flow.
    pub fn verify(&self) -> Result<(), SettlementVerifyError> {
        match self {
            X402SettlementProof::Solana { .. } => Err(SettlementVerifyError::SolanaNotRouted),
            X402SettlementProof::AleoShielded { .. } => {
                Err(SettlementVerifyError::AleoNotImplemented)
            }
        }
    }

    /// Short tag suitable for metrics + logs without exposing payment
    /// metadata.
    pub fn kind_tag(&self) -> &'static str {
        match self {
            X402SettlementProof::Solana { .. } => "solana",
            X402SettlementProof::AleoShielded { .. } => "aleo_shielded",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Golden vectors. These tests pin the wire format so a future
    // refactor that changes serde annotations fails loudly. The values
    // are referenced by the Tier 2K design doc.

    #[test]
    fn solana_variant_serializes_with_kind_tag() {
        let proof = X402SettlementProof::Solana {
            signature: "5J2…abc".into(),
            payer_pubkey: "9yrbz…jmkF".into(),
            network: "solana-devnet".into(),
        };
        let v = serde_json::to_value(&proof).unwrap();
        assert_eq!(
            v,
            json!({
                "kind": "solana",
                "signature": "5J2…abc",
                "payer_pubkey": "9yrbz…jmkF",
                "network": "solana-devnet",
            })
        );
    }

    #[test]
    fn aleo_variant_serializes_with_kind_tag() {
        let proof = X402SettlementProof::AleoShielded {
            proof_b64: "abc==".into(),
            nullifier_hex: "deadbeef".into(),
            epoch: 42,
        };
        let v = serde_json::to_value(&proof).unwrap();
        assert_eq!(
            v,
            json!({
                "kind": "aleo_shielded",
                "proof_b64": "abc==",
                "nullifier_hex": "deadbeef",
                "epoch": 42,
            })
        );
    }

    #[test]
    fn round_trips_through_serde_json() {
        let original = X402SettlementProof::AleoShielded {
            proof_b64: "Zm9v".into(),
            nullifier_hex: "1234".into(),
            epoch: 7,
        };
        let encoded = serde_json::to_string(&original).unwrap();
        let decoded: X402SettlementProof = serde_json::from_str(&encoded).unwrap();
        assert_eq!(original, decoded);
    }

    #[test]
    fn deserializes_with_extra_unknown_fields_when_known_subset_present() {
        // Forward-compat: a future variant adding fields shouldn't
        // break older deserializers that ignore the unknown. (Serde's
        // default tolerates extras.)
        let raw = json!({
            "kind": "solana",
            "signature": "sig-1",
            "payer_pubkey": "pubkey-1",
            "network": "solana-mainnet",
            "future_field": "ignored",
        });
        let decoded: X402SettlementProof = serde_json::from_value(raw).unwrap();
        match decoded {
            X402SettlementProof::Solana { signature, .. } => assert_eq!(signature, "sig-1"),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn verify_is_stubbed_for_both_arms() {
        let solana = X402SettlementProof::Solana {
            signature: "s".into(),
            payer_pubkey: "p".into(),
            network: "n".into(),
        };
        assert!(matches!(
            solana.verify(),
            Err(SettlementVerifyError::SolanaNotRouted)
        ));
        let aleo = X402SettlementProof::AleoShielded {
            proof_b64: "".into(),
            nullifier_hex: "".into(),
            epoch: 0,
        };
        assert!(matches!(
            aleo.verify(),
            Err(SettlementVerifyError::AleoNotImplemented)
        ));
    }

    #[test]
    fn kind_tag_strings_are_stable() {
        let solana = X402SettlementProof::Solana {
            signature: "".into(),
            payer_pubkey: "".into(),
            network: "".into(),
        };
        let aleo = X402SettlementProof::AleoShielded {
            proof_b64: "".into(),
            nullifier_hex: "".into(),
            epoch: 0,
        };
        assert_eq!(solana.kind_tag(), "solana");
        assert_eq!(aleo.kind_tag(), "aleo_shielded");
    }
}
