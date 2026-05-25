//! In-process log capture for the prover-leak tests.
//!
//! Stream 7 (`common-log`) ships a redaction layer but no public
//! capture-and-assert harness; we ship one here so this crate doesn't
//! transitively depend on tracing-subscriber internals. The capture is
//! deliberately small — install a default subscriber that writes lines
//! into a `Vec<String>` we own, run the action, then scan the captured
//! lines for forbidden substrings.
//!
//! # Why a custom writer
//!
//! `tracing_subscriber::fmt::TestWriter` writes through `print!` which
//! `cargo test` captures, but the captured text is not accessible from
//! Rust. We need to assert ON the captured bytes, so we wire a
//! `MakeWriter` that pushes each formatter call into an `Arc<Mutex<Vec<u8>>>`.
//!
//! Used by `tests/malicious_prover.rs::leak_to_logs`.

use std::io::{self, Write};
use std::sync::{Arc, Mutex};

use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::EnvFilter;

/// Shared byte buffer behind a `tracing` subscriber. Cloneable so a
/// writer and an asserter can hold the same buffer.
#[derive(Clone, Default)]
pub struct CaptureBuf {
    inner: Arc<Mutex<Vec<u8>>>,
}

impl CaptureBuf {
    /// Empty buffer.
    pub fn new() -> Self {
        Self::default()
    }

    /// Snapshot of bytes written so far, decoded lossily as UTF-8.
    /// Lossy is fine — we're searching for ASCII-only forbidden
    /// substrings.
    pub fn snapshot(&self) -> String {
        let g = self.inner.lock().expect("capture buf poisoned");
        String::from_utf8_lossy(&g).to_string()
    }

    /// `true` iff `needle` appears anywhere in the captured output.
    pub fn contains(&self, needle: &str) -> bool {
        self.snapshot().contains(needle)
    }
}

/// Writer half of [`CaptureBuf`]. Public so it can appear in the
/// `MakeWriter::Writer` associated type without `private-in-public`
/// errors; not intended for direct construction.
pub struct Writer(Arc<Mutex<Vec<u8>>>);

impl Write for Writer {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut g = self.0.lock().expect("capture buf poisoned");
        g.extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<'a> MakeWriter<'a> for CaptureBuf {
    type Writer = Writer;
    fn make_writer(&'a self) -> Self::Writer {
        Writer(self.inner.clone())
    }
}

/// Install a default subscriber that writes into `buf` for the
/// remainder of the returned guard's lifetime. Reuses the same env
/// filter envelope (`RUST_LOG`) as production binaries.
///
/// Caller MUST hold the guard for the entire scope where they want
/// captured output; on drop the previous default is restored.
pub fn install(buf: CaptureBuf) -> tracing::subscriber::DefaultGuard {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("trace"));
    let subscriber = tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::fmt::layer().with_writer(buf).without_time());
    tracing::subscriber::set_default(subscriber)
}
