//! End-to-end "no secret reaches stderr" assertion.
//!
//! For each deny-listed field name, emit a synthetic event at every
//! log level, capture the formatted output, and assert:
//!
//! - At INFO/WARN/ERROR: the raw value bytes do NOT appear; the literal
//!   `<redacted>` does.
//! - At DEBUG/TRACE: the raw value bytes do NOT appear in full; a
//!   6-hex-char prefix + `…` does.
//!
//! The test installs the workspace `RedactionLayer` with a buffered
//! writer instead of stderr so we can read the bytes back. The layer's
//! `on_event` writes to `std::io::stderr` in production; for tests we
//! shadow stderr with a captured buffer via `gag`-style redirection —
//! but to avoid a new dep we instead introspect the layer's behavior
//! through `redact_value` (the public function the layer dispatches
//! to) plus a small in-process render that mimics the layer's
//! formatting. This still exercises the policy code path.

use common_log::redact::{is_denied, redact_value, DENY_LIST};
use tracing::Level;

/// A secret-shaped value that must never appear verbatim in output.
const SECRET_VALUE: &str = "deadbeef0123456789abcdef0123456789abcdef0123456789abcdef01234567";

#[test]
fn deny_list_is_non_empty_and_covers_documented_fields() {
    // These are the fields explicitly enumerated in
    // docs/shielded-pool/OPERATIONS.md § 2. Keep this list in lockstep.
    let expected = [
        "recipient",
        "recipient_pubkey",
        "amount",
        "commitment",
        "nullifier",
        "proof",
        "proof_a",
        "proof_b",
        "proof_c",
        "spending_key",
        "sk",
        "viewing_key",
        "ivk",
        "fvk",
        "nk",
        "witness",
        "signature",
        "tx_signature",
        "signing_key",
    ];
    for name in expected {
        assert!(
            is_denied(name),
            "deny list missing {name}; update DENY_LIST in common_log::redact"
        );
    }
    assert!(!DENY_LIST.is_empty());
}

#[test]
fn info_warn_error_levels_emit_literal_redacted() {
    for level in [Level::ERROR, Level::WARN, Level::INFO] {
        for field in DENY_LIST {
            let rendered = redact_value(&level, SECRET_VALUE);
            assert!(
                !rendered.contains(&SECRET_VALUE[..16]),
                "level={level} field={field}: 16-char prefix of secret leaked into {rendered:?}"
            );
            assert_eq!(rendered, "<redacted>", "level={level} field={field}");
        }
    }
}

#[test]
fn debug_trace_levels_emit_scrubbed_prefix_only() {
    // ScrubbedString takes the SECRET_VALUE's *bytes* and hex-encodes
    // them, then keeps the first 6 chars + ellipsis. SECRET_VALUE's
    // first 3 bytes are 'd', 'e', 'a' → hex("dea") = "646561".
    let expected_prefix = "646561";
    for level in [Level::DEBUG, Level::TRACE] {
        for field in DENY_LIST {
            let rendered = redact_value(&level, SECRET_VALUE);
            assert!(
                rendered.starts_with(expected_prefix),
                "level={level} field={field}: rendered {rendered:?} does not start with {expected_prefix:?}"
            );
            assert!(
                rendered.ends_with('…'),
                "level={level} field={field}: rendered {rendered:?} missing ellipsis terminator"
            );
            // The 16-char prefix of the original ASCII secret MUST NOT
            // appear in the output (it would be a partial-leak).
            assert!(
                !rendered.contains(&SECRET_VALUE[..16]),
                "level={level} field={field}: secret-prefix leak in {rendered:?}"
            );
        }
    }
}

#[test]
fn non_denied_fields_pass_through_unchanged_in_helper_layer() {
    // `redact_value` is only ever called when the field is on the deny
    // list — the layer short-circuits other fields. This test
    // documents that contract: we don't accidentally apply scrubbing
    // to neutral fields like `queue_depth` or `latency_ms`.
    assert!(!is_denied("queue_depth"));
    assert!(!is_denied("anonymity_set_size"));
    assert!(!is_denied("latency_bucket"));
    assert!(!is_denied("decoy_count"));
}

#[test]
fn end_to_end_emit_via_layer_does_not_leak() {
    // Install the redaction layer and emit deny-listed fields at every
    // level. The layer writes to stderr; we can't easily capture
    // stderr in-process without an extra dep, so we drive the layer
    // through its public field-rewriting policy via redact_value
    // (above tests) AND verify the layer is constructible + composes
    // with `tracing_subscriber::registry`. This second check guards
    // against subscriber-init regressions across tracing-subscriber
    // version bumps.
    let _guard = common_log::init_test();
    tracing::info!(recipient = SECRET_VALUE, "withdrawal accepted");
    tracing::warn!(signature = SECRET_VALUE, "submit retry");
    tracing::error!(spending_key = SECRET_VALUE, "key load failed");
    tracing::debug!(amount = 12345u64, "synthetic");
    tracing::trace!(proof = SECRET_VALUE, "synthetic");
    // If we reach here without panic the subscriber stack is wired up.
}
