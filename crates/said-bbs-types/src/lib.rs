//! Schema types for BBS+ anonymous credentials.
//!
//! Tier 2G of the peak-security plan replaces the stable
//! `sender_did` on each sealed-inference request with a BBS+
//! presentation proof: the relay verifies that the requester holds
//! a valid issuer-signed credential and satisfies a predicate
//! (e.g. `usage_counter < tier_quota`) without learning which
//! credential, or any value beyond the predicate result. See
//! `docs/security/tier-2g-anonymous-credentials.md` for the
//! threat-model, the primitive comparison (BBS+ vs AnonCreds 2.0 vs
//! linkable-ring / VOPRF), and the recommendation
//! (BBS Cryptosuite 2023 over BLS12-381).
//!
//! This crate is the **schema-only first PR** the doc names: types
//! + serde + golden vectors only. The actual BBS+ implementation,
//! the in-enclave issuer, and the relay-side verifier all type
//! against the shape defined here so they can land in parallel:
//!
//!   - `crates/said-bbs-issuer` (follow-up) — enclave-bound key
//!     ceremony + blinded credential issuance.
//!   - `crates/said-bbs-verifier` (follow-up) — pairing-based
//!     presentation verification, predicate satisfaction, accumulator
//!     non-revocation check.
//!   - Relay verifier (`crates/thumper-relay/src/auth.rs`, follow-up)
//!     — dispatch into the verifier crate from
//!     `validate_sealed_envelope_bytes`.
//!
//! Wire format is intentionally minimal — the `proof_b64` body is
//! opaque to ghola (system-specific BBS+ presentation bytes). Only
//! the metadata + disclosed attributes + predicate statements + the
//! epoch-scoped nullifier need a stable structure on this side.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Identifier of the BBS+ cipher suite the `proof_b64` body
/// conforms to. New variants land as the CFRG draft stabilises and
/// additional cipher suites become production-viable.
/// Serialized as `"bls12_381_g2_sha256"` / `"bls12_381_g2_shake256"`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum BbsAlgorithm {
    /// BLS12-381 G2 with SHA-256 hash-to-curve. The v1
    /// recommendation in the design doc; mirrors the CFRG draft-07
    /// `BLS12-381-SHA-256` cipher suite and the DIF BBS Cryptosuite
    /// 2023 default profile.
    Bls12_381G2Sha256,
    /// BLS12-381 G2 with SHAKE-256 hash-to-curve. CFRG draft-07
    /// `BLS12-381-SHAKE-256`. Reserved for clients that prefer the
    /// Keccak-family transcript hash.
    Bls12_381G2Shake256,
}

/// Opaque public-key handle for a BBS+ issuer. The actual `pk_bbs`
/// bytes are not carried here — the verifier resolves them by
/// `(epoch, key_id)` against the issuer's published attestation
/// chain (see design doc §4.2). The `algorithm` field pins the
/// cipher suite the key was generated under so a follow-up verifier
/// can dispatch to the right pairing routine.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IssuerKey {
    pub epoch: u64,
    pub key_id: String,
    pub algorithm: BbsAlgorithm,
}

/// A single signed attribute value carried inside a [`Credential`].
/// The set of supported value kinds is intentionally narrow —
/// BBS+ message vectors are field elements, and each kind here has
/// a canonical reduction. Serialized as
/// `{"kind": "string|integer|boolean", "value": ...}`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum AttributeValue {
    String(String),
    Integer(i64),
    Boolean(bool),
}

/// A BBS+ credential as the issuer signs it. The wire body the
/// holder later presents in zero-knowledge derives from this; the
/// holder keeps the full struct in encrypted local storage and
/// reveals only a chosen subset via [`PresentationProof`].
///
/// `subject_did` is visible *only to the issuer* at issuance time
/// (see design doc §4.3 on issuance-time linkage) — it is never
/// carried in a presentation. `nullifier_seed` is a 32-byte hex
/// secret the holder uses to derive per-epoch nullifiers; it stays
/// inside the credential body and never leaves the client.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Credential {
    pub subject_did: String,
    pub attributes: BTreeMap<String, AttributeValue>,
    pub issuer_epoch: u64,
    pub issued_at: i64,
    pub expires_at: i64,
    /// 32-byte hex-encoded nullifier seed. Held client-side; the
    /// per-request nullifier is derived as
    /// `H(epoch || nullifier_seed || request_window_id)` per the
    /// design doc §4.4.
    pub nullifier_seed: String,
}

/// A zero-knowledge predicate the holder can prove against an
/// attribute in their [`Credential`] without revealing the
/// underlying value. The relay's predicate-policy table maps a
/// route (e.g. `sealed_inference`) to the set of predicates that
/// must be satisfied; see design doc §4.4 step 4 for the
/// rate-limit predicate as the canonical example.
///
/// Tagged enum serialized with `{"kind": "...", ...}`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Predicate {
    /// Membership: the value of `attribute` is in the issuer-pinned
    /// set referenced by `set_id`. Used for e.g.
    /// `subscription_tier in {pro, plus}`.
    MembershipInSet { attribute: String, set_id: String },
    /// Range floor: `attribute >= value`. Used for e.g.
    /// `usage_quota >= remaining`.
    GreaterThanOrEqual { attribute: String, value: i64 },
    /// Range ceiling: `attribute <= value`. Used for e.g.
    /// `age <= 120` sanity caps or `usage_counter <= tier_quota`.
    LessThanOrEqual { attribute: String, value: i64 },
    /// Equality: `attribute == value`. Used sparingly — equality
    /// disclosure leaks the most bits per predicate.
    Equality {
        attribute: String,
        value: AttributeValue,
    },
}

/// 32-byte hex-encoded epoch-scoped nullifier. The relay records
/// every nullifier it has seen within the active epoch window and
/// rejects a presentation whose nullifier collides — this both
/// detects credential cloning across devices and enforces the
/// per-window rate limit without a server-side counter (design
/// doc §4.5).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(transparent)]
pub struct Nullifier(pub String);

impl Nullifier {
    /// Validate that a string is a 32-byte hex-encoded nullifier
    /// and wrap it. Rejects wrong-length input and non-hex
    /// characters. Mirrors the validator the relay applies before
    /// inserting into the per-epoch nullifier set.
    pub fn parse(s: impl Into<String>) -> Result<Self, BbsVerifyError> {
        let s = s.into();
        if s.len() != 64 {
            return Err(BbsVerifyError::PresentationMalformed(format!(
                "nullifier must be 32 bytes hex (64 chars); got {}",
                s.len()
            )));
        }
        hex::decode(&s).map_err(|e| {
            BbsVerifyError::PresentationMalformed(format!("nullifier not valid hex: {e}"))
        })?;
        Ok(Self(s))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// The wire payload the user attaches to a sealed-inference
/// request in place of (eventually: alongside, during Phase 0 of
/// the migration in design doc §8) the trailing Ed25519 signature.
///
/// `proof_b64` is the opaque BBS+ presentation produced by the
/// presentation builder in `apps/web/src/lib/anon-cred.ts`
/// (follow-up). The shape of the bytes inside is system-specific
/// — this crate does not parse them.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PresentationProof {
    /// Opaque base64-encoded BBS+ presentation body.
    pub proof_b64: String,
    /// Cleartext attributes the holder chose to reveal. Empty
    /// when the holder wants pure predicate-only disclosure.
    pub disclosed_attributes: BTreeMap<String, AttributeValue>,
    /// Zero-knowledge predicates the holder proves alongside the
    /// signature-knowledge proof. The relay's predicate-policy
    /// table for the request's route must be a subset of these.
    pub predicates: Vec<Predicate>,
    /// 32-byte hex-encoded epoch-scoped nullifier. Relay records
    /// it to prevent double-spend within an epoch.
    pub nullifier_hex: String,
    /// The issuer epoch the presentation is anchored against —
    /// determines which `pk_bbs` and which accumulator state the
    /// verifier loads.
    pub issuer_epoch: u64,
    /// Unix-seconds start of the validity window for this proof.
    /// The verifier rejects presentations outside
    /// `[window_start, window_start + epoch_duration]`.
    pub epoch_window_start: i64,
}

/// Verifier error surface. Today the proof bodies aren't actually
/// validated by this crate — the implementation lives in the
/// `said-bbs-verifier` follow-up. These variants exist so client
/// code can pattern-match on the failure mode once verification is
/// wired up.
#[derive(Debug, thiserror::Error)]
pub enum BbsVerifyError {
    #[error("issuer epoch unknown to verifier: {claimed}")]
    IssuerEpochUnknown { claimed: u64 },
    #[error("nullifier already used within active epoch: {nullifier}")]
    NullifierAlreadyUsed { nullifier: String },
    #[error("predicate unsatisfied: {predicate:?}")]
    PredicateUnsatisfied { predicate: Predicate },
    #[error("malformed presentation: {0}")]
    PresentationMalformed(String),
    #[error("presentation outside epoch window: now={now}, window=[{window_start}, {window_end}]")]
    OutsideEpochWindow {
        now: i64,
        window_start: i64,
        window_end: i64,
    },
    #[error("BBS+ algorithm not yet implemented in this verifier: {0:?}")]
    AlgorithmNotImplemented(BbsAlgorithm),
}

impl PresentationProof {
    /// Top-level verifier entry point. Today this is intentionally
    /// stubbed: the real implementation lands in
    /// `crates/said-bbs-issuer` (issuance) + `crates/said-bbs-verifier`
    /// (verification) follow-ups. The signature exists so the relay's
    /// `validate_sealed_envelope_bytes` dispatch site can be wired up
    /// against the final shape ahead of the crypto landing.
    ///
    /// When implemented, this will:
    /// (1) load `pk_bbs[issuer_epoch]` from the attestation chain,
    /// (2) run BBS-ProofVerify against `proof_b64`,
    /// (3) verify each predicate in `predicates` against the
    ///     auxiliary range/membership proofs embedded in `proof_b64`,
    /// (4) parse + return the [`Nullifier`] for caller-side
    ///     double-spend tracking.
    pub fn verify(&self, key: &IssuerKey) -> Result<Nullifier, BbsVerifyError> {
        Err(BbsVerifyError::AlgorithmNotImplemented(key.algorithm))
    }

    /// Returns the presentation's nullifier as a typed
    /// [`Nullifier`], validating the hex format. The relay caches
    /// this for the epoch's duration to detect replay.
    pub fn nullifier(&self) -> Result<Nullifier, BbsVerifyError> {
        Nullifier::parse(self.nullifier_hex.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_credential() -> Credential {
        let mut attrs = BTreeMap::new();
        attrs.insert(
            "subscription_tier".into(),
            AttributeValue::String("pro".into()),
        );
        attrs.insert("usage_quota".into(), AttributeValue::Integer(1000));
        attrs.insert("over_18".into(), AttributeValue::Boolean(true));
        Credential {
            subject_did: "did:key:z6Mk…abc".into(),
            attributes: attrs,
            issuer_epoch: 42,
            issued_at: 1_700_000_000,
            expires_at: 1_700_086_400,
            nullifier_seed: "a".repeat(64),
        }
    }

    fn sample_presentation() -> PresentationProof {
        let mut disclosed = BTreeMap::new();
        disclosed.insert(
            "subscription_tier".into(),
            AttributeValue::String("pro".into()),
        );
        PresentationProof {
            proof_b64: "QkxBQg==".into(),
            disclosed_attributes: disclosed,
            predicates: vec![Predicate::GreaterThanOrEqual {
                attribute: "usage_quota".into(),
                value: 100,
            }],
            nullifier_hex: "d".repeat(64),
            issuer_epoch: 42,
            epoch_window_start: 1_700_000_000,
        }
    }

    #[test]
    fn bbs_algorithm_serializes_as_snake_case() {
        assert_eq!(
            serde_json::to_value(BbsAlgorithm::Bls12_381G2Sha256).unwrap(),
            json!("bls12_381_g2_sha256"),
        );
        assert_eq!(
            serde_json::to_value(BbsAlgorithm::Bls12_381G2Shake256).unwrap(),
            json!("bls12_381_g2_shake256"),
        );
    }

    #[test]
    fn issuer_key_round_trips() {
        let original = IssuerKey {
            epoch: 7,
            key_id: "bbs-key-2026-q2".into(),
            algorithm: BbsAlgorithm::Bls12_381G2Sha256,
        };
        let encoded = serde_json::to_string(&original).unwrap();
        let decoded: IssuerKey = serde_json::from_str(&encoded).unwrap();
        assert_eq!(original, decoded);
    }

    #[test]
    fn attribute_value_tagged_enum_serializes_correctly() {
        assert_eq!(
            serde_json::to_value(AttributeValue::String("pro".into())).unwrap(),
            json!({"kind": "string", "value": "pro"}),
        );
        assert_eq!(
            serde_json::to_value(AttributeValue::Integer(42)).unwrap(),
            json!({"kind": "integer", "value": 42}),
        );
        assert_eq!(
            serde_json::to_value(AttributeValue::Boolean(true)).unwrap(),
            json!({"kind": "boolean", "value": true}),
        );
    }

    #[test]
    fn credential_round_trips() {
        let original = sample_credential();
        let encoded = serde_json::to_string(&original).unwrap();
        let decoded: Credential = serde_json::from_str(&encoded).unwrap();
        assert_eq!(original, decoded);
    }

    #[test]
    fn predicate_variants_serialize_with_kind_tag() {
        let m = Predicate::MembershipInSet {
            attribute: "subscription_tier".into(),
            set_id: "paid-tiers-v1".into(),
        };
        assert_eq!(
            serde_json::to_value(&m).unwrap(),
            json!({
                "kind": "membership_in_set",
                "attribute": "subscription_tier",
                "set_id": "paid-tiers-v1",
            }),
        );

        let g = Predicate::GreaterThanOrEqual {
            attribute: "usage_quota".into(),
            value: 100,
        };
        assert_eq!(
            serde_json::to_value(&g).unwrap(),
            json!({
                "kind": "greater_than_or_equal",
                "attribute": "usage_quota",
                "value": 100,
            }),
        );

        let l = Predicate::LessThanOrEqual {
            attribute: "usage_counter".into(),
            value: 1000,
        };
        assert_eq!(
            serde_json::to_value(&l).unwrap(),
            json!({
                "kind": "less_than_or_equal",
                "attribute": "usage_counter",
                "value": 1000,
            }),
        );

        let e = Predicate::Equality {
            attribute: "tier".into(),
            value: AttributeValue::String("pro".into()),
        };
        assert_eq!(
            serde_json::to_value(&e).unwrap(),
            json!({
                "kind": "equality",
                "attribute": "tier",
                "value": {"kind": "string", "value": "pro"},
            }),
        );
    }

    #[test]
    fn predicate_round_trips() {
        let original = Predicate::Equality {
            attribute: "tier".into(),
            value: AttributeValue::String("pro".into()),
        };
        let encoded = serde_json::to_string(&original).unwrap();
        let decoded: Predicate = serde_json::from_str(&encoded).unwrap();
        assert_eq!(original, decoded);
    }

    #[test]
    fn presentation_proof_serializes_with_expected_shape() {
        // Wire-format golden vector — pins the JSON shape so a
        // future refactor that perturbs serde annotations fails
        // loudly. Referenced by the Tier 2G design doc.
        let p = sample_presentation();
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(
            v,
            json!({
                "proof_b64": "QkxBQg==",
                "disclosed_attributes": {
                    "subscription_tier": {"kind": "string", "value": "pro"},
                },
                "predicates": [
                    {
                        "kind": "greater_than_or_equal",
                        "attribute": "usage_quota",
                        "value": 100,
                    }
                ],
                "nullifier_hex": "d".repeat(64),
                "issuer_epoch": 42,
                "epoch_window_start": 1_700_000_000,
            }),
        );
    }

    #[test]
    fn presentation_proof_round_trips() {
        let original = sample_presentation();
        let encoded = serde_json::to_string(&original).unwrap();
        let decoded: PresentationProof = serde_json::from_str(&encoded).unwrap();
        assert_eq!(original, decoded);
    }

    #[test]
    fn nullifier_parse_accepts_valid_hex() {
        let n = Nullifier::parse("a".repeat(64)).expect("32-byte hex parses");
        assert_eq!(n.as_str(), &"a".repeat(64));
    }

    #[test]
    fn nullifier_parse_rejects_wrong_length() {
        let err = Nullifier::parse("ab").unwrap_err();
        assert!(matches!(err, BbsVerifyError::PresentationMalformed(_)));
        let err = Nullifier::parse("a".repeat(63)).unwrap_err();
        assert!(matches!(err, BbsVerifyError::PresentationMalformed(_)));
        let err = Nullifier::parse("a".repeat(65)).unwrap_err();
        assert!(matches!(err, BbsVerifyError::PresentationMalformed(_)));
    }

    #[test]
    fn nullifier_parse_rejects_non_hex() {
        // Length is right (64) but contains non-hex characters.
        let bad: String = "zz".repeat(32);
        let err = Nullifier::parse(bad).unwrap_err();
        assert!(matches!(err, BbsVerifyError::PresentationMalformed(_)));
    }

    #[test]
    fn nullifier_serializes_as_a_bare_string() {
        // #[serde(transparent)] — should NOT wrap as {"0": "..."}.
        let n = Nullifier("a".repeat(64));
        assert_eq!(serde_json::to_value(&n).unwrap(), json!("a".repeat(64)));
    }

    #[test]
    fn presentation_nullifier_helper_returns_typed_value() {
        let p = sample_presentation();
        let n = p.nullifier().expect("sample has valid 32-byte hex");
        assert_eq!(n.as_str(), &"d".repeat(64));
    }

    #[test]
    fn verify_returns_algorithm_not_implemented_for_both_variants() {
        let p = sample_presentation();
        let sha_key = IssuerKey {
            epoch: 42,
            key_id: "k1".into(),
            algorithm: BbsAlgorithm::Bls12_381G2Sha256,
        };
        let shake_key = IssuerKey {
            epoch: 42,
            key_id: "k2".into(),
            algorithm: BbsAlgorithm::Bls12_381G2Shake256,
        };
        assert!(matches!(
            p.verify(&sha_key),
            Err(BbsVerifyError::AlgorithmNotImplemented(
                BbsAlgorithm::Bls12_381G2Sha256
            )),
        ));
        assert!(matches!(
            p.verify(&shake_key),
            Err(BbsVerifyError::AlgorithmNotImplemented(
                BbsAlgorithm::Bls12_381G2Shake256
            )),
        ));
    }

    #[test]
    fn forward_compat_extra_fields_are_ignored() {
        // A future PR adding a `presentation_header_hash` or similar
        // field shouldn't break older deserializers.
        let raw = json!({
            "proof_b64": "Zm9v",
            "disclosed_attributes": {},
            "predicates": [],
            "nullifier_hex": "d".repeat(64),
            "issuer_epoch": 1,
            "epoch_window_start": 0,
            "future_field": "ignored",
        });
        let _: PresentationProof = serde_json::from_value(raw).expect("forward-compat decode");
    }
}
