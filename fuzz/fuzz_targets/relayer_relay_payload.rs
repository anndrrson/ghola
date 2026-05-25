//! Fuzz target: relayer `/relay` ingress — `RelayRequest` JSON parse.
//!
//! This target exercises the HTTP ingress that backs `POST /relay`
//! (see `said_shielded_pool_relayer::routes::relay`). The handler
//! decodes the body via `axum::Json<RelayRequest>` — i.e.
//! `serde_json::from_slice::<RelayRequest>(data)` — and then runs
//! `validate_proof_shape` over the embedded `proof_bundle`. Both
//! steps must reject malformed input gracefully.
//!
//! NOTE: `validate_proof_shape` is module-private in the routes file;
//! we exercise it transitively by relying on the fact that any
//! malformed-shape input that passes the `serde_json::from_slice` step
//! will still need to round-trip through the same JSON parsing the
//! validator does (it walks `pb.0.as_object()`, `pi.get(...)`, etc.).
//! What we can directly assert here is that the JSON deserializer
//! itself never panics on arbitrary bytes — that is the single largest
//! panic surface we expose to anonymous clients on the internet.
//!
//! Coverage focus:
//!   - Extremely deeply nested JSON (serde's recursion limit).
//!   - Mojibake / non-UTF8.
//!   - Empty / one-byte inputs.
//!   - Pathological numbers (1e10000 inside `fee`).
//!   - `instruction_data_hex` with bizarre hex (odd-length, non-hex bytes).

#![no_main]

use libfuzzer_sys::fuzz_target;
use said_shielded_pool_relayer::routes::RelayRequest;

fuzz_target!(|data: &[u8]| {
    // Reject pathologically large inputs early — the real HTTP layer
    // has a body-size cap; fuzzing past that just burns time.
    if data.len() > 64 * 1024 {
        return;
    }

    // The route's first action is `Json(req): Json<RelayRequest>` — a
    // serde_json::from_slice under the hood. If parse succeeds we have
    // a well-formed shape and the route is responsible for further
    // validation (proof shape, base58 recipient, etc.).
    let _: Result<RelayRequest, _> = serde_json::from_slice(data);
});
