//! Native C ABI for the Seeker-local Solana shielded-pool prover backend.
//!
//! The Android app loads a shared library named
//! `libghola_shielded_pool_backend.so` and calls
//! [`ghola_shielded_pool_prove_to_file`]. The default build is intentionally
//! fail-closed for real proofs. `mobile-arkworks` proves locally from the
//! Circom WASM/R1CS/zkey artifacts without Node. The `host-snarkjs` feature is
//! a reference Groth16 implementation that shells out to `snarkjs`; it proves
//! the ABI, proof-byte formatting, and withdraw-instruction contract without
//! pretending to be a production Android proving engine.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use curve25519_dalek::edwards::CompressedEdwardsY;
use said_shielded_pool_types::TransferWitness;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::ffi::CStr;
use std::fs;
use std::os::raw::{c_char, c_int};
use std::path::Path;
#[cfg(feature = "host-snarkjs")]
use std::path::PathBuf;
use std::ptr;

const ERR_EMPTY_WITNESS: c_int = 2;
const ERR_EMPTY_ARTIFACT_DIR: c_int = 3;
const ERR_BAD_WITNESS: c_int = 4;
const ERR_MISSING_WASM: c_int = 5;
const ERR_MISSING_ZKEY: c_int = 6;
#[cfg(feature = "mobile-arkworks")]
const ERR_MISSING_R1CS: c_int = 7;
#[cfg(all(not(feature = "host-snarkjs"), not(feature = "mobile-arkworks")))]
const ERR_BACKEND_NOT_COMPILED: c_int = 12;
#[cfg(any(feature = "host-snarkjs", feature = "mobile-arkworks"))]
const ERR_PROVE_FAILED: c_int = 13;
const ERR_OUTPUT_FAILED: c_int = 14;
const ERR_PANIC: c_int = 70;

#[derive(Debug)]
struct FfiError {
    code: c_int,
    message: String,
}

impl FfiError {
    fn new(code: c_int, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

type Result<T> = std::result::Result<T, FfiError>;

/// C ABI entrypoint used by `android/app/src/main/cpp/shielded_pool_jni.cpp`.
///
/// # Safety
///
/// All pointer arguments must either be valid NUL-terminated C strings or a
/// valid writable error buffer (`error_buf`) with `error_buf_len` bytes.
#[no_mangle]
pub extern "C" fn ghola_shielded_pool_prove_to_file(
    transfer_witness_json: *const c_char,
    artifact_dir: *const c_char,
    output_json_path: *const c_char,
    error_buf: *mut c_char,
    error_buf_len: usize,
) -> c_int {
    let result = std::panic::catch_unwind(|| {
        ffi_entry(transfer_witness_json, artifact_dir, output_json_path)
    });

    match result {
        Ok(Ok(())) => 0,
        Ok(Err(err)) => {
            write_error(error_buf, error_buf_len, &err.message);
            err.code
        }
        Err(_) => {
            write_error(
                error_buf,
                error_buf_len,
                "shielded-pool backend panicked; no public fallback",
            );
            ERR_PANIC
        }
    }
}

fn ffi_entry(
    transfer_witness_json: *const c_char,
    artifact_dir: *const c_char,
    output_json_path: *const c_char,
) -> Result<()> {
    let witness_json = c_string(transfer_witness_json, ERR_EMPTY_WITNESS, "transfer witness")?;
    let artifact_dir = c_string(artifact_dir, ERR_EMPTY_ARTIFACT_DIR, "artifact directory")?;
    let output_json_path = c_string(output_json_path, ERR_OUTPUT_FAILED, "output JSON path")?;
    prove_to_file(
        witness_json,
        Path::new(artifact_dir),
        Path::new(output_json_path),
    )
}

fn c_string<'a>(ptr: *const c_char, code: c_int, label: &str) -> Result<&'a str> {
    if ptr.is_null() {
        return Err(FfiError::new(code, format!("{label} is empty")));
    }
    let raw = unsafe { CStr::from_ptr(ptr) };
    let s = raw
        .to_str()
        .map_err(|_| FfiError::new(code, format!("{label} is not valid UTF-8")))?;
    if s.is_empty() {
        return Err(FfiError::new(code, format!("{label} is empty")));
    }
    Ok(s)
}

fn write_error(error_buf: *mut c_char, error_buf_len: usize, message: &str) {
    if error_buf.is_null() || error_buf_len == 0 {
        return;
    }
    let bytes = message.as_bytes();
    let n = bytes.len().min(error_buf_len.saturating_sub(1));
    unsafe {
        ptr::copy_nonoverlapping(bytes.as_ptr(), error_buf.cast::<u8>(), n);
        *error_buf.add(n) = 0;
    }
}

fn prove_to_file(witness_json: &str, artifact_dir: &Path, output_json_path: &Path) -> Result<()> {
    let value: Value = serde_json::from_str(witness_json).map_err(|e| {
        FfiError::new(
            ERR_BAD_WITNESS,
            format!("transfer witness JSON is invalid: {e}"),
        )
    })?;

    ensure_artifacts(artifact_dir)?;

    if is_self_test_only(&value) {
        let response = json!({
            "self_test_only": true,
            "backend": backend_name(),
            "witness_input_written": false,
            "artifacts_present": true,
            "groth16_call_site": "ghola_shielded_pool_prove_to_file",
            "proof_submitted": false,
        });
        write_json(output_json_path, &response)?;
        return Ok(());
    }

    let witness: TransferWitness = serde_json::from_value(value.clone()).map_err(|e| {
        FfiError::new(
            ERR_BAD_WITNESS,
            format!("transfer witness is not a TransferWitness: {e}"),
        )
    })?;

    let proof = prove_groth16(&witness, artifact_dir)?;
    let output = build_output_json(&value, &witness, &proof)?;
    write_json(output_json_path, &output)
}

fn ensure_artifacts(artifact_dir: &Path) -> Result<()> {
    if artifact_dir.as_os_str().is_empty() {
        return Err(FfiError::new(
            ERR_EMPTY_ARTIFACT_DIR,
            "artifact directory is empty",
        ));
    }
    let wasm = artifact_dir.join("transaction.wasm");
    if !wasm.is_file() {
        return Err(FfiError::new(
            ERR_MISSING_WASM,
            "transaction.wasm is missing",
        ));
    }
    let zkey = artifact_dir.join("transaction_final.zkey");
    if !zkey.is_file() {
        return Err(FfiError::new(
            ERR_MISSING_ZKEY,
            "transaction_final.zkey is missing",
        ));
    }
    #[cfg(feature = "mobile-arkworks")]
    {
        let r1cs = artifact_dir.join("transaction.r1cs");
        if !r1cs.is_file() {
            return Err(FfiError::new(
                ERR_MISSING_R1CS,
                "transaction.r1cs is missing",
            ));
        }
    }
    Ok(())
}

fn is_self_test_only(value: &Value) -> bool {
    value
        .get("self_test_only")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || value
            .pointer("/_ghola_meta/self_test_only")
            .and_then(Value::as_bool)
            .unwrap_or(false)
}

fn write_json(output_json_path: &Path, value: &Value) -> Result<()> {
    let bytes = serde_json::to_vec(value).map_err(|e| {
        FfiError::new(
            ERR_OUTPUT_FAILED,
            format!("failed to serialize proof output: {e}"),
        )
    })?;
    fs::write(output_json_path, bytes).map_err(|e| {
        FfiError::new(
            ERR_OUTPUT_FAILED,
            format!("failed to write proof output: {e}"),
        )
    })
}

fn backend_name() -> &'static str {
    #[cfg(all(feature = "mobile-arkworks", not(feature = "host-snarkjs")))]
    {
        "ghola_shielded_pool_backend_mobile_arkworks"
    }
    #[cfg(all(feature = "host-snarkjs", not(feature = "mobile-arkworks")))]
    {
        "ghola_shielded_pool_backend_host_snarkjs"
    }
    #[cfg(all(feature = "host-snarkjs", feature = "mobile-arkworks"))]
    {
        "ghola_shielded_pool_backend_misconfigured"
    }
    #[cfg(all(not(feature = "host-snarkjs"), not(feature = "mobile-arkworks")))]
    {
        "ghola_shielded_pool_backend_mobile_fail_closed"
    }
}

#[derive(Debug, Clone)]
struct MobileProof {
    a: [u8; 64],
    b: [u8; 128],
    c: [u8; 64],
    root: [u8; 32],
    input_nullifiers: [[u8; 32]; 2],
    output_commitments: [[u8; 32]; 2],
    public_amount: i128,
    public_amount_be: [u8; 32],
    asset_id: [u8; 32],
    ext_data_hash: [u8; 32],
}

#[cfg(all(not(feature = "host-snarkjs"), not(feature = "mobile-arkworks")))]
fn prove_groth16(_witness: &TransferWitness, _artifact_dir: &Path) -> Result<MobileProof> {
    Err(FfiError::new(
        ERR_BACKEND_NOT_COMPILED,
        "mobile Groth16 backend is not compiled in this build; link a real Android witness/prover engine or use host-snarkjs only for ABI testing",
    ))
}

#[cfg(all(feature = "host-snarkjs", feature = "mobile-arkworks"))]
fn prove_groth16(_witness: &TransferWitness, _artifact_dir: &Path) -> Result<MobileProof> {
    Err(FfiError::new(
        ERR_PROVE_FAILED,
        "host-snarkjs and mobile-arkworks are mutually exclusive backend features",
    ))
}

#[cfg(all(feature = "host-snarkjs", not(feature = "mobile-arkworks")))]
fn prove_groth16(witness: &TransferWitness, artifact_dir: &Path) -> Result<MobileProof> {
    use said_shielded_pool_prover::onchain_format::build_onchain_proof;
    use said_shielded_pool_prover::witness::build_input_json;
    use std::process::{Command, Stdio};

    let workdir = tempfile::Builder::new()
        .prefix("proof-work-")
        .tempdir_in(artifact_dir)
        .map_err(|e| {
            FfiError::new(
                ERR_PROVE_FAILED,
                format!("failed to create proof workdir: {e}"),
            )
        })?;

    let wasm = artifact_dir.join("transaction.wasm");
    let zkey = artifact_dir.join("transaction_final.zkey");
    let input_path = workdir.path().join("input.json");
    let witness_path = workdir.path().join("witness.wtns");
    let proof_path = workdir.path().join("proof.json");
    let public_path = workdir.path().join("public.json");

    let sks = vec![witness.spending_key; witness.input_notes.len()];
    let input_json = build_input_json(witness, &sks);
    let input_bytes = serde_json::to_vec(&input_json).map_err(|e| {
        FfiError::new(
            ERR_BAD_WITNESS,
            format!("failed to serialize circuit witness input: {e}"),
        )
    })?;
    fs::write(&input_path, input_bytes).map_err(|e| {
        FfiError::new(
            ERR_PROVE_FAILED,
            format!("failed to write local circuit witness input: {e}"),
        )
    })?;

    let snarkjs = resolve_snarkjs_bin();
    run_snarkjs(
        Command::new(&snarkjs)
            .args([
                "wtns",
                "calculate",
                path_str(&wasm)?,
                path_str(&input_path)?,
                path_str(&witness_path)?,
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null()),
        "snarkjs wtns calculate",
    )?;
    run_snarkjs(
        Command::new(&snarkjs)
            .args([
                "groth16",
                "prove",
                path_str(&zkey)?,
                path_str(&witness_path)?,
                path_str(&proof_path)?,
                path_str(&public_path)?,
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null()),
        "snarkjs groth16 prove",
    )?;

    let proof_json: Value =
        serde_json::from_slice(&fs::read(&proof_path).map_err(|e| {
            FfiError::new(ERR_PROVE_FAILED, format!("failed to read proof.json: {e}"))
        })?)
        .map_err(|e| FfiError::new(ERR_PROVE_FAILED, format!("proof.json is malformed: {e}")))?;
    let public_json: Value = serde_json::from_slice(&fs::read(&public_path).map_err(|e| {
        FfiError::new(ERR_PROVE_FAILED, format!("failed to read public.json: {e}"))
    })?)
    .map_err(|e| FfiError::new(ERR_PROVE_FAILED, format!("public.json is malformed: {e}")))?;

    let onchain = build_onchain_proof(&proof_json, &public_json);
    if onchain.public_inputs.len() != 8 {
        return Err(FfiError::new(
            ERR_PROVE_FAILED,
            format!(
                "expected 8 public signals from transaction circuit, got {}",
                onchain.public_inputs.len()
            ),
        ));
    }
    if onchain.public_inputs[6] != witness.asset_id.0 {
        return Err(FfiError::new(
            ERR_PROVE_FAILED,
            "circuit public asset_id does not match witness asset_id",
        ));
    }
    if onchain.public_inputs[7] != witness.ext_data_hash {
        return Err(FfiError::new(
            ERR_PROVE_FAILED,
            "circuit public ext_data_hash does not match witness ext_data_hash",
        ));
    }

    Ok(MobileProof {
        a: onchain.proof_a,
        b: onchain.proof_b,
        c: onchain.proof_c,
        root: onchain.public_inputs[0],
        input_nullifiers: [onchain.public_inputs[1], onchain.public_inputs[2]],
        output_commitments: [onchain.public_inputs[3], onchain.public_inputs[4]],
        public_amount: witness.public_amount,
        public_amount_be: onchain.public_inputs[5],
        asset_id: onchain.public_inputs[6],
        ext_data_hash: onchain.public_inputs[7],
    })
}

#[cfg(all(feature = "mobile-arkworks", not(feature = "host-snarkjs")))]
fn prove_groth16(witness: &TransferWitness, artifact_dir: &Path) -> Result<MobileProof> {
    use ark_bn254::{Bn254, Fr};
    use ark_circom::{CircomBuilder, CircomConfig, CircomReduction};
    use ark_crypto_primitives::snark::SNARK;
    use ark_groth16::Groth16;
    use said_shielded_pool_prover::witness::build_input_json;

    let wasm = artifact_dir.join("transaction.wasm");
    let r1cs = artifact_dir.join("transaction.r1cs");
    let zkey = artifact_dir.join("transaction_final.zkey");

    let mut zkey_file = fs::File::open(&zkey).map_err(|e| {
        FfiError::new(
            ERR_PROVE_FAILED,
            format!("failed to open transaction_final.zkey: {e}"),
        )
    })?;
    let (proving_key, _) = ark_circom::read_zkey(&mut zkey_file).map_err(|e| {
        FfiError::new(
            ERR_PROVE_FAILED,
            format!("failed to parse transaction_final.zkey: {e}"),
        )
    })?;

    let cfg = CircomConfig::<Fr>::new(&wasm, &r1cs).map_err(|e| {
        FfiError::new(
            ERR_PROVE_FAILED,
            format!("failed to load transaction.wasm/transaction.r1cs: {e}"),
        )
    })?;
    let mut builder = CircomBuilder::new(cfg);
    let sks = vec![witness.spending_key; witness.input_notes.len()];
    let input_json = build_input_json(witness, &sks);
    push_circom_inputs(&mut builder, &input_json)?;

    let circom = builder.build().map_err(|e| {
        FfiError::new(
            ERR_PROVE_FAILED,
            format!("failed to build transaction witness locally: {e}"),
        )
    })?;
    let public_inputs = circom.get_public_inputs().ok_or_else(|| {
        FfiError::new(
            ERR_PROVE_FAILED,
            "transaction circuit did not expose public inputs",
        )
    })?;
    if public_inputs.len() != 8 {
        return Err(FfiError::new(
            ERR_PROVE_FAILED,
            format!(
                "expected 8 public signals from transaction circuit, got {}",
                public_inputs.len()
            ),
        ));
    }

    let mut rng = rand::thread_rng();
    let proof =
        Groth16::<Bn254, CircomReduction>::prove(&proving_key, circom, &mut rng).map_err(|e| {
            FfiError::new(
                ERR_PROVE_FAILED,
                format!("failed to construct local Groth16 proof: {e}"),
            )
        })?;
    let pvk = Groth16::<Bn254>::process_vk(&proving_key.vk).map_err(|e| {
        FfiError::new(
            ERR_PROVE_FAILED,
            format!("failed to process local verification key: {e}"),
        )
    })?;
    let verified = Groth16::<Bn254>::verify_with_processed_vk(&pvk, &public_inputs, &proof)
        .map_err(|e| {
            FfiError::new(
                ERR_PROVE_FAILED,
                format!("local Groth16 proof verification errored: {e}"),
            )
        })?;
    if !verified {
        return Err(FfiError::new(
            ERR_PROVE_FAILED,
            "local Groth16 proof did not verify against transaction_final.zkey",
        ));
    }

    arkworks_proof_to_mobile(witness, &proof, &public_inputs)
}

#[cfg(all(feature = "mobile-arkworks", not(feature = "host-snarkjs")))]
fn push_circom_inputs(
    builder: &mut ark_circom::CircomBuilder<ark_bn254::Fr>,
    value: &Value,
) -> Result<()> {
    let object = value.as_object().ok_or_else(|| {
        FfiError::new(
            ERR_BAD_WITNESS,
            "circuit witness input must be a JSON object",
        )
    })?;
    for (name, item) in object {
        push_circom_input_value(builder, name, item)?;
    }
    Ok(())
}

#[cfg(all(feature = "mobile-arkworks", not(feature = "host-snarkjs")))]
fn push_circom_input_value(
    builder: &mut ark_circom::CircomBuilder<ark_bn254::Fr>,
    name: &str,
    value: &Value,
) -> Result<()> {
    match value {
        Value::String(s) => {
            let n = s.trim().parse::<num_bigint::BigInt>().map_err(|e| {
                FfiError::new(
                    ERR_BAD_WITNESS,
                    format!("circuit input {name} is not a decimal field element: {e}"),
                )
            })?;
            builder.push_input(name, n);
            Ok(())
        }
        Value::Number(n) => {
            let parsed = n.to_string().parse::<num_bigint::BigInt>().map_err(|e| {
                FfiError::new(
                    ERR_BAD_WITNESS,
                    format!("circuit input {name} is not a decimal field element: {e}"),
                )
            })?;
            builder.push_input(name, parsed);
            Ok(())
        }
        Value::Array(items) => {
            for item in items {
                push_circom_input_value(builder, name, item)?;
            }
            Ok(())
        }
        _ => Err(FfiError::new(
            ERR_BAD_WITNESS,
            format!("circuit input {name} must contain decimal strings or arrays"),
        )),
    }
}

#[cfg(all(feature = "mobile-arkworks", not(feature = "host-snarkjs")))]
fn arkworks_proof_to_mobile(
    witness: &TransferWitness,
    proof: &ark_groth16::Proof<ark_bn254::Bn254>,
    public_inputs: &[ark_bn254::Fr],
) -> Result<MobileProof> {
    let public_inputs: Vec<[u8; 32]> = public_inputs.iter().map(fr_to_be32).collect();
    if public_inputs[6] != witness.asset_id.0 {
        return Err(FfiError::new(
            ERR_PROVE_FAILED,
            "circuit public asset_id does not match witness asset_id",
        ));
    }
    if public_inputs[7] != witness.ext_data_hash {
        return Err(FfiError::new(
            ERR_PROVE_FAILED,
            "circuit public ext_data_hash does not match witness ext_data_hash",
        ));
    }

    let proof_a = g1_to_be64(&(-proof.a.clone()))?;
    let proof_b = g2_to_be128(&proof.b)?;
    let proof_c = g1_to_be64(&proof.c)?;

    Ok(MobileProof {
        a: proof_a,
        b: proof_b,
        c: proof_c,
        root: public_inputs[0],
        input_nullifiers: [public_inputs[1], public_inputs[2]],
        output_commitments: [public_inputs[3], public_inputs[4]],
        public_amount: witness.public_amount,
        public_amount_be: public_inputs[5],
        asset_id: public_inputs[6],
        ext_data_hash: public_inputs[7],
    })
}

#[cfg(all(feature = "mobile-arkworks", not(feature = "host-snarkjs")))]
fn fr_to_be32(x: &ark_bn254::Fr) -> [u8; 32] {
    field_to_be32(x)
}

#[cfg(all(feature = "mobile-arkworks", not(feature = "host-snarkjs")))]
fn fq_to_be32(x: &ark_bn254::Fq) -> [u8; 32] {
    field_to_be32(x)
}

#[cfg(all(feature = "mobile-arkworks", not(feature = "host-snarkjs")))]
fn field_to_be32<F: ark_ff::PrimeField>(x: &F) -> [u8; 32] {
    use ark_ff::BigInteger as _;

    let bytes = (*x).into_bigint().to_bytes_be();
    let mut out = [0u8; 32];
    out[32 - bytes.len()..].copy_from_slice(&bytes);
    out
}

#[cfg(all(feature = "mobile-arkworks", not(feature = "host-snarkjs")))]
fn g1_to_be64(p: &ark_bn254::G1Affine) -> Result<[u8; 64]> {
    use ark_ec::AffineRepr as _;

    let mut out = [0u8; 64];
    let (x, y) = p.xy().ok_or_else(|| {
        FfiError::new(
            ERR_PROVE_FAILED,
            "Groth16 proof contains a G1 point at infinity",
        )
    })?;
    out[..32].copy_from_slice(&fq_to_be32(&x));
    out[32..].copy_from_slice(&fq_to_be32(&y));
    Ok(out)
}

#[cfg(all(feature = "mobile-arkworks", not(feature = "host-snarkjs")))]
fn g2_to_be128(p: &ark_bn254::G2Affine) -> Result<[u8; 128]> {
    use ark_ec::AffineRepr as _;

    let mut out = [0u8; 128];
    let (x, y) = p.xy().ok_or_else(|| {
        FfiError::new(
            ERR_PROVE_FAILED,
            "Groth16 proof contains a G2 point at infinity",
        )
    })?;
    out[..32].copy_from_slice(&fq_to_be32(&x.c1));
    out[32..64].copy_from_slice(&fq_to_be32(&x.c0));
    out[64..96].copy_from_slice(&fq_to_be32(&y.c1));
    out[96..128].copy_from_slice(&fq_to_be32(&y.c0));
    Ok(out)
}

#[cfg(all(feature = "host-snarkjs", not(feature = "mobile-arkworks")))]
fn resolve_snarkjs_bin() -> PathBuf {
    if let Some(path) = std::env::var_os("GHOLA_SNARKJS_BIN")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
    {
        return path;
    }
    let local = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../said-shielded-pool-circuits/circuits/node_modules/.bin/snarkjs");
    if local.is_file() {
        return local;
    }
    PathBuf::from("snarkjs")
}

#[cfg(all(feature = "host-snarkjs", not(feature = "mobile-arkworks")))]
fn path_str(path: &Path) -> Result<&str> {
    path.to_str()
        .ok_or_else(|| FfiError::new(ERR_PROVE_FAILED, "proof artifact path is not valid UTF-8"))
}

#[cfg(all(feature = "host-snarkjs", not(feature = "mobile-arkworks")))]
fn run_snarkjs(cmd: &mut std::process::Command, label: &str) -> Result<()> {
    let status = cmd
        .status()
        .map_err(|e| FfiError::new(ERR_PROVE_FAILED, format!("{label} failed to spawn: {e}")))?;
    if !status.success() {
        return Err(FfiError::new(
            ERR_PROVE_FAILED,
            format!(
                "{label} failed with status {status}; stderr suppressed to avoid witness leakage"
            ),
        ));
    }
    Ok(())
}

fn build_output_json(
    value: &Value,
    witness: &TransferWitness,
    proof: &MobileProof,
) -> Result<Value> {
    let amount = amount_from_meta_or_witness(value, witness)?;
    let fee = u64_field(
        value,
        &["/_ghola_meta/fee", "/_ghola_meta/solana_context/fee"],
    )
    .unwrap_or(0);
    let relayer_fee = u64_field(
        value,
        &[
            "/_ghola_meta/relayer_fee",
            "/_ghola_meta/solana_context/relayer_fee",
        ],
    )
    .unwrap_or(0);
    let ix = build_withdraw_instruction(value, proof, amount, relayer_fee)?;
    let public_amount = i64::try_from(proof.public_amount).map_err(|_| {
        FfiError::new(
            ERR_OUTPUT_FAILED,
            "proof public_amount is outside the JSON i64 range accepted by the relayer",
        )
    })?;
    let proof_bundle = json!({
        "a": hex::encode(proof.a),
        "b": hex::encode(proof.b),
        "c": hex::encode(proof.c),
        "root": hex::encode(proof.root),
        "input_nullifiers": [
            hex::encode(proof.input_nullifiers[0]),
            hex::encode(proof.input_nullifiers[1]),
        ],
        "output_commitments": [
            hex::encode(proof.output_commitments[0]),
            hex::encode(proof.output_commitments[1]),
        ],
        "public_amount": public_amount,
        "asset_id": hex::encode(proof.asset_id),
        "ext_data_hash": hex::encode(proof.ext_data_hash),
    });
    let proof_b64 = B64.encode(serde_json::to_vec(&proof_bundle).map_err(|e| {
        FfiError::new(
            ERR_OUTPUT_FAILED,
            format!("failed to serialize proof bundle for proof_b64: {e}"),
        )
    })?);
    let accounts = serde_json::to_value(&ix.accounts).map_err(|e| {
        FfiError::new(
            ERR_OUTPUT_FAILED,
            format!("failed to serialize withdraw accounts: {e}"),
        )
    })?;

    Ok(json!({
        "backend": backend_name(),
        "proof_bundle": proof_bundle,
        "proof_b64": proof_b64,
        "nullifier_hex": hex::encode(proof.input_nullifiers[0]),
        "instruction_data_hex": ix.data_hex,
        "accounts": accounts,
        "withdraw_instruction": {
            "data_hex": ix.data_hex,
            "accounts": accounts,
        },
        "fee": fee,
        "relayer_fee": relayer_fee,
    }))
}

#[derive(Debug)]
struct WithdrawInstruction {
    data_hex: String,
    accounts: Vec<AccountJson>,
}

#[derive(Debug, Clone, Serialize)]
struct AccountJson {
    pubkey: String,
    is_signer: bool,
    is_writable: bool,
}

fn build_withdraw_instruction(
    value: &Value,
    proof: &MobileProof,
    amount: u64,
    relayer_fee: u64,
) -> Result<WithdrawInstruction> {
    let ctx = value
        .pointer("/_ghola_meta/solana_context")
        .ok_or_else(|| {
            FfiError::new(
                ERR_OUTPUT_FAILED,
                "witness is missing _ghola_meta.solana_context",
            )
        })?;

    let program_id = pubkey_from_context(ctx, "program_id")?;
    let meta = value.pointer("/_ghola_meta").unwrap_or(&Value::Null);
    let payer = match optional_pubkey(ctx, "relayer_payer")? {
        Some(payer) => payer,
        None => optional_pubkey(meta, "wallet_address")?.ok_or_else(|| {
            FfiError::new(
                ERR_OUTPUT_FAILED,
                "missing relayer_payer or wallet_address for withdraw payer",
            )
        })?,
    };
    let pool_config = pubkey_from_context(ctx, "pool_config")?;
    let verifier_key = pubkey_from_context(ctx, "verifier_key")?;
    let mint = pubkey_from_context(ctx, "mint")?;
    let merkle_tree = pubkey_from_context(ctx, "merkle_tree")?;
    let escrow = pubkey_from_context(ctx, "escrow")?;
    let token_program = pubkey_from_context(ctx, "token_program")?;
    let system_program = pubkey_from_context(ctx, "system_program")?;
    let recipient_token_account = recipient_token_account(value, ctx)?;
    let relayer_token_account =
        optional_pubkey(ctx, "relayer_token_account")?.unwrap_or(recipient_token_account);
    let nullifier = optional_pubkey(ctx, "nullifier")?.unwrap_or_else(|| {
        find_program_address(
            &[
                b"nullifier".as_slice(),
                mint.as_slice(),
                proof.input_nullifiers[0].as_slice(),
            ],
            &program_id,
        )
        .0
    });
    let change_commitment = if let Some(pk) = optional_pubkey(ctx, "change_commitment")? {
        pk
    } else {
        let queue_tail = u64_field_from_value(ctx, "queue_tail")
            .or_else(|| u64_field_from_value(ctx, "next_index"))
            .ok_or_else(|| {
                FfiError::new(
                    ERR_OUTPUT_FAILED,
                    "missing solana_context.change_commitment or queue_tail for withdraw PDA derivation",
                )
            })?;
        find_program_address(
            &[
                b"commitment".as_slice(),
                merkle_tree.as_slice(),
                queue_tail.to_le_bytes().as_slice(),
            ],
            &program_id,
        )
        .0
    };

    let data_hex = hex::encode(withdraw_data(proof, amount, relayer_fee));
    let accounts = vec![
        account(payer, true, true),
        account(pool_config, false, false),
        account(verifier_key, false, false),
        account(mint, false, false),
        account(merkle_tree, false, true),
        account(nullifier, false, true),
        account(change_commitment, false, true),
        account(escrow, false, true),
        account(recipient_token_account, false, true),
        account(relayer_token_account, false, true),
        account(token_program, false, false),
        account(system_program, false, false),
    ];

    Ok(WithdrawInstruction { data_hex, accounts })
}

fn withdraw_data(proof: &MobileProof, amount: u64, relayer_fee: u64) -> Vec<u8> {
    let mut data = Vec::with_capacity(8 + 64 + 128 + 64 + 32 * 8 + 16);
    data.extend_from_slice(&discriminator("withdraw"));
    data.extend_from_slice(&proof.a);
    data.extend_from_slice(&proof.b);
    data.extend_from_slice(&proof.c);
    data.extend_from_slice(&proof.root);
    data.extend_from_slice(&proof.input_nullifiers[0]);
    data.extend_from_slice(&proof.output_commitments[0]);
    data.extend_from_slice(&amount.to_le_bytes());
    data.extend_from_slice(&relayer_fee.to_le_bytes());
    data.extend_from_slice(&proof.public_amount_be);
    data.extend_from_slice(&proof.asset_id);
    data.extend_from_slice(&proof.ext_data_hash);
    data.extend_from_slice(&proof.output_commitments[1]);
    data.extend_from_slice(&proof.input_nullifiers[1]);
    data
}

fn discriminator(name: &str) -> [u8; 8] {
    let mut hasher = Sha256::new();
    hasher.update(format!("global:{name}").as_bytes());
    let hash = hasher.finalize();
    let mut out = [0u8; 8];
    out.copy_from_slice(&hash[..8]);
    out
}

fn account(pubkey: [u8; 32], is_signer: bool, is_writable: bool) -> AccountJson {
    AccountJson {
        pubkey: bs58::encode(pubkey).into_string(),
        is_signer,
        is_writable,
    }
}

fn pubkey_from_context(ctx: &Value, key: &str) -> Result<[u8; 32]> {
    optional_pubkey(ctx, key)?.ok_or_else(|| {
        FfiError::new(
            ERR_OUTPUT_FAILED,
            format!("solana_context.{key} is missing or empty"),
        )
    })
}

fn optional_pubkey(obj: &Value, key: &str) -> Result<Option<[u8; 32]>> {
    let Some(raw) = obj.get(key).and_then(Value::as_str).map(str::trim) else {
        return Ok(None);
    };
    if raw.is_empty() {
        return Ok(None);
    }
    let decoded = bs58::decode(raw)
        .into_vec()
        .map_err(|_| FfiError::new(ERR_OUTPUT_FAILED, format!("{key} is not valid base58")))?;
    if decoded.len() != 32 {
        return Err(FfiError::new(
            ERR_OUTPUT_FAILED,
            format!("{key} is not a 32-byte Solana pubkey"),
        ));
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&decoded);
    Ok(Some(out))
}

fn recipient_token_account(value: &Value, ctx: &Value) -> Result<[u8; 32]> {
    if let Some(pk) = optional_pubkey(ctx, "recipient_token_account")? {
        return Ok(pk);
    }
    let meta = value.pointer("/_ghola_meta").unwrap_or(&Value::Null);
    let recipient_kind = meta
        .get("recipient_kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if recipient_kind == "solana_token_account" {
        return optional_pubkey(meta, "recipient")?.ok_or_else(|| {
            FfiError::new(
                ERR_OUTPUT_FAILED,
                "_ghola_meta.recipient is not a valid token account",
            )
        });
    }
    Err(FfiError::new(
        ERR_OUTPUT_FAILED,
        "withdraw instruction requires solana_context.recipient_token_account or _ghola_meta.recipient_kind=solana_token_account",
    ))
}

fn amount_from_meta_or_witness(value: &Value, witness: &TransferWitness) -> Result<u64> {
    if let Some(v) = u64_field(
        value,
        &["/_ghola_meta/amount_micro_usdc", "/_ghola_meta/amount"],
    ) {
        return Ok(v);
    }
    let amount = witness.public_amount.unsigned_abs();
    u64::try_from(amount).map_err(|_| {
        FfiError::new(
            ERR_OUTPUT_FAILED,
            "witness public_amount is too large for a Solana withdraw amount",
        )
    })
}

fn u64_field(root: &Value, pointers: &[&str]) -> Option<u64> {
    pointers
        .iter()
        .find_map(|p| root.pointer(p).and_then(value_as_u64))
}

fn u64_field_from_value(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(value_as_u64)
}

fn value_as_u64(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_str()?.trim().parse::<u64>().ok())
}

fn find_program_address(seeds: &[&[u8]], program_id: &[u8; 32]) -> ([u8; 32], u8) {
    for bump in (0u8..=255).rev() {
        let mut hasher = Sha256::new();
        for seed in seeds {
            hasher.update(seed);
        }
        hasher.update([bump]);
        hasher.update(program_id);
        hasher.update(b"ProgramDerivedAddress");
        let hash = hasher.finalize();
        let candidate: [u8; 32] = hash.into();
        if !is_on_curve(&candidate) {
            return (candidate, bump);
        }
    }
    panic!("could not find valid PDA bump");
}

fn is_on_curve(bytes: &[u8; 32]) -> bool {
    CompressedEdwardsY(*bytes).decompress().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;

    fn pk(byte: u8) -> String {
        bs58::encode([byte; 32]).into_string()
    }

    fn artifact_dir() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("transaction.wasm"), b"wasm").unwrap();
        fs::write(dir.path().join("transaction_final.zkey"), b"zkey").unwrap();
        #[cfg(feature = "mobile-arkworks")]
        fs::write(dir.path().join("transaction.r1cs"), b"r1cs").unwrap();
        dir
    }

    fn witness_json(self_test: bool) -> Value {
        json!({
            "input_notes": [],
            "input_paths": [],
            "input_indices": [],
            "output_notes": [],
            "spending_key": vec![1; 32],
            "public_amount": 10,
            "asset_id": vec![2; 32],
            "ext_data_hash": vec![3; 32],
            "_ghola_meta": {
                "self_test_only": self_test,
                "wallet_address": pk(9),
                "recipient": pk(8),
                "recipient_kind": "solana_token_account",
                "solana_context": {
                    "program_id": pk(1),
                    "pool_config": pk(2),
                    "verifier_key": pk(3),
                    "mint": pk(4),
                    "merkle_tree": pk(5),
                    "escrow": pk(6),
                    "token_program": pk(7),
                    "system_program": pk(0),
                    "relayer_payer": pk(10),
                    "relayer_token_account": pk(11),
                    "queue_tail": 42
                }
            }
        })
    }

    fn dummy_proof() -> MobileProof {
        MobileProof {
            a: [0x11; 64],
            b: [0x22; 128],
            c: [0x33; 64],
            root: [0x44; 32],
            input_nullifiers: [[0x55; 32], [0x56; 32]],
            output_commitments: [[0x66; 32], [0x67; 32]],
            public_amount: 10,
            public_amount_be: {
                let mut x = [0u8; 32];
                x[31] = 10;
                x
            },
            asset_id: [0x77; 32],
            ext_data_hash: [0x88; 32],
        }
    }

    #[test]
    fn self_test_only_writes_safe_output_without_proving() {
        let dir = artifact_dir();
        let out = dir.path().join("out.json");
        prove_to_file(&witness_json(true).to_string(), dir.path(), &out).unwrap();

        let v: Value = serde_json::from_slice(&fs::read(out).unwrap()).unwrap();
        assert_eq!(v["self_test_only"], true);
        assert_eq!(v["proof_submitted"], false);
        assert_eq!(v["artifacts_present"], true);
    }

    #[test]
    fn ffi_self_test_returns_zero_and_writes_output() {
        let dir = artifact_dir();
        let out = dir.path().join("out.json");
        let witness = CString::new(witness_json(true).to_string()).unwrap();
        let artifact = CString::new(dir.path().to_str().unwrap()).unwrap();
        let output = CString::new(out.to_str().unwrap()).unwrap();
        let mut err = [0i8; 256];

        let rc = ghola_shielded_pool_prove_to_file(
            witness.as_ptr(),
            artifact.as_ptr(),
            output.as_ptr(),
            err.as_mut_ptr(),
            err.len(),
        );

        assert_eq!(rc, 0);
        assert!(out.exists());
    }

    #[test]
    fn withdraw_instruction_uses_anchor_account_order_and_relayer_payer() {
        let v = witness_json(false);
        let proof = dummy_proof();
        let ix = build_withdraw_instruction(&v, &proof, 10, 0).unwrap();

        assert_eq!(ix.accounts.len(), 12);
        assert_eq!(ix.accounts[0].pubkey, pk(10));
        assert!(ix.accounts[0].is_signer);
        assert_eq!(ix.accounts[1].pubkey, pk(2));
        assert_eq!(ix.accounts[8].pubkey, pk(8));
        assert_eq!(ix.accounts[9].pubkey, pk(11));
        assert!(ix
            .data_hex
            .starts_with(&hex::encode(discriminator("withdraw"))));
        assert_eq!(ix.data_hex.len(), (8 + 64 + 128 + 64 + 32 * 8 + 16) * 2);
    }

    #[test]
    fn missing_queue_tail_and_change_commitment_fails_closed() {
        let mut v = witness_json(false);
        v.pointer_mut("/_ghola_meta/solana_context")
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove("queue_tail");

        let err = build_withdraw_instruction(&v, &dummy_proof(), 10, 0).unwrap_err();
        assert!(err.message.contains("change_commitment"));
    }

    #[test]
    fn derives_expected_nullifier_pda() {
        let program_id = [1u8; 32];
        let mint = [4u8; 32];
        let nullifier = [0x55u8; 32];
        let a = find_program_address(
            &[
                b"nullifier".as_slice(),
                mint.as_slice(),
                nullifier.as_slice(),
            ],
            &program_id,
        );
        let b = find_program_address(
            &[
                b"nullifier".as_slice(),
                mint.as_slice(),
                nullifier.as_slice(),
            ],
            &program_id,
        );
        assert_eq!(a, b);
    }

    #[cfg(feature = "host-snarkjs")]
    #[test]
    #[ignore = "runs the real transaction circuit through snarkjs and zkey artifacts"]
    fn host_snarkjs_reference_generates_groth16_output() {
        let circuits = Path::new(env!("CARGO_MANIFEST_DIR")).join("../said-shielded-pool-circuits");
        let artifacts = artifact_dir();
        fs::copy(
            circuits.join("artifacts/transaction_js/transaction.wasm"),
            artifacts.path().join("transaction.wasm"),
        )
        .unwrap();
        fs::copy(
            circuits.join("ceremony/transaction_final.zkey"),
            artifacts.path().join("transaction_final.zkey"),
        )
        .unwrap();

        let mut witness = witness_json(false);
        witness["public_amount"] = json!(0);
        let output_path = artifacts.path().join("proof-output.json");
        prove_to_file(&witness.to_string(), artifacts.path(), &output_path).unwrap();

        let output: Value = serde_json::from_slice(&fs::read(output_path).unwrap()).unwrap();
        assert_eq!(output["proof_bundle"]["a"].as_str().unwrap().len(), 64 * 2);
        assert_eq!(output["proof_bundle"]["b"].as_str().unwrap().len(), 128 * 2);
        assert_eq!(
            output["withdraw_instruction"]["accounts"]
                .as_array()
                .unwrap()
                .len(),
            12
        );
    }

    #[cfg(all(feature = "mobile-arkworks", not(feature = "host-snarkjs")))]
    #[test]
    #[ignore = "runs the real transaction circuit through arkworks and zkey artifacts"]
    fn mobile_arkworks_reference_generates_groth16_output() {
        let circuits = Path::new(env!("CARGO_MANIFEST_DIR")).join("../said-shielded-pool-circuits");
        let artifacts = artifact_dir();
        fs::copy(
            circuits.join("artifacts/transaction_js/transaction.wasm"),
            artifacts.path().join("transaction.wasm"),
        )
        .unwrap();
        fs::copy(
            circuits.join("artifacts/transaction.r1cs"),
            artifacts.path().join("transaction.r1cs"),
        )
        .unwrap();
        fs::copy(
            circuits.join("ceremony/transaction_final.zkey"),
            artifacts.path().join("transaction_final.zkey"),
        )
        .unwrap();

        let mut witness = witness_json(false);
        witness["public_amount"] = json!(0);
        let output_path = artifacts.path().join("proof-output.json");
        prove_to_file(&witness.to_string(), artifacts.path(), &output_path).unwrap();

        let output: Value = serde_json::from_slice(&fs::read(output_path).unwrap()).unwrap();
        assert_eq!(output["proof_bundle"]["a"].as_str().unwrap().len(), 64 * 2);
        assert_eq!(output["proof_bundle"]["b"].as_str().unwrap().len(), 128 * 2);
        assert_eq!(
            output["withdraw_instruction"]["accounts"]
                .as_array()
                .unwrap()
                .len(),
            12
        );
        assert_eq!(
            output["backend"].as_str().unwrap(),
            "ghola_shielded_pool_backend_mobile_arkworks"
        );
    }
}
