//! End-to-end cryptographic verification for the FORESTER
//! (batched commitment-insertion) circuit:
//!
//!   snarkjs-emitted proof + forester vkey + public signals
//!     → converted to groth16-solana's encoding (BE-32, G2 c1||c0, A negated)
//!     → `Groth16Verifier::verify()` returns Ok(true)
//!
//! Fixture inputs come from the deterministic empty-tree scenario produced
//! by `circuits/tools/gen_forester_input.js` — inserting four zero
//! commitments into an empty depth-26 tree at slots 0..3, which by
//! construction leaves the root unchanged. The fact that snarkjs accepts
//! the proof for `new_root == old_root == Z[26]` proves the circuit
//! correctly recognizes "insert zero into empty slot" as the identity.
//!
//! Required artifacts (produced by the ceremony in
//! `crates/said-shielded-pool-circuits/ceremony/`):
//!   crates/said-shielded-pool-circuits/artifacts/forester_verification_key.json
//!   crates/said-shielded-pool-circuits/artifacts/proof_forester.json
//!   crates/said-shielded-pool-circuits/artifacts/public_forester.json

use ark_bn254::{Fq, Fq2, G1Affine, G2Affine};
use ark_ec::AffineRepr;
use ark_ff::{BigInteger, PrimeField};
use groth16_solana::groth16::{Groth16Verifier, Groth16Verifyingkey};
use num_bigint::BigUint;
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

fn artifacts_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../said-shielded-pool-circuits/artifacts")
}

fn parse_fq(s: &str) -> Fq {
    let n: BigUint = s.parse().expect("bad decimal");
    Fq::from_be_bytes_mod_order(&n.to_bytes_be())
}

fn fq_to_be32(x: &Fq) -> [u8; 32] {
    let bi = x.into_bigint();
    let bytes = bi.to_bytes_be();
    let mut out = [0u8; 32];
    out[32 - bytes.len()..].copy_from_slice(&bytes);
    out
}

fn g1_to_be64(p: &G1Affine) -> [u8; 64] {
    let mut out = [0u8; 64];
    let (x, y) = p.xy().expect("infinity");
    out[..32].copy_from_slice(&fq_to_be32(&x));
    out[32..].copy_from_slice(&fq_to_be32(&y));
    out
}

/// snarkjs stores Fq2 as `(c0, c1)`; groth16-solana / the on-chain
/// alt_bn128 convention is `(c1, c0)` for each Fq2 coord.
fn g2_to_be128(p: &G2Affine) -> [u8; 128] {
    let mut out = [0u8; 128];
    let (x, y) = p.xy().expect("infinity");
    out[..32].copy_from_slice(&fq_to_be32(&x.c1));
    out[32..64].copy_from_slice(&fq_to_be32(&x.c0));
    out[64..96].copy_from_slice(&fq_to_be32(&y.c1));
    out[96..128].copy_from_slice(&fq_to_be32(&y.c0));
    out
}

fn parse_g1(arr: &Value) -> G1Affine {
    let x = parse_fq(arr[0].as_str().unwrap());
    let y = parse_fq(arr[1].as_str().unwrap());
    G1Affine::new(x, y)
}

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
fn forester_snarkjs_proof_verifies_under_groth16_solana() {
    let dir = artifacts_dir();
    let vk_json: Value = serde_json::from_str(
        &fs::read_to_string(dir.join("forester_verification_key.json")).unwrap(),
    )
    .unwrap();
    let proof_json: Value =
        serde_json::from_str(&fs::read_to_string(dir.join("proof_forester.json")).unwrap())
            .unwrap();
    let public_json: Value =
        serde_json::from_str(&fs::read_to_string(dir.join("public_forester.json")).unwrap())
            .unwrap();

    // ---------- Verifying key ----------
    let alpha = parse_g1(&vk_json["vk_alpha_1"]);
    let beta = parse_g2(&vk_json["vk_beta_2"]);
    let gamma = parse_g2(&vk_json["vk_gamma_2"]);
    let delta = parse_g2(&vk_json["vk_delta_2"]);

    let ic_json = vk_json["IC"].as_array().unwrap();
    let n_pub = ic_json.len() - 1;
    assert_eq!(
        n_pub, 8,
        "forester circuit declares 8 public inputs (7 real + 1 pad)"
    );

    let vk_ic: Vec<[u8; 64]> = ic_json.iter().map(|g| g1_to_be64(&parse_g1(g))).collect();

    let vk_alpha = g1_to_be64(&alpha);
    let vk_beta = g2_to_be128(&beta);
    let vk_gamma = g2_to_be128(&gamma);
    let vk_delta = g2_to_be128(&delta);

    let vk_ic_static: &'static [[u8; 64]] = Box::leak(vk_ic.into_boxed_slice());
    let vk = Groth16Verifyingkey {
        nr_pubinputs: n_pub,
        vk_alpha_g1: vk_alpha,
        vk_beta_g2: vk_beta,
        // upstream crate field name typo preserved
        vk_gamme_g2: vk_gamma,
        vk_delta_g2: vk_delta,
        vk_ic: vk_ic_static,
    };

    // ---------- Proof ----------
    let a_pos = parse_g1(&proof_json["pi_a"]);
    let a_neg = -a_pos;
    let proof_a = g1_to_be64(&a_neg);
    let proof_b = g2_to_be128(&parse_g2(&proof_json["pi_b"]));
    let proof_c = g1_to_be64(&parse_g1(&proof_json["pi_c"]));

    // ---------- Public inputs ----------
    // Layout MUST match programs/said-shielded-pool/src/instructions/update_root.rs:
    //   [old_root, new_root, start_index, c_0..c_3, pad=0]
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

    // In our deterministic fixture (insert four zeros into an empty tree),
    // old_root == new_root == Z[26], start_index == 0, commitments == 0,
    // pad == 0.
    assert_eq!(pubs[0], pubs[1], "old_root == new_root in identity case");
    assert_eq!(pubs[2], [0u8; 32], "start_index == 0");
    for i in 3..7 {
        assert_eq!(pubs[i], [0u8; 32], "commitment[{}] == 0", i - 3);
    }
    assert_eq!(pubs[7], [0u8; 32], "pad == 0");

    let pubs_arr: [[u8; 32]; 8] = pubs.try_into().unwrap();

    // ---------- Verify ----------
    let mut verifier =
        Groth16Verifier::new(&proof_a, &proof_b, &proof_c, &pubs_arr, &vk).expect("verifier ctor");

    verifier
        .verify()
        .expect("groth16-solana rejected a snarkjs-produced forester proof");

    println!("groth16-solana accepted the forester (batchedUpdate) proof end-to-end");
}
