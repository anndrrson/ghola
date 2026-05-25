//! Content-addressed deduplication for `/relay` POSTs.
//!
//! # Problem
//!
//! A naive relayer accepts every `POST /relay` it sees, allocates a fresh
//! `request_id`, and enqueues a new withdrawal. That's vulnerable to two
//! classes of attack:
//!
//! 1. **Adversarial replay** — a network observer who captures a (still
//!    encrypted, but the body is verbatim-replayable) `POST /relay` can
//!    re-submit it to the same relayer (or a sibling relayer that shares
//!    a DB). Each replay re-queues the same proof; once the queue runs
//!    them all to chain, the first wins on the on-chain nullifier check
//!    but the rest still consumed queue slots, fee-payer SOL, and an
//!    on-chain `InvalidProof` / `NullifierAlreadyUsed` fail-tx slot that
//!    is *itself* a side-channel telling the observer which submission
//!    was "real."
//! 2. **Honest client retry** — a client whose request times out (or
//!    whose response is lost on the way back) will retry with the SAME
//!    body. Without dedup, this re-queues a second copy and the client
//!    ends up holding two distinct `request_id`s pointing at the same
//!    proof — `/status/:id` becomes a confusing experience.
//!
//! Both are fixed by content-addressing the proof bundle: we hash the
//! Groth16 proof fields (`a || b || c`) and treat that 32-byte digest as
//! a primary key. A second `POST` with the same proof gets the *first*
//! request's id back (status `"duplicate"`), never a fresh slot.
//!
//! # Hash choice
//!
//! The dedup key is `blake3(a_bytes || b_bytes || c_bytes)` where the
//! inputs are the canonical JSON-serialized proof components (we treat
//! them as opaque bytes — see [`extract_proof_abc`]). The rest of the
//! proof bundle (`public_inputs`, recipient, fee, etc.) is intentionally
//! NOT in the key:
//!
//!   - The proof is bound to its public inputs by Groth16 itself. If
//!     `proof` matches but `public_inputs` differ, the on-chain verifier
//!     will reject; an attacker who tries to reuse a proof against a
//!     fresh recipient just gets `InvalidProof`. We don't need to also
//!     reject it client-side — and we WANT the dedup key to be smaller
//!     than the full payload so that legitimate retries (which may have
//!     slight client-side variance in JSON whitespace, field ordering,
//!     recipient encoding) still collide.
//!   - Keeping the key narrow also matches Stream 1's
//!     `inv_relay_dedupe` predicate, which models the key as `H(proof)`
//!     only.
//!
//! Stream 1 cross-check: if you change the hash scheme here, the
//! `inv_relay_dedupe` predicate needs to be re-derived.
//!
//! # Atomicity
//!
//! We use sled's `compare_and_swap` so check-and-insert is a single
//! atomic op. Two concurrent identical POSTs see exactly one `Fresh`
//! and one `Duplicate(existing_id)` — never both `Fresh`, never both
//! `Duplicate`. This is critical: the relayer is single-process today
//! but the dispatcher-tier plan (Phase 41+) puts multiple relayers
//! behind a load balancer, sharing the dedup DB. Without CAS we'd race.
//!
//! # Privacy
//!
//! Per the relayer's invariants (`lib.rs` doc comment), we MUST NOT log
//! the dedup key, the proof bytes, or the duplicate-detection event at
//! INFO. The key is a content-derivative of the proof, and the proof's
//! linkage to a user identity is exactly what the shielded pool is
//! protecting. DEBUG only, ever. No exceptions.

use std::path::Path;

use serde_json::Value;
use uuid::Uuid;

use crate::error::{Error, Result};

/// Sled tree name. Lives inside the same sled DB as the withdrawal
/// queue (`queue.rs` opens `withdrawals`), in a sibling tree, so the
/// queue and dedup index share a single fsync stream and a single
/// process-wide file lock.
pub const DEDUP_TREE: &str = "dedup";

/// Outcome of a dedup lookup-and-insert.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DedupOutcome {
    /// First time we've seen this proof. Caller should enqueue normally.
    Fresh,
    /// Already seen. Caller should short-circuit and return this id to
    /// the client with status `"duplicate"`.
    Duplicate(Uuid),
}

/// Content-addressed dedup index for accepted proofs.
///
/// Layout: `tree[blake3(proof_a || proof_b || proof_c)] = uuid_bytes`.
#[derive(Clone)]
pub struct Dedup {
    tree: sled::Tree,
}

impl Dedup {
    /// Open the dedup index inside an existing sled DB.
    ///
    /// We piggy-back on the same `sled::Db` that the queue uses; sled
    /// allows multiple named trees per DB. Passing the same `path` as
    /// [`WithdrawalQueue::open`](crate::queue::WithdrawalQueue::open) is
    /// safe and intentional — they share the DB but not the tree.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let db = sled::open(path)?;
        Self::open_in(&db)
    }

    pub fn open_in(db: &sled::Db) -> Result<Self> {
        let tree = db.open_tree(DEDUP_TREE)?;
        Ok(Self { tree })
    }

    /// In-memory dedup for tests. Mirrors
    /// [`WithdrawalQueue::open_temporary`](crate::queue::WithdrawalQueue::open_temporary).
    pub fn open_temporary() -> Result<Self> {
        let db = sled::Config::new().temporary(true).open()?;
        let tree = db.open_tree(DEDUP_TREE)?;
        Ok(Self { tree })
    }

    /// Atomic check-then-insert. If the proof's content hash is novel,
    /// records `(hash -> request_id)` and returns [`DedupOutcome::Fresh`].
    /// If it's already there, returns the existing id without touching
    /// the tree.
    ///
    /// `request_id` is supplied (not generated here) so the route
    /// handler can use the same uuid it logs internally — a small
    /// audit-trail symmetry that pays off when correlating queue rows
    /// with sled rows during incident triage.
    pub fn check_and_record(
        &self,
        proof_bundle: &Value,
        request_id: Uuid,
    ) -> Result<DedupOutcome> {
        self.check_and_record_at(proof_bundle, request_id, now_unix())
    }

    /// Like [`check_and_record`](Self::check_and_record) but with an explicit
    /// insertion timestamp (unix seconds), so tests can exercise TTL pruning
    /// deterministically.
    ///
    /// Value layout: `uuid(16 bytes) || inserted_at_unix(8 bytes, big-endian
    /// i64)`. The 8-byte suffix lets [`prune_older_than`](Self::prune_older_than)
    /// bound the index without an external timestamp store. Legacy 16-byte
    /// values (pre-TTL) are still decodable and treated as having no known age
    /// (never pruned), so this is backward-compatible with any existing DB.
    pub fn check_and_record_at(
        &self,
        proof_bundle: &Value,
        request_id: Uuid,
        inserted_at_unix: i64,
    ) -> Result<DedupOutcome> {
        let key = derive_key(proof_bundle)?;
        let mut new_value = Vec::with_capacity(24);
        new_value.extend_from_slice(request_id.as_bytes());
        new_value.extend_from_slice(&inserted_at_unix.to_be_bytes());

        // CAS: expect None, set to new_value. On success — Fresh.
        // On failure, the Err arm of the inner Result gives us the
        // current (already-recorded) value, which we decode to a UUID.
        let cas = self
            .tree
            .compare_and_swap(&key, None as Option<&[u8]>, Some(new_value))?;

        match cas {
            Ok(()) => Ok(DedupOutcome::Fresh),
            Err(sled::CompareAndSwapError { current, .. }) => {
                let existing_bytes = current.ok_or_else(|| {
                    Error::Internal("dedup CAS returned no current value".into())
                })?;
                let existing = decode_uuid(&existing_bytes)?;
                Ok(DedupOutcome::Duplicate(existing))
            }
        }
    }

    /// Remove dedup entries older than `max_age_secs`. Bounds the on-disk
    /// index so a flood of *unique* proofs cannot grow it without limit.
    ///
    /// Safety vs. replay defense: only entries OLDER than `max_age_secs` are
    /// removed. As long as `max_age_secs` comfortably exceeds the queue's
    /// drain + client-retry window, pruning a stale entry cannot resurrect a
    /// replay that is still in flight — and even if it did, the on-chain
    /// nullifier check is the ultimate replay backstop. Legacy entries with no
    /// recorded timestamp (16-byte values) are conservatively retained.
    ///
    /// Returns the number of entries removed.
    pub fn prune_older_than(&self, max_age_secs: i64) -> Result<usize> {
        self.prune_older_than_at(max_age_secs, now_unix())
    }

    /// Test-friendly variant taking an explicit "now".
    pub fn prune_older_than_at(&self, max_age_secs: i64, now_unix: i64) -> Result<usize> {
        let cutoff = now_unix.saturating_sub(max_age_secs);
        let mut to_remove: Vec<sled::IVec> = Vec::new();
        for kv in self.tree.iter() {
            let (k, v) = kv?;
            if let Some(ts) = decode_inserted_at(&v) {
                if ts < cutoff {
                    to_remove.push(k);
                }
            }
        }
        let mut removed = 0usize;
        for k in to_remove {
            if self.tree.remove(&k)?.is_some() {
                removed += 1;
            }
        }
        Ok(removed)
    }

    /// Forget a recorded proof — used only by tests and (eventually) by
    /// a background GC sweeper for proofs whose corresponding queue row
    /// has been confirmed-and-deleted long enough that no honest client
    /// will retry. Production callers should NOT invoke this except via
    /// that sweeper; an unrestricted purge defeats the replay defense.
    #[doc(hidden)]
    pub fn forget(&self, proof_bundle: &Value) -> Result<()> {
        let key = derive_key(proof_bundle)?;
        self.tree.remove(&key)?;
        Ok(())
    }

    /// Count of dedup entries. Useful for `/metrics` (Stream 8) and
    /// for invariant assertions in tests. Not privacy-sensitive: this
    /// is the same information as `/metrics` queue depth, modulo GC.
    pub fn len(&self) -> usize {
        self.tree.len()
    }

    /// `true` iff no entries are recorded.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Derive the 32-byte content-addressed key from a proof bundle.
///
/// `key = blake3(proof_a_bytes || proof_b_bytes || proof_c_bytes)`.
///
/// Each `proof_x` is taken as the canonical UTF-8 serialization of the
/// JSON sub-value at `proof.x`. We do NOT structurally decode (we don't
/// know whether it's a hex string, array of hex limbs, etc. — the
/// relayer is opaque-by-design about proof internals; see
/// `queue::ProofBlob` for rationale). Canonicalization is `to_string()`
/// on the `serde_json::Value`, which produces stable bytes for any given
/// `Value` tree.
///
/// We DO require `proof.a`, `proof.b`, `proof.c` to exist. A bundle
/// without all three is rejected — that's tighter than the existing
/// `validate_proof_shape` (which only requires `proof` to be a key),
/// but it's reachable only via a malformed payload that would have
/// failed downstream anyway, so the stricter check here costs nothing
/// in legitimate traffic.
pub fn derive_key(proof_bundle: &Value) -> Result<[u8; 32]> {
    let (a, b, c) = extract_proof_abc(proof_bundle)?;
    let mut hasher = blake3::Hasher::new();
    // We feed canonical Value-string bytes, NOT the source JSON text.
    // `serde_json::to_string(&Value)` is deterministic — same value
    // tree always yields same bytes — which is what we need for two
    // clients that submit the same proof with different whitespace to
    // still collide.
    hasher.update(a.to_string().as_bytes());
    hasher.update(b.to_string().as_bytes());
    hasher.update(c.to_string().as_bytes());
    let mut out = [0u8; 32];
    out.copy_from_slice(hasher.finalize().as_bytes());
    Ok(out)
}

/// Pull `proof.a`, `proof.b`, `proof.c` out of a relayer proof bundle.
/// Also accepts the flattened Android/cloud bridge shape `{a,b,c,...}`.
/// Errors are flat `BadRequest`s so the route handler propagates them
/// as 400 with a uniform `"bad request"` body (the privacy-preserving
/// error mapping in `error.rs`).
fn extract_proof_abc(bundle: &Value) -> Result<(&Value, &Value, &Value)> {
    let obj = bundle
        .as_object()
        .ok_or_else(|| Error::BadRequest("proof_bundle must be an object".into()))?;
    let proof = obj.get("proof").and_then(|v| v.as_object()).unwrap_or(obj);
    let a = proof
        .get("a")
        .ok_or_else(|| Error::BadRequest("proof_bundle proof a missing".into()))?;
    let b = proof
        .get("b")
        .ok_or_else(|| Error::BadRequest("proof_bundle proof b missing".into()))?;
    let c = proof
        .get("c")
        .ok_or_else(|| Error::BadRequest("proof_bundle proof c missing".into()))?;
    Ok((a, b, c))
}

/// Decode the request-id from a dedup value. Accepts both the legacy 16-byte
/// (`uuid` only) and the current 24-byte (`uuid || inserted_at`) layouts; the
/// uuid is always the first 16 bytes.
fn decode_uuid(bytes: &[u8]) -> Result<Uuid> {
    if bytes.len() < 16 {
        return Err(Error::Internal(format!(
            "dedup value too short: {}",
            bytes.len()
        )));
    }
    let mut arr = [0u8; 16];
    arr.copy_from_slice(&bytes[..16]);
    Ok(Uuid::from_bytes(arr))
}

/// Decode the inserted-at unix timestamp suffix, if present (24-byte values).
/// Legacy 16-byte values return `None` (unknown age → never pruned).
fn decode_inserted_at(bytes: &[u8]) -> Option<i64> {
    if bytes.len() < 24 {
        return None;
    }
    let mut ts = [0u8; 8];
    ts.copy_from_slice(&bytes[16..24]);
    Some(i64::from_be_bytes(ts))
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn proof(a: &str, b: &str, c: &str) -> Value {
        json!({
            "proof": {"a": a, "b": b, "c": c},
            "public_inputs": {"root": "00", "input_nullifiers": ["00"], "output_commitments": ["00"]}
        })
    }

    fn flat_proof(a: &str, b: &str, c: &str) -> Value {
        json!({
            "a": a,
            "b": b,
            "c": c,
            "root": "00",
            "input_nullifiers": ["00"],
            "output_commitments": ["00"]
        })
    }

    #[test]
    fn fresh_then_duplicate() {
        let d = Dedup::open_temporary().unwrap();
        let p = proof("a1", "b1", "c1");
        let id1 = Uuid::new_v4();
        assert_eq!(d.check_and_record(&p, id1).unwrap(), DedupOutcome::Fresh);
        let id2 = Uuid::new_v4();
        assert_eq!(
            d.check_and_record(&p, id2).unwrap(),
            DedupOutcome::Duplicate(id1),
            "second insert must return the first id, not the second"
        );
    }

    #[test]
    fn distinct_proofs_dont_collide() {
        let d = Dedup::open_temporary().unwrap();
        let p1 = proof("a1", "b1", "c1");
        let p2 = proof("a2", "b1", "c1");
        let id1 = Uuid::new_v4();
        let id2 = Uuid::new_v4();
        assert_eq!(d.check_and_record(&p1, id1).unwrap(), DedupOutcome::Fresh);
        assert_eq!(d.check_and_record(&p2, id2).unwrap(), DedupOutcome::Fresh);
        assert_eq!(d.len(), 2);
    }

    #[test]
    fn key_ignores_non_proof_fields() {
        // Same proof.a/b/c, different public_inputs -> same key.
        // This is the deliberate design choice documented in the
        // module preamble: the on-chain verifier rejects mismatched
        // public inputs, so client-side we collide on proof bytes only.
        let mut p1 = proof("a1", "b1", "c1");
        let mut p2 = proof("a1", "b1", "c1");
        p1["public_inputs"]["root"] = json!("aaaa");
        p2["public_inputs"]["root"] = json!("bbbb");
        let k1 = derive_key(&p1).unwrap();
        let k2 = derive_key(&p2).unwrap();
        assert_eq!(k1, k2);
    }

    #[test]
    fn flattened_android_cloud_proof_shape_derives_same_key() {
        let nested = proof("a1", "b1", "c1");
        let flat = flat_proof("a1", "b1", "c1");
        assert_eq!(derive_key(&nested).unwrap(), derive_key(&flat).unwrap());
    }

    #[test]
    fn missing_abc_field_is_bad_request() {
        let d = Dedup::open_temporary().unwrap();
        let p = json!({"proof": {"a": "x", "b": "y"}, "public_inputs": {}});
        let err = d.check_and_record(&p, Uuid::new_v4()).unwrap_err();
        match err {
            Error::BadRequest(_) => {}
            other => panic!("expected BadRequest, got {other:?}"),
        }
    }

    #[test]
    fn prune_removes_only_old_entries() {
        let d = Dedup::open_temporary().unwrap();
        let old = proof("old", "b", "c");
        let recent = proof("recent", "b", "c");
        // Insert one at t=1000 and one at t=2000.
        d.check_and_record_at(&old, Uuid::new_v4(), 1000).unwrap();
        d.check_and_record_at(&recent, Uuid::new_v4(), 2000).unwrap();
        assert_eq!(d.len(), 2);
        // At now=3000 with max_age=1500, cutoff=1500: only the t=1000 entry is stale.
        let removed = d.prune_older_than_at(1500, 3000).unwrap();
        assert_eq!(removed, 1);
        assert_eq!(d.len(), 1);
        // The surviving entry is still deduped.
        assert!(matches!(
            d.check_and_record_at(&recent, Uuid::new_v4(), 3000).unwrap(),
            DedupOutcome::Duplicate(_)
        ));
    }

    #[test]
    fn key_is_deterministic() {
        // Equivalent JSON objects with differently-ordered keys inside
        // proof.b should hash to the same key — serde_json `Value` is
        // a `Map` which preserves insertion order in `to_string`. We
        // verify the property we actually rely on: two identical
        // `Value` trees produce identical bytes.
        let p1 = proof("xx", "yy", "zz");
        let p2 = proof("xx", "yy", "zz");
        assert_eq!(derive_key(&p1).unwrap(), derive_key(&p2).unwrap());
    }
}
