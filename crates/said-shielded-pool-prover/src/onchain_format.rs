//! Converters from snarkjs JSON proof/vkey/public output to the
//! `groth16-solana` (Lightprotocol) on-chain wire format.
//!
//! Wire format summary (matches `tests/groth16_solana_verify.rs` and
//! `examples/gen_vk_rs.rs`):
//!
//!   * Field elements are 32-byte BIG-ENDIAN.
//!   * G1 points are 64 bytes: `x_be(32) || y_be(32)`.
//!   * G2 points are 128 bytes with `c1 || c0` ordering inside each
//!     Fp2 coordinate: `x1(32) || x0(32) || y1(32) || y0(32)`.
//!   * The proof's G1 `A` point MUST be negated (`y → q - y`) so that
//!     the on-chain pairing check `e(-A,B) · e(α,β) · e(L,γ) · e(C,δ) == 1`
//!     reduces to a single fixed-sign `alt_bn128_pairing` call.
//!
//! All helpers are pure-Rust and depend only on `ark-bn254` / `ark-ff`
//! / `num-bigint`; no syscall or external process is involved.

use ark_bn254::{Fq, Fq2, G1Affine, G2Affine};
use ark_ec::AffineRepr;
use ark_ff::{BigInteger, PrimeField};
use num_bigint::BigUint;
use serde_json::Value;

/// Parse a snarkjs decimal-string field element as a BN254 base-field
/// element (`Fq`).
pub fn parse_fq(s: &str) -> Fq {
    let n: BigUint = s.parse().expect("bad decimal in field element");
    Fq::from_be_bytes_mod_order(&n.to_bytes_be())
}

/// Serialize a base-field element to BIG-ENDIAN 32 bytes.
pub fn fq_to_be32(x: &Fq) -> [u8; 32] {
    let bi = x.into_bigint();
    let bytes = bi.to_bytes_be();
    let mut out = [0u8; 32];
    out[32 - bytes.len()..].copy_from_slice(&bytes);
    out
}

/// G1Affine → 64-byte uncompressed `[x_BE32 || y_BE32]`.
pub fn g1_to_be64(p: &G1Affine) -> [u8; 64] {
    let mut out = [0u8; 64];
    let (x, y) = p.xy().expect("G1 at infinity");
    out[..32].copy_from_slice(&fq_to_be32(&x));
    out[32..].copy_from_slice(&fq_to_be32(&y));
    out
}

/// G2Affine → 128-byte uncompressed with c1||c0 ordering inside each Fp2.
/// snarkjs stores Fq2 as (c0, c1) in JSON arrays. groth16-solana expects
/// the on-chain alt_bn128 convention: each Fq2 coord is (c1, c0).
pub fn g2_to_be128(p: &G2Affine) -> [u8; 128] {
    let mut out = [0u8; 128];
    let (x, y) = p.xy().expect("G2 at infinity");
    out[..32].copy_from_slice(&fq_to_be32(&x.c1));
    out[32..64].copy_from_slice(&fq_to_be32(&x.c0));
    out[64..96].copy_from_slice(&fq_to_be32(&y.c1));
    out[96..128].copy_from_slice(&fq_to_be32(&y.c0));
    out
}

/// Parse a snarkjs G1 (`[x, y, z]` with `z == "1"`) into `G1Affine`.
pub fn parse_g1(arr: &Value) -> G1Affine {
    let x = parse_fq(arr[0].as_str().expect("g1.x is string"));
    let y = parse_fq(arr[1].as_str().expect("g1.y is string"));
    G1Affine::new(x, y)
}

/// Parse a snarkjs G2 (`[[x0, x1], [y0, y1], [1, 0]]`) into `G2Affine`.
pub fn parse_g2(arr: &Value) -> G2Affine {
    let x = Fq2::new(
        parse_fq(arr[0][0].as_str().expect("g2.x0")),
        parse_fq(arr[0][1].as_str().expect("g2.x1")),
    );
    let y = Fq2::new(
        parse_fq(arr[1][0].as_str().expect("g2.y0")),
        parse_fq(arr[1][1].as_str().expect("g2.y1")),
    );
    G2Affine::new(x, y)
}

/// Parse a snarkjs decimal public-input string to a 32-byte BE field.
pub fn parse_public_be32(s: &str) -> [u8; 32] {
    let n: BigUint = s.parse().expect("bad decimal public");
    let bytes = n.to_bytes_be();
    let mut out = [0u8; 32];
    out[32 - bytes.len()..].copy_from_slice(&bytes);
    out
}

/// One on-chain ready proof, all coordinates BE-32.
#[derive(Debug, Clone)]
pub struct OnchainProof {
    /// `(-A).x_be || (-A).y_be` (G1 negated)
    pub proof_a: [u8; 64],
    /// `B.x1_be || B.x0_be || B.y1_be || B.y0_be`
    pub proof_b: [u8; 128],
    /// `C.x_be || C.y_be`
    pub proof_c: [u8; 64],
    /// One 32-byte BE field per snarkjs public signal.
    pub public_inputs: Vec<[u8; 32]>,
}

/// Build an [`OnchainProof`] from snarkjs `proof.json` + `public.json`.
pub fn build_onchain_proof(proof_json: &Value, public_json: &Value) -> OnchainProof {
    // `A` is negated for groth16-solana's single-pairing-product check.
    let a_pos = parse_g1(&proof_json["pi_a"]);
    let a_neg = -a_pos;
    let proof_a = g1_to_be64(&a_neg);
    let proof_b = g2_to_be128(&parse_g2(&proof_json["pi_b"]));
    let proof_c = g1_to_be64(&parse_g1(&proof_json["pi_c"]));

    let public_inputs: Vec<[u8; 32]> = public_json
        .as_array()
        .expect("public.json must be an array")
        .iter()
        .map(|v| parse_public_be32(v.as_str().expect("public[i] is string")))
        .collect();

    OnchainProof {
        proof_a,
        proof_b,
        proof_c,
        public_inputs,
    }
}

/// Render an [`OnchainProof`] as JSON with hex-encoded byte fields. This
/// is the shape `tests/e2e_devnet.ts` consumes via
/// `Buffer.from(<hex>, "hex")`.
pub fn onchain_proof_to_json(p: &OnchainProof) -> Value {
    serde_json::json!({
        "proof_a": format!("0x{}", hex::encode(p.proof_a)),
        "proof_b": format!("0x{}", hex::encode(p.proof_b)),
        "proof_c": format!("0x{}", hex::encode(p.proof_c)),
        "public_inputs": p.public_inputs
            .iter()
            .map(|x| format!("0x{}", hex::encode(x)))
            .collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_fq_decimal() {
        let one = parse_fq("1");
        let mut want = [0u8; 32];
        want[31] = 1;
        assert_eq!(fq_to_be32(&one), want);
    }
}
