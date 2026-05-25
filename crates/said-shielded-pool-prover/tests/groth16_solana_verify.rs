//! End-to-end cryptographic verification:
//!   snarkjs-emitted proof + vkey + public signals
//!     → converted to groth16-solana's encoding (BE-32, G2 c1||c0, A negated)
//!     → `Groth16Verifier::verify()` returns Ok(true)
//!
//! This is the milestone test that proves the Ghola circuit + ceremony + prover
//! stack agrees byte-for-byte with what the on-chain Solana verifier expects.
//!
//! Inputs are the artifacts produced by the deposit PoC:
//!   crates/said-shielded-pool-circuits/artifacts/verification_key.json
//!   crates/said-shielded-pool-circuits/artifacts/proof_deposit.json
//!   crates/said-shielded-pool-circuits/artifacts/public_deposit.json

use ark_bn254::{Fq, Fq2, G1Affine, G2Affine};
use ark_ec::AffineRepr;
use ark_ff::{BigInteger, PrimeField};
use ark_serialize::CanonicalSerialize;
use groth16_solana::groth16::{Groth16Verifier, Groth16Verifyingkey};
use num_bigint::BigUint;
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

fn artifacts_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../said-shielded-pool-circuits/artifacts")
}

/// Parse a decimal string as a BN254 base-field element.
fn parse_fq(s: &str) -> Fq {
    let n: BigUint = s.parse().expect("bad decimal");
    Fq::from_be_bytes_mod_order(&n.to_bytes_be())
}

/// Serialize a base-field element to BE 32 bytes.
fn fq_to_be32(x: &Fq) -> [u8; 32] {
    let bi = x.into_bigint();
    let bytes = bi.to_bytes_be();
    let mut out = [0u8; 32];
    out[32 - bytes.len()..].copy_from_slice(&bytes);
    out
}

/// G1Affine → 64-byte uncompressed [x_BE32 || y_BE32].
fn g1_to_be64(p: &G1Affine) -> [u8; 64] {
    let mut out = [0u8; 64];
    let (x, y) = p.xy().expect("infinity");
    out[..32].copy_from_slice(&fq_to_be32(&x));
    out[32..].copy_from_slice(&fq_to_be32(&y));
    out
}

/// G2Affine → 128-byte uncompressed.
/// snarkjs stores Fq2 as (c0, c1) in JSON arrays. groth16-solana expects
/// the on-chain alt_bn128 convention: each Fq2 coord is (c1, c0).
fn g2_to_be128(p: &G2Affine) -> [u8; 128] {
    let mut out = [0u8; 128];
    let (x, y) = p.xy().expect("infinity");
    out[..32].copy_from_slice(&fq_to_be32(&x.c1));
    out[32..64].copy_from_slice(&fq_to_be32(&x.c0));
    out[64..96].copy_from_slice(&fq_to_be32(&y.c1));
    out[96..128].copy_from_slice(&fq_to_be32(&y.c0));
    out
}

/// Parse a snarkjs G1 ("[x, y, z]" with z=="1") → G1Affine.
fn parse_g1(arr: &Value) -> G1Affine {
    let x = parse_fq(arr[0].as_str().unwrap());
    let y = parse_fq(arr[1].as_str().unwrap());
    G1Affine::new(x, y)
}

/// Parse a snarkjs G2 ("[[x0,x1],[y0,y1],[1,0]]") → G2Affine.
fn parse_g2(arr: &Value) -> G2Affine {
    let x = Fq2::new(
        parse_fq(arr[0][0].as_str().unwrap()),
        parse_fq(arr[0][1].as_str().unwrap()),
    );
    let y = Fq2::new(
        parse_fq(arr[1][0].as_str().unwrap()),
        parse_fq(arr[1][1].as_str().unwrap()),
    );
    G2Affine::new(x, y)
}

#[test]
fn snarkjs_proof_verifies_under_groth16_solana() {
    let dir = artifacts_dir();
    let vk_json: Value =
        serde_json::from_str(&fs::read_to_string(dir.join("verification_key.json")).unwrap())
            .unwrap();
    let proof_json: Value =
        serde_json::from_str(&fs::read_to_string(dir.join("proof_deposit.json")).unwrap())
            .unwrap();
    let public_json: Value =
        serde_json::from_str(&fs::read_to_string(dir.join("public_deposit.json")).unwrap())
            .unwrap();

    // ---------- Verifying key ----------
    let alpha = parse_g1(&vk_json["vk_alpha_1"]);
    let beta = parse_g2(&vk_json["vk_beta_2"]);
    let gamma = parse_g2(&vk_json["vk_gamma_2"]);
    let delta = parse_g2(&vk_json["vk_delta_2"]);

    let ic_json = vk_json["IC"].as_array().unwrap();
    let n_pub = ic_json.len() - 1;
    assert_eq!(n_pub, 8, "expected 8 public inputs");

    let vk_ic: Vec<[u8; 64]> = ic_json.iter().map(|g| g1_to_be64(&parse_g1(g))).collect();

    let vk_alpha = g1_to_be64(&alpha);
    let vk_beta = g2_to_be128(&beta);
    let vk_gamma = g2_to_be128(&gamma);
    let vk_delta = g2_to_be128(&delta);

    // groth16-solana's struct uses references; we leak the boxed slice so the
    // borrow lives for the test scope.
    let vk_ic_static: &'static [[u8; 64]] = Box::leak(vk_ic.into_boxed_slice());
    let vk = Groth16Verifyingkey {
        nr_pubinputs: n_pub,
        vk_alpha_g1: vk_alpha,
        vk_beta_g2: vk_beta,
        vk_gamme_g2: vk_gamma, // note: upstream crate has the field misspelled
        vk_delta_g2: vk_delta,
        vk_ic: vk_ic_static,
    };

    // ---------- Proof ----------
    let a_pos = parse_g1(&proof_json["pi_a"]);
    // groth16-solana convention: A must be NEGATED so the pairing check
    // reduces to e(-A,B) * e(α,β) * e(L,γ) * e(C,δ) == 1.
    let a_neg = -a_pos;
    let proof_a = g1_to_be64(&a_neg);
    let proof_b = g2_to_be128(&parse_g2(&proof_json["pi_b"]));
    let proof_c = g1_to_be64(&parse_g1(&proof_json["pi_c"]));

    // ---------- Public inputs ----------
    let pubs: Vec<[u8; 32]> = public_json
        .as_array()
        .unwrap()
        .iter()
        .map(|v| {
            let n: BigUint = v.as_str().unwrap().parse().unwrap();
            let bytes = n.to_bytes_be();
            let mut out = [0u8; 32];
            out[32 - bytes.len()..].copy_from_slice(&bytes);
            out
        })
        .collect();
    assert_eq!(pubs.len(), 8);
    let pubs_arr: [[u8; 32]; 8] = pubs.try_into().unwrap();

    // ---------- Verify ----------
    let mut verifier =
        Groth16Verifier::new(&proof_a, &proof_b, &proof_c, &pubs_arr, &vk).expect("verifier ctor");

    verifier
        .verify()
        .expect("groth16-solana rejected a snarkjs-produced proof");

    println!("✓ groth16-solana accepted the snarkjs proof end-to-end");
}
