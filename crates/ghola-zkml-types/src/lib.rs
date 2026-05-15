//! Schema types for verifiable inference (zkML) proofs.
//!
//! Tier 2H of the peak-security plan attaches a SNARK proof to every
//! receipt that proves "this model produced this output given this
//! prompt hash" — closing the gap where today users have to trust the
//! enclave's signature about which model actually ran. See
//! `docs/security/tier-2h-zkml.md` for the threat-model, the system
//! comparison (EZKL vs Risc Zero vs Modulus recursion), and the
//! recommendation (EZKL/Halo2 over BN254 for v1).
//!
//! This crate is the **schema-only first PR** the doc names: types +
//! serde + golden vectors only. The actual prover sidecar, the WASM
//! verifier in the web client, and the registry-program changes that
//! anchor verifying keys all type against the shape defined here so
//! they can land in parallel.
//!
//! Wire format is intentionally minimal — the `proof_b64` body is
//! opaque to ghola (system-specific). Only the metadata + public
//! inputs need a stable structure on this side.

use serde::{Deserialize, Serialize};

/// Identifier of the proof system the `proof_b64` body conforms to.
/// New variants land as additional systems become production-viable.
/// Serialized as `"ezkl"` / `"risc_zero"` / `"modulus_recursive"`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ProofSystem {
    /// EZKL / Halo2 over BN254. The v1 recommendation in the design
    /// doc; verifier runs in-browser via WASM and on-chain via Solana's
    /// `alt_bn128_pairing` syscall.
    Ezkl,
    /// Risc Zero zkVM (STARK over Baby Bear). Reserved for the v2
    /// path where general-purpose zkVM proving becomes competitive.
    RiscZero,
    /// Modulus Labs folding-recursive SNARK per-token. Reserved for
    /// the streaming-chat v2 path where each token gets a tiny proof
    /// and the conversation builds a recursive chain.
    ModulusRecursive,
}

/// Canonical, hex-encoded SHA-256 hashes the proof commits to.
/// Everything here is public — the proof binds these but doesn't
/// reveal the underlying body.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PublicInputs {
    /// `sha256(canonical(prompt))` matching the receipt's
    /// `input_token_hash`.
    pub prompt_hash: String,
    /// `sha256(canonical(response))` matching the receipt's
    /// `output_token_hash`.
    pub output_hash: String,
    /// `sha256(model_id || revision)` — pins the model the prover
    /// claims to have executed. Matches the registry's
    /// `model_id_hash` PDA seed component, so on-chain verification
    /// can lookup the model record at the deterministic address.
    pub model_id_hash: String,
}

/// Stable identifier for a compiled circuit. EZKL circuit IDs are
/// SHA-256 of the compiled `model.compiled` + `settings.json`; other
/// systems use their own conventions. The on-chain registry pins this
/// alongside `weights_hash` so a verifier knows exactly which circuit
/// binary the proof was produced against.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(transparent)]
pub struct CircuitId(pub String);

impl CircuitId {
    pub fn new(s: impl Into<String>) -> Self {
        Self(s.into())
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// The zkML proof payload that attaches to a v3 receipt as an
/// optional field. v1/v2 receipts omit it entirely; verifiers
/// treat absence as "not a verifiable-tier message" rather than as
/// a failure.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ZkmlProof {
    pub system: ProofSystem,
    pub circuit_id: CircuitId,
    /// Base64-encoded opaque proof body. Shape is system-specific;
    /// validators decode + verify within the chosen system.
    pub proof_b64: String,
    pub public_inputs: PublicInputs,
}

/// Verifier error surface. Today the proof bodies aren't actually
/// validated by this crate — the WASM verifier and the registry-
/// program verifier own that. These error variants exist so client
/// code can pattern-match on the failure mode once verification is
/// wired up in the follow-up PRs.
#[derive(Debug, thiserror::Error)]
pub enum ZkmlVerifyError {
    #[error("system not yet implemented in this verifier: {0:?}")]
    SystemNotImplemented(ProofSystem),
    #[error("circuit_id mismatch: receipt claims {claimed}, registry has {expected}")]
    CircuitIdMismatch { claimed: String, expected: String },
    #[error("prompt_hash mismatch: proof commits to {claimed}, receipt has {expected}")]
    PromptHashMismatch { claimed: String, expected: String },
    #[error("output_hash mismatch: proof commits to {claimed}, receipt has {expected}")]
    OutputHashMismatch { claimed: String, expected: String },
    #[error("model_id_hash mismatch: proof commits to {claimed}, registry has {expected}")]
    ModelIdHashMismatch { claimed: String, expected: String },
    #[error("malformed proof body: {0}")]
    Malformed(String),
}

impl ZkmlProof {
    /// Cross-check the proof's `public_inputs` against the receipt's
    /// canonical hash fields BEFORE invoking the system-specific
    /// SNARK verifier. Cheap, deterministic, no crypto. The real
    /// SNARK check is the next layer.
    pub fn check_public_inputs(
        &self,
        receipt_prompt_hash: &str,
        receipt_output_hash: &str,
        registry_model_id_hash: &str,
    ) -> Result<(), ZkmlVerifyError> {
        if self.public_inputs.prompt_hash != receipt_prompt_hash {
            return Err(ZkmlVerifyError::PromptHashMismatch {
                claimed: self.public_inputs.prompt_hash.clone(),
                expected: receipt_prompt_hash.to_string(),
            });
        }
        if self.public_inputs.output_hash != receipt_output_hash {
            return Err(ZkmlVerifyError::OutputHashMismatch {
                claimed: self.public_inputs.output_hash.clone(),
                expected: receipt_output_hash.to_string(),
            });
        }
        if self.public_inputs.model_id_hash != registry_model_id_hash {
            return Err(ZkmlVerifyError::ModelIdHashMismatch {
                claimed: self.public_inputs.model_id_hash.clone(),
                expected: registry_model_id_hash.to_string(),
            });
        }
        Ok(())
    }

    /// Short tag suitable for metrics + receipt-side logs without
    /// leaking the proof body.
    pub fn system_tag(&self) -> &'static str {
        match self.system {
            ProofSystem::Ezkl => "ezkl",
            ProofSystem::RiscZero => "risc_zero",
            ProofSystem::ModulusRecursive => "modulus_recursive",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_public_inputs() -> PublicInputs {
        PublicInputs {
            prompt_hash: "a".repeat(64),
            output_hash: "b".repeat(64),
            model_id_hash: "c".repeat(64),
        }
    }

    fn sample_proof() -> ZkmlProof {
        ZkmlProof {
            system: ProofSystem::Ezkl,
            circuit_id: CircuitId::new("llama-3.2-1b-q4-ezkl-v1"),
            proof_b64: "QkxBQg==".into(),
            public_inputs: sample_public_inputs(),
        }
    }

    #[test]
    fn proof_system_serializes_as_snake_case() {
        assert_eq!(serde_json::to_value(ProofSystem::Ezkl).unwrap(), json!("ezkl"));
        assert_eq!(
            serde_json::to_value(ProofSystem::RiscZero).unwrap(),
            json!("risc_zero"),
        );
        assert_eq!(
            serde_json::to_value(ProofSystem::ModulusRecursive).unwrap(),
            json!("modulus_recursive"),
        );
    }

    #[test]
    fn circuit_id_serializes_as_a_bare_string() {
        // The #[serde(transparent)] on CircuitId means it shouldn't
        // wrap as {"0": "..."} — it should be a plain string.
        let c = CircuitId::new("foo");
        assert_eq!(serde_json::to_value(c).unwrap(), json!("foo"));
    }

    #[test]
    fn zkml_proof_round_trips() {
        let original = sample_proof();
        let encoded = serde_json::to_string(&original).unwrap();
        let decoded: ZkmlProof = serde_json::from_str(&encoded).unwrap();
        assert_eq!(original, decoded);
    }

    #[test]
    fn check_public_inputs_accepts_matching_hashes() {
        let p = sample_proof();
        assert!(p
            .check_public_inputs(&"a".repeat(64), &"b".repeat(64), &"c".repeat(64))
            .is_ok());
    }

    #[test]
    fn check_public_inputs_rejects_prompt_mismatch() {
        let p = sample_proof();
        let err = p
            .check_public_inputs(&"x".repeat(64), &"b".repeat(64), &"c".repeat(64))
            .unwrap_err();
        assert!(matches!(err, ZkmlVerifyError::PromptHashMismatch { .. }));
    }

    #[test]
    fn check_public_inputs_rejects_output_mismatch() {
        let p = sample_proof();
        let err = p
            .check_public_inputs(&"a".repeat(64), &"y".repeat(64), &"c".repeat(64))
            .unwrap_err();
        assert!(matches!(err, ZkmlVerifyError::OutputHashMismatch { .. }));
    }

    #[test]
    fn check_public_inputs_rejects_model_id_mismatch() {
        let p = sample_proof();
        let err = p
            .check_public_inputs(&"a".repeat(64), &"b".repeat(64), &"z".repeat(64))
            .unwrap_err();
        assert!(matches!(err, ZkmlVerifyError::ModelIdHashMismatch { .. }));
    }

    #[test]
    fn proof_serializes_with_expected_shape() {
        // Wire-format golden vector — pins the JSON shape so a future
        // refactor that perturbs serde annotations fails loudly.
        let p = sample_proof();
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(
            v,
            json!({
                "system": "ezkl",
                "circuit_id": "llama-3.2-1b-q4-ezkl-v1",
                "proof_b64": "QkxBQg==",
                "public_inputs": {
                    "prompt_hash": "a".repeat(64),
                    "output_hash": "b".repeat(64),
                    "model_id_hash": "c".repeat(64),
                },
            }),
        );
    }

    #[test]
    fn system_tag_strings_are_stable() {
        let p = sample_proof();
        assert_eq!(p.system_tag(), "ezkl");
    }

    #[test]
    fn forward_compat_extra_fields_are_ignored() {
        // A future PR adding a `verifier_key_hash` field shouldn't
        // break older deserializers.
        let raw = json!({
            "system": "ezkl",
            "circuit_id": "c1",
            "proof_b64": "Zm9v",
            "public_inputs": {
                "prompt_hash": "a".repeat(64),
                "output_hash": "b".repeat(64),
                "model_id_hash": "c".repeat(64),
            },
            "future_field": "ignored",
        });
        let _: ZkmlProof = serde_json::from_value(raw).expect("forward-compat decode");
    }
}
