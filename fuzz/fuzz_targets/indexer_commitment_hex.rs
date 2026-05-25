//! Fuzz target: indexer `/witness?commitment=…` query parser.
//!
//! Exercises the commitment-hex-decode logic that backs the
//! `GET /witness?commitment=<HEX>` endpoint in
//! `said_shielded_pool_indexer::routes::witness`:
//!
//!   1. UTF-8 decode of the query value (axum's `Query` does this).
//!   2. `trim_start_matches("0x")`.
//!   3. `hex::decode(...)`.
//!   4. Length check: must be exactly `FIELD_BYTES` (32) bytes.
//!
//! Must reject malformed input with a typed error — NEVER panic. The
//! commitment-hex parser is the most exposed surface on the indexer:
//! it's a `GET` endpoint behind no auth, fed by arbitrary HTTP clients.

#![no_main]

use libfuzzer_sys::fuzz_target;
use said_shielded_pool_types::FIELD_BYTES;

fuzz_target!(|data: &[u8]| {
    // Step 1: UTF-8 decode. axum's Query extractor will have done
    // percent-decoding already; non-UTF8 just becomes a 400.
    let s = match std::str::from_utf8(data) {
        Ok(s) => s,
        Err(_) => return,
    };

    // Step 2 + 3 + 4: mirror the parser in indexer::routes::witness.
    // This is the EXACT sequence executed there, copied so we don't
    // need to expose an internal helper.
    let stripped = s.trim_start_matches("0x");
    let bytes = match hex::decode(stripped) {
        Ok(b) => b,
        Err(_) => return,
    };
    if bytes.len() != FIELD_BYTES {
        return;
    }
    // If we got here, the parser produced a canonical 32-byte
    // commitment. No further work — the next step in the handler is
    // an on-disk sled lookup, which is exercised by integration tests
    // (not this fuzzer).
    let mut c = [0u8; FIELD_BYTES];
    c.copy_from_slice(&bytes);
    // Mark used so the optimizer can't fold this away.
    std::hint::black_box(c);
});
