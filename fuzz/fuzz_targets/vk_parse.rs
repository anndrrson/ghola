//! Fuzz target: snarkjs verification-key JSON → on-chain bytes converter.
//!
//! Refactored from `crates/said-shielded-pool-prover/examples/gen_vk_rs.rs`,
//! the script that converts snarkjs's `verification_key.json` into the
//! on-chain `Groth16Verifyingkey` byte arrays. The original example
//! liberally uses `.unwrap()` and `.expect()` (it's a build-time tool),
//! so this target is intentionally a HARDENED REWRITE that returns
//! `Option`/`Result` everywhere and runs the original's logic without
//! ever panicking.
//!
//! Coverage focus:
//!   - Missing top-level keys (`vk_alpha_1`, `vk_beta_2`, `IC`).
//!   - Non-decimal `BigUint` strings inside G1/G2 coordinates.
//!   - Points NOT on the curve (`G1Affine::new` rejects → we catch).
//!   - Empty / one-element `IC` arrays.
//!   - Arbitrary deep JSON nesting.

#![no_main]

use ark_bn254::{Fq, Fq2, G1Affine, G2Affine};
use ark_ec::AffineRepr;
use ark_ff::{BigInteger, PrimeField};
use libfuzzer_sys::fuzz_target;
use num_bigint::BigUint;
use serde_json::Value;

fn parse_fq(s: &str) -> Option<Fq> {
    let n: BigUint = s.parse().ok()?;
    Some(Fq::from_be_bytes_mod_order(&n.to_bytes_be()))
}

fn fq_to_be32(x: &Fq) -> [u8; 32] {
    let bi = x.into_bigint();
    let bytes = bi.to_bytes_be();
    let mut out = [0u8; 32];
    out[32 - bytes.len()..].copy_from_slice(&bytes);
    out
}

fn parse_g1(arr: &Value) -> Option<G1Affine> {
    let x = parse_fq(arr.get(0)?.as_str()?)?;
    let y = parse_fq(arr.get(1)?.as_str()?)?;
    // Note: G1Affine::new ASSERTS the point is on the curve and will
    // panic in debug builds via `assert!`. We use the unchecked
    // constructor and then explicitly check on-curve to avoid that.
    let p = G1Affine::new_unchecked(x, y);
    if !p.is_on_curve() {
        return None;
    }
    Some(p)
}

fn parse_g2(arr: &Value) -> Option<G2Affine> {
    let x0 = parse_fq(arr.get(0)?.get(0)?.as_str()?)?;
    let x1 = parse_fq(arr.get(0)?.get(1)?.as_str()?)?;
    let y0 = parse_fq(arr.get(1)?.get(0)?.as_str()?)?;
    let y1 = parse_fq(arr.get(1)?.get(1)?.as_str()?)?;
    let x = Fq2::new(x0, x1);
    let y = Fq2::new(y0, y1);
    let p = G2Affine::new_unchecked(x, y);
    if !p.is_on_curve() {
        return None;
    }
    Some(p)
}

fn g1_to_be64(p: &G1Affine) -> Option<[u8; 64]> {
    let (x, y) = p.xy()?;
    let mut out = [0u8; 64];
    out[..32].copy_from_slice(&fq_to_be32(&x));
    out[32..].copy_from_slice(&fq_to_be32(&y));
    Some(out)
}

fn g2_to_be128(p: &G2Affine) -> Option<[u8; 128]> {
    let (x, y) = p.xy()?;
    let mut out = [0u8; 128];
    out[..32].copy_from_slice(&fq_to_be32(&x.c1));
    out[32..64].copy_from_slice(&fq_to_be32(&x.c0));
    out[64..96].copy_from_slice(&fq_to_be32(&y.c1));
    out[96..128].copy_from_slice(&fq_to_be32(&y.c0));
    Some(out)
}

/// Run the full snarkjs vk → on-chain bytes conversion. Returns
/// `Some(...)` only on a fully-valid vk; otherwise `None`. Never
/// panics on arbitrary input.
fn parse_vk(json: &Value) -> Option<()> {
    let alpha = g1_to_be64(&parse_g1(json.get("vk_alpha_1")?)?)?;
    let beta = g2_to_be128(&parse_g2(json.get("vk_beta_2")?)?)?;
    let gamma = g2_to_be128(&parse_g2(json.get("vk_gamma_2")?)?)?;
    let delta = g2_to_be128(&parse_g2(json.get("vk_delta_2")?)?)?;

    let ic_json = json.get("IC")?.as_array()?;
    // Cap IC length to keep fuzz runs bounded — a real vk has
    // n_pub + 1 elements, at most ~10 for our circuits.
    if ic_json.len() > 64 {
        return None;
    }
    let mut ic = Vec::with_capacity(ic_json.len());
    for g in ic_json {
        ic.push(g1_to_be64(&parse_g1(g)?)?);
    }

    std::hint::black_box(alpha);
    std::hint::black_box(beta);
    std::hint::black_box(gamma);
    std::hint::black_box(delta);
    std::hint::black_box(ic);
    Some(())
}

fuzz_target!(|data: &[u8]| {
    if data.len() > 256 * 1024 {
        return;
    }
    let v: Value = match serde_json::from_slice(data) {
        Ok(v) => v,
        Err(_) => return,
    };
    let _ = parse_vk(&v);
});
