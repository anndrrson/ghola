//! The redaction layer: intercepts every `tracing::Event` and rewrites
//! the rendered field set so that any KEY on [`DENY_LIST`] has its VALUE
//! replaced with a safe substitute before formatting.
//!
//! # Design
//!
//! `tracing-subscriber` does not expose a hook to mutate field values
//! mid-event. Instead, we register a [`Layer`] that captures every
//! event's field pairs into a per-event visitor, applies the redaction
//! policy, and emits the rewritten line ourselves through the
//! subscriber's writer (`stderr` by default). The downstream `fmt::Layer`
//! still runs in case anyone wires up a non-redacting subscriber for
//! testing, but the public-safe stream is what this layer prints.
//!
//! In practice the deployed subscriber stacks ONLY this layer — the
//! `fmt::Layer` in [`crate::init`] is a fallback path for spans/metadata
//! we don't intercept (e.g. span enter/exit), not events.
//!
//! # Policy
//!
//! See [`DENY_LIST`]. The exact substitute depends on log level:
//!
//! - `INFO` / `WARN` / `ERROR`: literal `<redacted>` (no entropy leak).
//! - `DEBUG` / `TRACE`: 6-hex-char prefix + `…` (correlation, no full
//!   leak). Implemented by passing the raw string through
//!   [`common_secrets::ScrubbedString::from_bytes`].
//!
//! Empty / numeric / boolean values are never redacted (an `amount`
//! integer with no secrecy implication of its own is still flagged
//! because the deny-list is keyed by NAME, not type — the caller is
//! responsible for re-bucketing amounts into bins before logging at
//! INFO).

use std::fmt::Write as _;
use std::io::Write as _;

use common_secrets::ScrubbedString;
use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::layer::Context;
use tracing_subscriber::Layer;

/// Field names that MUST never be emitted at INFO+ without redaction.
///
/// Match is exact, case-sensitive, on the field key. Subspans of these
/// names (e.g. `recipient_b58`) are NOT auto-matched — the audit pass
/// explicitly catalogs every emit site, so adding an alias here is a
/// conscious act. Keep this in lockstep with `docs/shielded-pool/OPERATIONS.md` § 2.
// Only SECRET or sensitive-LINKABLE field names belong here. Public,
// on-chain-derivable protocol state (Merkle `root`, `asset_id`, `leaf_index`,
// `siblings`/`path_*`, `next_index`, `queue_depth`) is deliberately NOT listed —
// the forester/indexer log it for operability and it leaks no secret. See
// `docs/shielded-pool/LOGGING.md`.
pub const DENY_LIST: &[&str] = &[
    // recipients / note owners
    "recipient",
    "recipient_pubkey",
    "recipient_b58",
    "owner",
    "owner_pubkey",
    // amounts — clear-text amount is the dispositive deposit→withdrawal linkage
    "amount",
    "public_amount",
    "fee",
    "relayer_fee",
    // commitments / nullifiers (linkable; kept from original list)
    "commitment",
    "nullifier",
    // proofs
    "proof",
    "proof_a",
    "proof_b",
    "proof_c",
    // key material
    "spending_key",
    "sk",
    "private_key",
    "signing_key",
    "keypair",
    "key",
    "seed",
    "secret",
    "viewing_key",
    "ivk",
    "fvk",
    "nk",
    "ak",
    "eph_sk", // note: eph_PK is public (goes on-chain) — not listed
    "shared",
    "shared_secret",
    "okm",
    // notes / memos / witnesses / blinding
    "note",
    "memo",
    "note_memo",
    "witness",
    "blinding",
    // on-chain signatures
    "signature",
    "tx_signature",
    // prover artifacts (paths/buffers that transit the spending key)
    "input_json",
    "wtns",
];

/// Returns true iff `name` is on the workspace deny-list.
#[inline]
pub fn is_denied(name: &str) -> bool {
    DENY_LIST.contains(&name)
}

/// Redact a single value according to the current log level.
///
/// `INFO`/`WARN`/`ERROR` → `<redacted>`.
/// `DEBUG`/`TRACE`       → 6-hex-prefix + `…` (computed from the value's
/// UTF-8 bytes; if the value is already short enough to be a prefix it
/// passes through unmodified, since at TRACE the operator wants to see
/// it).
pub fn redact_value(level: &Level, value: &str) -> String {
    // `tracing::Level`'s PartialOrd is intentionally inverted relative
    // to severity intuition: TRACE > DEBUG > INFO > WARN > ERROR. So
    // "INFO and stricter (more severe)" is `level <= Level::INFO`.
    if *level <= Level::INFO {
        "<redacted>".to_string()
    } else {
        // DEBUG / TRACE: keep a deterministic prefix tag.
        let bytes = value.as_bytes();
        ScrubbedString::from_bytes(bytes).as_str().to_string()
    }
}

/// A `tracing_subscriber::Layer` that prints every event's fields
/// through the workspace redaction policy.
#[derive(Default)]
pub struct RedactionLayer;

impl RedactionLayer {
    /// Construct a layer with the workspace-default deny-list.
    pub fn new() -> Self {
        Self
    }
}

/// Internal visitor that captures field (name, value) pairs as strings.
struct CaptureVisitor {
    fields: Vec<(String, String)>,
    message: Option<String>,
}

impl CaptureVisitor {
    fn new() -> Self {
        Self {
            fields: Vec::new(),
            message: None,
        }
    }
}

impl Visit for CaptureVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        let rendered = format!("{value:?}");
        // Strip surrounding quotes Debug adds to string-like values so the
        // output reads cleanly: `field=value` not `field="value"`.
        let cleaned = trim_debug_quotes(&rendered);
        if field.name() == "message" {
            self.message = Some(cleaned.to_string());
        } else {
            self.fields
                .push((field.name().to_string(), cleaned.to_string()));
        }
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message = Some(value.to_string());
        } else {
            self.fields
                .push((field.name().to_string(), value.to_string()));
        }
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.fields
            .push((field.name().to_string(), value.to_string()));
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.fields
            .push((field.name().to_string(), value.to_string()));
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.fields
            .push((field.name().to_string(), value.to_string()));
    }

    fn record_f64(&mut self, field: &Field, value: f64) {
        self.fields
            .push((field.name().to_string(), value.to_string()));
    }
}

fn trim_debug_quotes(s: &str) -> &str {
    let bytes = s.as_bytes();
    if bytes.len() >= 2 && bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"' {
        &s[1..s.len() - 1]
    } else {
        s
    }
}

impl<S> Layer<S> for RedactionLayer
where
    S: Subscriber,
{
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let mut v = CaptureVisitor::new();
        event.record(&mut v);

        let meta = event.metadata();
        let level = meta.level();
        let target = meta.target();

        let mut line = String::new();
        let _ = write!(&mut line, "{level} {target}");
        if let Some(msg) = &v.message {
            let _ = write!(&mut line, " {msg}");
        }
        for (name, value) in &v.fields {
            let safe = if is_denied(name) {
                redact_value(level, value)
            } else {
                value.clone()
            };
            let _ = write!(&mut line, " {name}={safe}");
        }
        line.push('\n');

        // Best-effort write to stderr. We never panic on log failure.
        let _ = std::io::stderr().write_all(line.as_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deny_list_lookup() {
        assert!(is_denied("recipient"));
        assert!(is_denied("proof_a"));
        assert!(is_denied("signing_key"));
        // Newly-cataloged aliases / secret-bearing field names.
        assert!(is_denied("recipient_b58"));
        assert!(is_denied("public_amount"));
        assert!(is_denied("blinding"));
        assert!(is_denied("eph_sk"));
        assert!(is_denied("note_memo"));
        // Public, on-chain-derivable state is intentionally NOT redacted
        // (logged for operability).
        assert!(!is_denied("root"));
        assert!(!is_denied("leaf_index"));
        assert!(!is_denied("next_index"));
        assert!(!is_denied("eph_pk")); // ephemeral PUBLIC key
                                       // Still exact-match: a benign field that merely contains a denied
                                       // substring is NOT auto-matched (no false-positive redaction).
        assert!(!is_denied("queue_depth"));
        assert!(!is_denied("commitment_count")); // subspan of "commitment"
        assert!(!is_denied("amount_of_retries")); // subspan of "amount"
    }

    #[test]
    fn info_redacts_to_literal() {
        let r = redact_value(&Level::INFO, "deadbeef00112233445566778899aabbccddeeff");
        assert_eq!(r, "<redacted>");
    }

    #[test]
    fn warn_and_error_redact_to_literal() {
        assert_eq!(redact_value(&Level::WARN, "abc"), "<redacted>");
        assert_eq!(redact_value(&Level::ERROR, "abc"), "<redacted>");
    }

    #[test]
    fn debug_keeps_scrubbed_prefix() {
        // Six chars + ellipsis.
        let r = redact_value(&Level::DEBUG, "secretvalue");
        // The value's UTF-8 bytes are hex-encoded by ScrubbedString —
        // the prefix is the first 6 hex chars (3 bytes) of "secretvalue".
        // hex("sec") = "736563"
        assert_eq!(r, "736563…");
    }

    #[test]
    fn trace_keeps_scrubbed_prefix() {
        let r = redact_value(&Level::TRACE, "secretvalue");
        assert_eq!(r, "736563…");
    }

    #[test]
    fn trim_debug_quotes_strips_outer() {
        assert_eq!(trim_debug_quotes("\"hello\""), "hello");
        assert_eq!(trim_debug_quotes("hello"), "hello");
        assert_eq!(trim_debug_quotes("\""), "\"");
    }
}
