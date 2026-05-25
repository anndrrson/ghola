//! Privacy-aware logging shim for the Ghola shielded pool.
//!
//! Every off-chain crate that touches a spending key, viewing key,
//! recipient, amount, proof bundle, or transaction signature SHOULD
//! initialize its tracing subscriber via [`init`] (or [`init_test`] in
//! tests). The subscriber installs a redaction [`Layer`] that intercepts
//! every `tracing::Event` and rewrites field VALUES whose KEY is on the
//! workspace deny-list (see [`redact::DENY_LIST`]) before they reach the
//! formatting layer:
//!
//! - At `INFO` / `WARN` / `ERROR`, the value is replaced wholesale with
//!   the literal string `<redacted>`. Production fleets MUST default
//!   `RUST_LOG=info`; this is the audited public-safe surface.
//! - At `DEBUG` / `TRACE`, the value is replaced with a [`ScrubbedString`]
//!   (first six hex chars + horizontal ellipsis). This preserves enough
//!   entropy to disambiguate inside a single operator session for
//!   debugging without ever emitting the full secret. `DEBUG` MUST NOT
//!   be enabled in production by default — it is gated by `RUST_LOG`.
//!
//! Callers should ALSO prefer wrapping sensitive values at the call
//! site using [`fields::scrub_pubkey`] / [`fields::scrub_hex`] / the
//! [`redacted!`] macro. The redaction layer is a defense-in-depth net,
//! NOT a substitute for thinking about each log line.
//!
//! # Cross-references
//!
//! - `docs/shielded-pool/OPERATIONS.md` § 2 — privacy policy + deny-list rationale
//! - `crates/common-secrets/src/scrubbed.rs` — [`ScrubbedString`] format
//! - `clippy.toml` — bans `println!` / `dbg!` so this is the only path

#![forbid(unsafe_code)]
#![deny(missing_docs)]

pub mod fields;
pub mod redact;

// Re-export `tracing` so downstream callers can `use common_log::info;`
// without an explicit `tracing` dependency. Keeps the migration mechanical.
pub use tracing;

// Re-export the redacted-string newtype so callers don't need to import
// common-secrets just to construct a tag.
pub use common_secrets::ScrubbedString;

pub use fields::{scrub_hex, scrub_pubkey, scrub_str};

use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

/// Initialize the workspace-standard tracing subscriber.
///
/// Reads `RUST_LOG`; defaults to `info` if unset. Installs the
/// redaction layer so any deny-listed field is scrubbed before it
/// reaches the formatter, regardless of how the call site wrote it.
///
/// Idempotent only within a single process — calling twice will
/// (correctly) fail with a `set_global_default` error. Each binary
/// should call this exactly once at startup.
pub fn init() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::registry()
        .with(filter)
        .with(redact::RedactionLayer::new())
        .with(tracing_subscriber::fmt::layer())
        .try_init()?;
    Ok(())
}

/// Initialize a test-friendly subscriber that writes through
/// `tracing_subscriber::fmt::TestWriter` (so `cargo test` captures
/// output) and installs the same redaction layer.
///
/// Tests asserting that secrets are NOT logged should use this entry
/// point so the harness exercises the production redaction path.
pub fn init_test() -> tracing::subscriber::DefaultGuard {
    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("debug"));
    let subscriber = tracing_subscriber::registry()
        .with(filter)
        .with(redact::RedactionLayer::new())
        .with(
            tracing_subscriber::fmt::layer()
                .with_test_writer()
                .without_time(),
        );
    tracing::subscriber::set_default(subscriber)
}
