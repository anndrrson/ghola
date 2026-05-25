//! Fuzz target: prover `/prove` ingress — `TransferWitness` JSON parse.
//!
//! This target feeds arbitrary bytes into the deserializer that backs
//! the `POST /prove` HTTP endpoint
//! (`said_shielded_pool_prover::wire::witness_from_json`). The handler
//! sees a `serde_json::Value` first (axum's `Json` extractor) and then
//! re-parses through `witness_from_json` into a strongly-typed
//! `TransferWitness`. Both steps must reject malformed input gracefully
//! — no panics, no UB.
//!
//! Coverage focus:
//!   - Truncated / oversized hex arrays inside the witness.
//!   - Wrong-length `siblings` / `path_bits` vectors.
//!   - Negative `public_amount` near `i128::MIN`.
//!   - Non-UTF8 / non-JSON garbage (should fail at the first parse).

#![no_main]

use libfuzzer_sys::fuzz_target;
use said_shielded_pool_prover::wire::witness_from_json;

fuzz_target!(|data: &[u8]| {
    // Step 1: try parsing as JSON. Most inputs die here.
    let v: serde_json::Value = match serde_json::from_slice(data) {
        Ok(v) => v,
        Err(_) => return,
    };

    // Step 2: try the typed witness deserializer. This is the exact
    // function the `POST /prove` route calls. Errors are returned as
    // 400 BadRequest by the route; panics here would be a real bug.
    let _ = witness_from_json(v);
});
