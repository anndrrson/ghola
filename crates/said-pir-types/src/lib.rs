//! Schema types for private-information-retrieval (PIR).
//!
//! Tier 2J of the peak-security plan closes the residual leak that
//! survives sealed inference: when the assistant fetches *context* —
//! a user's vault doc, a calendar entry, an embedding row from an
//! external knowledge base — the **retrieval query itself** reveals
//! user intent even if the chat message is sealed. See
//! `docs/security/tier-2j-private-retrieval.md` for the threat model,
//! the construction comparison (SimplePIR vs OnionPIR vs FrodoPIR),
//! and the recommendation (SimplePIR for v1 over the user vault,
//! OnionPIR for v2 over external RAG once the Tier 2F multi-operator
//! network is live).
//!
//! This crate is the **schema-only first PR** the design doc names
//! at the bottom under "Next concrete action": types + serde + golden
//! vectors only. The actual SimplePIR `Answer` server, the WASM-backed
//! TS client, and the `chat-vault.ts` integration all type against the
//! shapes defined here so they can land in parallel.
//!
//! Deliberately **out of scope** for this crate:
//!
//! - The SimplePIR / OnionPIR math itself (LWE encryption, matrix-
//!   vector products over the corpus, RLWE share splitting, XOR
//!   recombination). That lands in `crates/said-pir-server` and
//!   `crates/said-pir-client` follow-ups.
//! - Hint precomputation on vault add/remove. That hooks into
//!   `apps/web/src/lib/chat-vault.ts` and the cloud-side index.
//! - Wire-level OHTTP wrapping. That layers on top at the transport.
//!
//! Wire format is intentionally minimal — `hint_b64`, `query_b64`,
//! `answer_b64`, and the OnionPIR share bodies are opaque to ghola
//! (scheme-specific). Only the metadata + epoch tracking need a
//! stable structure on this side.

use serde::{Deserialize, Serialize};

/// Identifier of the PIR scheme the opaque body fields conform to.
/// Serialized as `"simple_pir"` / `"onion_pir"`.
///
/// The two variants correspond to the two deployment regimes named in
/// the design doc: `SimplePir` for the **user vault** (single-server,
/// lattice-based, trusts no operator) and `OnionPir` for **external
/// RAG** (multi-server, XOR/RLWE shares, trusts non-collusion across
/// a k-of-k operator set).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum PirScheme {
    /// SimplePIR (Henzinger et al., USENIX Sec '23). The v1
    /// recommendation in the design doc; single-server LWE PIR with
    /// a public preprocessed hint and online cost `O(√N)`.
    SimplePir,
    /// OnionPIR (Mughees et al., CCS 2021). Reserved for the v2 path
    /// over Tier 2F's multi-operator network for external RAG corpora.
    OnionPir,
}

/// Opaque identifier for a corpus the PIR server hosts. The string
/// shape is convention-based, not enforced:
///
/// - `"vault:user-did-abc"` — a per-user encrypted vault index.
/// - `"web-index:embeddings-v1"` — a shared external knowledge base.
///
/// `#[serde(transparent)]` so it serializes as a bare string, not as
/// `{"0": "..."}`. The corpus id is **public** — a relay operator who
/// sees `vault:user-did-abc` learns "this user has a vault," which is
/// covered explicitly in §6 of the design doc as a weaker signal than
/// the query content itself and one we accept.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(transparent)]
pub struct CorpusId(pub String);

impl CorpusId {
    pub fn new(s: impl Into<String>) -> Self {
        Self(s.into())
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Monotonic counter that increments whenever the underlying corpus
/// mutates — a doc is added, removed, or re-embedded. Clients cache
/// the hint under `(corpus_id, hint_epoch)`; on mismatch the server
/// returns `PirError::EpochStale` with the current epoch and the
/// client refetches the hint and replays the query (§4.5 of the
/// design doc).
///
/// `#[serde(transparent)]` so it serializes as a bare integer.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(transparent)]
pub struct HintEpoch(pub u64);

impl HintEpoch {
    pub fn new(v: u64) -> Self {
        Self(v)
    }
    pub fn value(&self) -> u64 {
        self.0
    }
}

/// Public preprocessed structure the server publishes once per epoch.
/// Fetched by the client once and reused across many online queries.
/// The hint is the same for *every* querier — that's the whole point
/// of PIR; no privacy property depends on the hint being secret. It
/// is safe to serve over a CDN.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Hint {
    pub corpus_id: CorpusId,
    pub epoch: HintEpoch,
    pub scheme: PirScheme,
    /// Base64-encoded opaque hint body. Shape is scheme-specific
    /// (e.g. for SimplePIR this is the `A · DB` matrix-vector
    /// product); decoded inside the PIR client.
    pub hint_b64: String,
    /// Number of records the corpus held at the time this hint was
    /// produced. Useful for the client to size its query vector and
    /// for the relay to surface storage-budget warnings.
    pub corpus_item_count: u32,
    /// Unix epoch (seconds) when the hint was published. Lets the
    /// client age out cached hints on TTL even before the epoch
    /// counter increments.
    pub published_at: i64,
}

/// What the client uploads. The body is an opaque ciphertext that
/// commits to the queried row index without revealing it — for
/// SimplePIR a Regev-style LWE ciphertext, for OnionPIR an RLWE share
/// (carried via `OnionQueryShare` rather than this type).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Query {
    pub corpus_id: CorpusId,
    pub epoch: HintEpoch,
    pub scheme: PirScheme,
    /// Base64-encoded opaque query ciphertext. Scheme-specific.
    pub query_b64: String,
    /// Byte-size of the encoded query, surfaced for metrics and
    /// quota tracking. **Does not reveal which item was queried** —
    /// for SimplePIR the size is determined entirely by `√N` and the
    /// LWE parameters, not by the row index.
    pub query_size: u32,
}

/// What the server returns. The body is an opaque ciphertext the
/// client decodes against the LWE secret state it generated alongside
/// the query — the recovered plaintext is the encrypted-at-rest blob
/// from the addressed corpus row, which the client *then* decrypts
/// against the user's vault key. PIR hides the addressing; the at-rest
/// encryption hides the content from the server.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Answer {
    pub corpus_id: CorpusId,
    pub epoch: HintEpoch,
    pub scheme: PirScheme,
    /// Base64-encoded opaque answer ciphertext. The client decrypts
    /// this client-side against the secret state it kept from the
    /// query-build step.
    pub answer_b64: String,
    /// Wall-clock time the server spent on the `Answer` step, in
    /// microseconds. Lets the client estimate online-phase cost for
    /// budgeting + alerting when a corpus has grown past its
    /// SimplePIR sweet spot (§4.4 latency budget).
    pub server_time_micros: u64,
}

/// One share of a multi-server (OnionPIR) query. The client splits a
/// single logical query into N shares using OnionPIR's RLWE-based
/// share-compression layer; each share is uploaded to a different
/// relay. Any `share_total − 1` shares are information-theoretically
/// uniform random — only the full set recovers anything about the
/// queried row, so the privacy degrades to nothing if and only if all
/// `share_total` operators collude.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OnionQueryShare {
    pub corpus_id: CorpusId,
    pub epoch: HintEpoch,
    /// Zero-indexed position of this share within the `share_total`-
    /// way split. The relay uses this only to validate the share
    /// envelope; it does not influence the `Answer` computation.
    pub share_index: u8,
    /// Total number of shares the client produced. Equals the number
    /// of independently-operated relays the query is fanned out
    /// across. Typical value is 3 (§5 of the design doc).
    pub share_total: u8,
    /// Base64-encoded opaque share ciphertext.
    pub share_b64: String,
}

/// One share of the multi-server (OnionPIR) answer. The client
/// homomorphically/XOR-combines the shares to recover the addressed
/// row. Each relay returns exactly one of these per query share.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OnionAnswerShare {
    pub corpus_id: CorpusId,
    pub epoch: HintEpoch,
    pub share_index: u8,
    pub share_total: u8,
    /// Base64-encoded opaque answer-share ciphertext.
    pub answer_b64: String,
}

/// Error surface for the PIR client/server contract. The actual PIR
/// math errors (LWE noise overflow, RLWE decode failure) are owned by
/// the follow-up `said-pir-client` / `said-pir-server` crates; these
/// variants exist so callers can pattern-match on the structural
/// failure modes that show up at the wire layer.
#[derive(Debug, thiserror::Error)]
pub enum PirError {
    /// Client's cached hint is older than the server's current
    /// corpus. The client should refetch the hint at `server_epoch`
    /// and replay the query (§4.5 of the design doc).
    #[error("hint epoch is stale: client has {client_epoch}, server has {server_epoch}")]
    EpochStale {
        client_epoch: u64,
        server_epoch: u64,
    },
    #[error("corpus is not registered on this server: {0:?}")]
    CorpusUnknown(CorpusId),
    #[error("PIR scheme mismatch: client uses {client:?}, server hosts {server:?}")]
    SchemeMismatch {
        client: PirScheme,
        server: PirScheme,
    },
    #[error("malformed PIR query: {0}")]
    QueryMalformed(String),
    #[error("OnionPIR share count mismatch: expected {expected}, got {got}")]
    OnionShareCountMismatch { expected: u8, got: u8 },
    #[error("PIR scheme not yet implemented in this build: {0:?}")]
    SchemeNotImplemented(PirScheme),
}

impl Query {
    /// Rough hint at the size, in bytes, of the answer this query
    /// will produce. Useful for the call site to budget buffer space
    /// and to surface a UI hint when a query is about to fetch a
    /// very large bucketed record.
    ///
    /// **Stub value — to be tightened post-implementation.** The
    /// real answer size for SimplePIR is a function of the corpus
    /// record-size bucket and the LWE parameter set; for OnionPIR
    /// it's `share_total` × per-share size. We return a conservative
    /// fixed bound here so call-site budgeting compiles against the
    /// shape even before the math lands.
    pub fn expected_answer_size_hint(&self) -> usize {
        // Conservative upper bound aligned with §4.4 of the design
        // doc: ~1 KiB per record bucket at v1 vault sizes.
        4 * 1024
    }
}

impl Hint {
    /// Quick structural check that a `Query` was built against this
    /// hint. Cheap, deterministic, no crypto — the SNARK-equivalent
    /// (decoding the LWE noise against the recover state) is the
    /// follow-up `said-pir-client`'s job. This is the wire-shape
    /// guardrail that catches stale-hint replays and cross-scheme
    /// misuse before the body is even decoded.
    pub fn is_compatible_with_query(&self, q: &Query) -> Result<(), PirError> {
        if self.corpus_id != q.corpus_id {
            return Err(PirError::CorpusUnknown(q.corpus_id.clone()));
        }
        if self.epoch != q.epoch {
            return Err(PirError::EpochStale {
                client_epoch: q.epoch.value(),
                server_epoch: self.epoch.value(),
            });
        }
        if self.scheme != q.scheme {
            return Err(PirError::SchemeMismatch {
                client: q.scheme,
                server: self.scheme,
            });
        }
        Ok(())
    }
}

impl OnionQueryShare {
    /// Number of shares the client expects to assemble before the
    /// answer can be recovered. Just returns `self.share_total`; a
    /// named accessor so call sites read clearly when iterating
    /// across the multi-leg fan-out.
    pub fn expected_share_count(&self) -> u8 {
        self.share_total
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_hint() -> Hint {
        Hint {
            corpus_id: CorpusId::new("vault:user-did-abc"),
            epoch: HintEpoch::new(7),
            scheme: PirScheme::SimplePir,
            hint_b64: "SElOVA==".into(),
            corpus_item_count: 1024,
            published_at: 1_715_000_000,
        }
    }

    fn sample_query() -> Query {
        Query {
            corpus_id: CorpusId::new("vault:user-did-abc"),
            epoch: HintEpoch::new(7),
            scheme: PirScheme::SimplePir,
            query_b64: "UVVFUlk=".into(),
            query_size: 5120,
        }
    }

    fn sample_answer() -> Answer {
        Answer {
            corpus_id: CorpusId::new("vault:user-did-abc"),
            epoch: HintEpoch::new(7),
            scheme: PirScheme::SimplePir,
            answer_b64: "QU5T".into(),
            server_time_micros: 4_812,
        }
    }

    fn sample_onion_query_share() -> OnionQueryShare {
        OnionQueryShare {
            corpus_id: CorpusId::new("web-index:embeddings-v1"),
            epoch: HintEpoch::new(42),
            share_index: 1,
            share_total: 3,
            share_b64: "U0hBUkU=".into(),
        }
    }

    fn sample_onion_answer_share() -> OnionAnswerShare {
        OnionAnswerShare {
            corpus_id: CorpusId::new("web-index:embeddings-v1"),
            epoch: HintEpoch::new(42),
            share_index: 1,
            share_total: 3,
            answer_b64: "QVNIQVJF".into(),
        }
    }

    #[test]
    fn pir_scheme_serializes_as_snake_case() {
        assert_eq!(
            serde_json::to_value(PirScheme::SimplePir).unwrap(),
            json!("simple_pir"),
        );
        assert_eq!(
            serde_json::to_value(PirScheme::OnionPir).unwrap(),
            json!("onion_pir"),
        );
    }

    #[test]
    fn corpus_id_serializes_as_a_bare_string() {
        // The #[serde(transparent)] on CorpusId means it shouldn't
        // wrap as {"0": "..."} — it should be a plain string.
        let c = CorpusId::new("vault:user-did-abc");
        assert_eq!(serde_json::to_value(c).unwrap(), json!("vault:user-did-abc"));
    }

    #[test]
    fn hint_round_trips() {
        let original = sample_hint();
        let encoded = serde_json::to_string(&original).unwrap();
        let decoded: Hint = serde_json::from_str(&encoded).unwrap();
        assert_eq!(original, decoded);
    }

    #[test]
    fn query_round_trips() {
        let original = sample_query();
        let encoded = serde_json::to_string(&original).unwrap();
        let decoded: Query = serde_json::from_str(&encoded).unwrap();
        assert_eq!(original, decoded);
    }

    #[test]
    fn answer_round_trips() {
        let original = sample_answer();
        let encoded = serde_json::to_string(&original).unwrap();
        let decoded: Answer = serde_json::from_str(&encoded).unwrap();
        assert_eq!(original, decoded);
    }

    #[test]
    fn onion_query_share_round_trips() {
        let original = sample_onion_query_share();
        let encoded = serde_json::to_string(&original).unwrap();
        let decoded: OnionQueryShare = serde_json::from_str(&encoded).unwrap();
        assert_eq!(original, decoded);
    }

    #[test]
    fn onion_answer_share_round_trips() {
        let original = sample_onion_answer_share();
        let encoded = serde_json::to_string(&original).unwrap();
        let decoded: OnionAnswerShare = serde_json::from_str(&encoded).unwrap();
        assert_eq!(original, decoded);
    }

    #[test]
    fn query_serializes_with_expected_shape() {
        // Wire-format golden vector — pins the JSON shape so a future
        // refactor that perturbs serde annotations fails loudly.
        let q = sample_query();
        let v = serde_json::to_value(&q).unwrap();
        assert_eq!(
            v,
            json!({
                "corpus_id": "vault:user-did-abc",
                "epoch": 7,
                "scheme": "simple_pir",
                "query_b64": "UVVFUlk=",
                "query_size": 5120,
            }),
        );
    }

    #[test]
    fn onion_query_share_serializes_with_expected_shape() {
        let s = sample_onion_query_share();
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(
            v,
            json!({
                "corpus_id": "web-index:embeddings-v1",
                "epoch": 42,
                "share_index": 1,
                "share_total": 3,
                "share_b64": "U0hBUkU=",
            }),
        );
    }

    #[test]
    fn is_compatible_with_query_accepts_matching() {
        let h = sample_hint();
        let q = sample_query();
        assert!(h.is_compatible_with_query(&q).is_ok());
    }

    #[test]
    fn is_compatible_with_query_rejects_corpus_mismatch() {
        let h = sample_hint();
        let mut q = sample_query();
        q.corpus_id = CorpusId::new("vault:other");
        let err = h.is_compatible_with_query(&q).unwrap_err();
        assert!(matches!(err, PirError::CorpusUnknown(_)));
    }

    #[test]
    fn is_compatible_with_query_rejects_epoch_mismatch() {
        let h = sample_hint();
        let mut q = sample_query();
        q.epoch = HintEpoch::new(6);
        let err = h.is_compatible_with_query(&q).unwrap_err();
        assert!(matches!(
            err,
            PirError::EpochStale {
                client_epoch: 6,
                server_epoch: 7,
            }
        ));
    }

    #[test]
    fn is_compatible_with_query_rejects_scheme_mismatch() {
        let h = sample_hint();
        let mut q = sample_query();
        q.scheme = PirScheme::OnionPir;
        let err = h.is_compatible_with_query(&q).unwrap_err();
        assert!(matches!(
            err,
            PirError::SchemeMismatch {
                client: PirScheme::OnionPir,
                server: PirScheme::SimplePir,
            }
        ));
    }

    #[test]
    fn expected_answer_size_hint_is_a_stub() {
        // Documented as "to be tightened post-implementation." This
        // test just pins that the stub returns the conservative
        // bound so a future tightening pass shows up in diffs.
        let q = sample_query();
        assert_eq!(q.expected_answer_size_hint(), 4 * 1024);
    }

    #[test]
    fn expected_share_count_returns_share_total() {
        let s = sample_onion_query_share();
        assert_eq!(s.expected_share_count(), 3);
    }

    #[test]
    fn forward_compat_extra_fields_are_ignored() {
        // A future PR adding e.g. `hint_signature` or `nonce` to the
        // query shouldn't break older deserializers.
        let raw = json!({
            "corpus_id": "vault:user-did-abc",
            "epoch": 7,
            "scheme": "simple_pir",
            "query_b64": "UVVFUlk=",
            "query_size": 5120,
            "future_field": "ignored",
        });
        let _: Query = serde_json::from_value(raw).expect("forward-compat decode");
    }
}
