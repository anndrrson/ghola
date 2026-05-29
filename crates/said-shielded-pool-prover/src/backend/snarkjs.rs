//! `snarkjs`-based Groth16 prover backend.
//!
//! Spawns the snarkjs CLI to run `groth16 fullprove`, which:
//!   1. computes the witness via the circuit's `transaction.wasm`,
//!   2. produces a Groth16 proof against `circuit_final.zkey`,
//!   3. writes `proof.json` and `public.json`.
//!
//! We then parse the JSON, convert each field element to BIG-ENDIAN
//! (the format `groth16-solana` and the `alt_bn128` syscalls expect)
//! and NEGATE the G1 `A` point so the on-chain single-pairing check
//! works out. See `src/encoding.rs` for the gory details.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use said_shielded_pool_types::{
    AssetId, BatchedUpdateWitness, Commitment, FieldBytes, ForesterProofBundle,
    ForesterPublicInputs, Groth16Proof, MerkleRoot, Nullifier, ProofBundle, PublicInputs,
    TransferWitness, FORESTER_BATCH_SIZE, TREE_DEPTH,
};
use serde::Deserialize;
use tokio::process::Command;
use tokio::time::timeout;

use common_secrets::Zeroizing;

use crate::backend::{Backend, SecureTempDir};
use crate::config::Config;
use crate::encoding::{
    be_bytes_32_to_decimal, field_str_to_be_bytes_32, hex_str_to_be_bytes_32, negate_g1_a,
};
use crate::error::{Error, Result};

/// snarkjs prover backend. Stateless — all paths come from `Config`.
pub struct SnarkjsBackend {
    cfg: Config,
}

impl SnarkjsBackend {
    pub fn new(cfg: Config) -> Self {
        Self { cfg }
    }
}

#[async_trait]
impl Backend for SnarkjsBackend {
    fn name(&self) -> &'static str {
        "snarkjs"
    }

    async fn prove(&self, witness: TransferWitness) -> Result<ProofBundle> {
        let zkey = self.cfg.zkey_path();
        let wasm = self.cfg.wasm_path();
        ensure_exists(&zkey)?;
        ensure_exists(&wasm)?;

        // RAII: the temp dir is removed on success, error, AND panic, with
        // an unpredictable 0700 name and overwrite-before-unlink. The
        // witness JSON contains the spending key in clear; we must not
        // leave it on disk past the lifetime of this function.
        let workdir = SecureTempDir::create_under(&self.cfg.artifacts_dir)?;
        let input_json = workdir.path().join("input.json");
        let witness_wtns = workdir.path().join("witness.wtns");
        let proof_json = workdir.path().join("proof.json");
        let public_json = workdir.path().join("public.json");

        // 1. Serialize the witness to the circom-expected `input.json`.
        //    The exact field names must match `transaction.circom` — we
        //    delegate that mapping to the client crate; here we serialize
        //    the public payload (the rest is reconstructed below).
        //    The serialized bytes embed the spending key (as decimal), so
        //    we hold them in a `Zeroizing<Vec<u8>>` that scrubs on drop.
        //    NOTE: the intermediate `serde_json::Value` (and the `String`
        //    it holds the key in) cannot be scrubbed — serde_json owns
        //    those allocations — so we minimize its lifetime and drop it
        //    immediately after producing the byte buffer.
        let input_bytes: Zeroizing<Vec<u8>> = {
            let circom_input = circom_input_from_witness(&witness)?;
            Zeroizing::new(serde_json::to_vec_pretty(&circom_input)?)
        };
        tokio::fs::write(&input_json, &*input_bytes).await?;
        drop(input_bytes);

        // 2. Run `snarkjs wtns calculate <wasm> <input.json> <witness.wtns>`
        run_snarkjs(
            &[
                "wtns",
                "calculate",
                wasm.to_str().unwrap(),
                input_json.to_str().unwrap(),
                witness_wtns.to_str().unwrap(),
            ],
            self.cfg.subprocess_timeout_ms,
        )
        .await?;

        // 3. Run `snarkjs groth16 prove <zkey> <wtns> <proof.json> <public.json>`
        run_snarkjs(
            &[
                "groth16",
                "prove",
                zkey.to_str().unwrap(),
                witness_wtns.to_str().unwrap(),
                proof_json.to_str().unwrap(),
                public_json.to_str().unwrap(),
            ],
            self.cfg.subprocess_timeout_ms,
        )
        .await?;

        // 4. Read the outputs and translate to ProofBundle.
        let proof_bytes = tokio::fs::read(&proof_json).await?;
        let public_bytes = tokio::fs::read(&public_json).await?;
        let bundle = parse_snarkjs_outputs(&proof_bytes, &public_bytes, &witness)?;

        // `workdir` Drop runs here and removes the dir + witness.
        Ok(bundle)
    }

    async fn vk(&self) -> Result<Vec<u8>> {
        let vk_path = self.cfg.vk_path();
        ensure_exists(&vk_path)?;
        Ok(tokio::fs::read(&vk_path).await?)
    }

    async fn forester_vk(&self) -> Result<Vec<u8>> {
        let vk_path = self.cfg.forester_vk_path();
        ensure_exists(&vk_path)?;
        Ok(tokio::fs::read(&vk_path).await?)
    }

    async fn prove_forester(&self, witness: BatchedUpdateWitness) -> Result<ForesterProofBundle> {
        let zkey = self.cfg.forester_zkey_path();
        let wasm = self.cfg.forester_wasm_path();
        ensure_exists(&zkey)?;
        ensure_exists(&wasm)?;

        // Defensive shape checks before we spawn snarkjs.
        if witness.commitments.len() != FORESTER_BATCH_SIZE {
            return Err(Error::WitnessInvalid(format!(
                "forester witness has {} commitments, expected {FORESTER_BATCH_SIZE}",
                witness.commitments.len()
            )));
        }
        if witness.path_elements.len() != FORESTER_BATCH_SIZE {
            return Err(Error::WitnessInvalid(format!(
                "forester witness has {} path_elements rows, expected {FORESTER_BATCH_SIZE}",
                witness.path_elements.len()
            )));
        }
        for (i, row) in witness.path_elements.iter().enumerate() {
            if row.len() != TREE_DEPTH {
                return Err(Error::WitnessInvalid(format!(
                    "forester witness path_elements[{i}] has length {}, expected {TREE_DEPTH}",
                    row.len()
                )));
            }
        }

        // RAII: removes the dir on success, error, AND panic. See the
        // commentary on `prove()` above — same privacy reasoning, with
        // the additional observation that the forester witness encodes
        // the FULL set of pending commitments in clear, which (if
        // observed mid-prove) lets an attacker correlate the queue
        // contents with the upcoming `update_root_via_proof` tx.
        let workdir = SecureTempDir::create_under(&self.cfg.artifacts_dir)?;
        let input_json = workdir.path().join("input.json");
        let witness_wtns = workdir.path().join("witness.wtns");
        let proof_json = workdir.path().join("proof.json");
        let public_json = workdir.path().join("public.json");

        // Build the circom input.json — the circuit takes ALL fields as
        // decimal strings (or arrays of them). We translate the hex BE
        // 32-byte wire form into decimal here. The serialized bytes carry
        // the full pending-commitment set in clear, so we hold them in a
        // `Zeroizing<Vec<u8>>` that scrubs on drop. (As in `prove`, the
        // intermediate `serde_json::Value` cannot be scrubbed; we drop it
        // as soon as the bytes are produced.)
        let input_bytes: Zeroizing<Vec<u8>> = {
            let circom_input = build_forester_circom_input(&witness)?;
            Zeroizing::new(serde_json::to_vec_pretty(&circom_input)?)
        };
        tokio::fs::write(&input_json, &*input_bytes).await?;
        drop(input_bytes);

        run_snarkjs(
            &[
                "wtns",
                "calculate",
                wasm.to_str().unwrap(),
                input_json.to_str().unwrap(),
                witness_wtns.to_str().unwrap(),
            ],
            self.cfg.subprocess_timeout_ms,
        )
        .await?;

        run_snarkjs(
            &[
                "groth16",
                "prove",
                zkey.to_str().unwrap(),
                witness_wtns.to_str().unwrap(),
                proof_json.to_str().unwrap(),
                public_json.to_str().unwrap(),
            ],
            self.cfg.subprocess_timeout_ms,
        )
        .await?;

        let proof_bytes = tokio::fs::read(&proof_json).await?;
        let public_bytes = tokio::fs::read(&public_json).await?;
        let bundle = parse_forester_outputs(&proof_bytes, &public_bytes, &witness)?;

        // `workdir` Drop runs here.
        Ok(bundle)
    }
}

/// Build the `input.json` shape expected by `circuits/batchedUpdate.circom`.
/// Field names MUST match the circom template input signal names.
fn build_forester_circom_input(w: &BatchedUpdateWitness) -> Result<serde_json::Value> {
    let old_root_dec = hex_to_dec(&w.old_root)?;
    let new_root_dec = hex_to_dec(&w.new_root)?;
    let commitments_dec: Vec<String> = w
        .commitments
        .iter()
        .map(|c| hex_to_dec(c))
        .collect::<Result<Vec<_>>>()?;
    let path_elements_dec: Vec<Vec<String>> = w
        .path_elements
        .iter()
        .map(|row| {
            row.iter()
                .map(|s| hex_to_dec(s))
                .collect::<Result<Vec<_>>>()
        })
        .collect::<Result<Vec<_>>>()?;

    Ok(serde_json::json!({
        "oldRoot": old_root_dec,
        "newRoot": new_root_dec,
        "startIndex": w.start_index.to_string(),
        "commitment": commitments_dec,
        "pad": "0",
        "pathElements": path_elements_dec,
    }))
}

fn hex_to_dec(hex_be: &str) -> Result<String> {
    let bytes = hex_str_to_be_bytes_32(hex_be)?;
    Ok(be_bytes_32_to_decimal(&bytes))
}

fn parse_forester_outputs(
    proof_bytes: &[u8],
    public_bytes: &[u8],
    witness: &BatchedUpdateWitness,
) -> Result<ForesterProofBundle> {
    let proof: SnarkjsProofJson = serde_json::from_slice(proof_bytes)?;
    let publics: Vec<String> = serde_json::from_slice(public_bytes)?;

    // Layout MUST match circuits/batchedUpdate.circom (see update_root.rs):
    //   [old_root, new_root, start_index, c_0..c_3, pad=0]
    const EXPECTED_PUBLICS: usize = 8;
    if publics.len() != EXPECTED_PUBLICS {
        return Err(Error::ProofSerializeError(format!(
            "forester: expected {EXPECTED_PUBLICS} public signals, got {}",
            publics.len()
        )));
    }

    // --- A ---
    if proof.pi_a.len() < 2 {
        return Err(Error::ProofSerializeError("pi_a too short".into()));
    }
    let ax = field_str_to_be_bytes_32(&proof.pi_a[0])?;
    let ay = field_str_to_be_bytes_32(&proof.pi_a[1])?;
    let mut a_uncompressed = [0u8; 64];
    a_uncompressed[..32].copy_from_slice(&ax);
    a_uncompressed[32..].copy_from_slice(&ay);
    let a_negated = negate_g1_a(a_uncompressed)?;

    // --- B ---
    if proof.pi_b.len() < 2 || proof.pi_b[0].len() < 2 || proof.pi_b[1].len() < 2 {
        return Err(Error::ProofSerializeError("pi_b malformed".into()));
    }
    let bx0 = field_str_to_be_bytes_32(&proof.pi_b[0][0])?;
    let bx1 = field_str_to_be_bytes_32(&proof.pi_b[0][1])?;
    let by0 = field_str_to_be_bytes_32(&proof.pi_b[1][0])?;
    let by1 = field_str_to_be_bytes_32(&proof.pi_b[1][1])?;
    let mut b_uncompressed = [0u8; 128];
    b_uncompressed[0..32].copy_from_slice(&bx0);
    b_uncompressed[32..64].copy_from_slice(&bx1);
    b_uncompressed[64..96].copy_from_slice(&by0);
    b_uncompressed[96..128].copy_from_slice(&by1);

    // --- C ---
    if proof.pi_c.len() < 2 {
        return Err(Error::ProofSerializeError("pi_c too short".into()));
    }
    let cx = field_str_to_be_bytes_32(&proof.pi_c[0])?;
    let cy = field_str_to_be_bytes_32(&proof.pi_c[1])?;
    let mut c_uncompressed = [0u8; 64];
    c_uncompressed[..32].copy_from_slice(&cx);
    c_uncompressed[32..].copy_from_slice(&cy);

    let groth = Groth16Proof {
        a: a_negated,
        b: b_uncompressed,
        c: c_uncompressed,
    };

    let old_root = MerkleRoot(read_field(&publics[0])?);
    let new_root = MerkleRoot(read_field(&publics[1])?);
    // start_index — verify against witness; the canonical-form decimal in
    // publics[2] is the same u64 value, just zero-padded into a field.
    let start_be = read_field(&publics[2])?;
    let mut start_bytes = [0u8; 8];
    start_bytes.copy_from_slice(&start_be[24..32]);
    let start_index_circuit = u64::from_be_bytes(start_bytes);
    if start_index_circuit != witness.start_index {
        return Err(Error::WitnessInvalid(format!(
            "forester start_index mismatch: witness={} circuit={start_index_circuit}",
            witness.start_index
        )));
    }
    let commitments = vec![
        Commitment(read_field(&publics[3])?),
        Commitment(read_field(&publics[4])?),
        Commitment(read_field(&publics[5])?),
        Commitment(read_field(&publics[6])?),
    ];
    // publics[7] is the pad — the circuit enforces it == 0, but we verify
    // here too so a buggy ptau-replacement is caught early.
    let pad = read_field(&publics[7])?;
    if pad != [0u8; 32] {
        return Err(Error::ProofSerializeError(
            "forester pad public signal is not zero".into(),
        ));
    }

    Ok(ForesterProofBundle {
        proof: groth,
        public_inputs: ForesterPublicInputs {
            old_root,
            new_root,
            start_index: witness.start_index,
            commitments,
        },
    })
}

fn ensure_exists(p: &PathBuf) -> Result<()> {
    if !p.exists() {
        return Err(Error::ArtifactsNotFound(p.clone()));
    }
    Ok(())
}

// The snarkjs scratch directory is managed by the shared
// `crate::backend::SecureTempDir` guard (random 0700 name, overwrite-
// before-unlink in `Drop`). The on-disk window is further capped by the
// per-subprocess `tokio::time::timeout` below.

/// Run a snarkjs subprocess with a hard wall-clock timeout.
///
/// On timeout, we explicitly kill the child (sending SIGKILL via
/// `tokio::process::Child::kill().await`) before returning the typed
/// `Error::SnarkjsTimeout`. The child is also configured with
/// `kill_on_drop(true)` as a belt-and-suspenders guarantee: even if
/// the kill-await above is itself preempted (or this future is
/// cancelled mid-cleanup), tokio's child reaper will send SIGKILL
/// when the `Child` value is dropped.
///
/// Privacy reason: the witness file written to the temp dir contains
/// the spending key and per-input blinding factors. A hung snarkjs
/// could otherwise sit on that file indefinitely. The `SecureTempDir`
/// guard deletes the file when the proof attempt returns; the timeout
/// here ensures the proof attempt DOES return.
async fn run_snarkjs(args: &[&str], timeout_ms: u64) -> Result<()> {
    let mut cmd = Command::new("snarkjs");
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Critical: send SIGKILL automatically if the Child value is
        // dropped without being explicitly killed. This covers the
        // edge case of this future itself being cancelled.
        .kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .map_err(|e| Error::BackendSpawnFailed(format!("snarkjs spawn {args:?}: {e}")))?;

    let wait = child.wait();
    match timeout(Duration::from_millis(timeout_ms), wait).await {
        Ok(Ok(status)) => {
            if !status.success() {
                // Drain stderr for diagnostics. The child has already
                // exited; we just need to slurp its captured pipes.
                let stderr = match child.stderr.take() {
                    Some(mut s) => {
                        use tokio::io::AsyncReadExt;
                        let mut buf = String::new();
                        let _ = s.read_to_string(&mut buf).await;
                        buf
                    }
                    None => String::new(),
                };
                // PRIVACY (Stream 7 audit 2026-05-23): snarkjs is known
                // to echo `input.json` contents in error output when
                // its circuit-input validator fails. `input.json`
                // contains the SPENDING KEY in the clear. We must NOT
                // propagate that to the error message which bubbles up
                // through `tracing::warn!(error = %e, ...)` in the
                // relayer. Redact any long hex-looking run before
                // surfacing.
                let safe_stderr = crate::backend::redact::redact_stderr(&stderr);
                return Err(Error::BackendSpawnFailed(format!(
                    "snarkjs {args:?} exited {}: {safe_stderr}",
                    status
                )));
            }
            Ok(())
        }
        Ok(Err(e)) => Err(Error::BackendSpawnFailed(format!(
            "snarkjs {args:?} io: {e}"
        ))),
        Err(_elapsed) => {
            tracing::warn!(
                args = ?args,
                timeout_ms,
                "snarkjs subprocess exceeded timeout; sending SIGKILL"
            );
            // SIGKILL the child explicitly. We don't want to wait on
            // it (could hang forever if the process is in
            // uninterruptible sleep); the kill_on_drop fallback above
            // will catch that case when `child` falls out of scope.
            let _ = child.kill().await;
            Err(Error::SnarkjsTimeout(timeout_ms))
        }
    }
}

// --------------- input/output JSON wire formats ---------------

/// Build the circom-compatible `input.json` for the transaction circuit.
///
/// This delegates to [`crate::witness::build_input_json`], which renders
/// every field element as a DECIMAL STRING under the circuit's signal
/// names (`root`, `inputNullifier`, `inPathElements`, `publicAmount`,
/// `publicAmountIsNeg`/`publicAmountMagnitude`, …), pads to the fixed
/// 2-in/2-out shape, and computes nullifiers/commitments/root with
/// circom-compatible Poseidon. A previous version serialized the witness
/// verbatim (`serde_json::to_value`), which emitted Rust snake_case field
/// names and 32-element BYTE ARRAYS — input that `snarkjs wtns calculate`
/// rejects (and whose echoed stderr leaked the spending key). Both
/// backends now route through this single mapping.
///
/// v1 single-key model: every real input is spent by `w.spending_key`, so
/// we hand `build_input_json` that key per real input. Pure deposits have
/// no real inputs and fall back to the witness key for dummy derivation.
pub(crate) fn circom_input_from_witness(w: &TransferWitness) -> Result<serde_json::Value> {
    let sk_per_input = vec![w.spending_key; w.input_notes.len()];
    Ok(crate::witness::build_input_json(w, &sk_per_input))
}

#[derive(Debug, Deserialize)]
struct SnarkjsProofJson {
    pi_a: Vec<String>,      // [x, y, 1] — projective; we drop the 1.
    pi_b: Vec<Vec<String>>, // [[x0, x1], [y0, y1], [1, 0]]
    pi_c: Vec<String>,      // [x, y, 1]
    #[allow(dead_code)]
    protocol: Option<String>,
    #[allow(dead_code)]
    curve: Option<String>,
}

/// Re-exposed parser so the rapidsnark backend (which uses the same
/// snarkjs-compatible JSON wire format) can avoid duplicating logic.
pub(crate) fn __parse_for_rapidsnark(
    proof_bytes: &[u8],
    public_bytes: &[u8],
    witness: &TransferWitness,
) -> Result<ProofBundle> {
    parse_snarkjs_outputs(proof_bytes, public_bytes, witness)
}

fn parse_snarkjs_outputs(
    proof_bytes: &[u8],
    public_bytes: &[u8],
    witness: &TransferWitness,
) -> Result<ProofBundle> {
    let proof: SnarkjsProofJson = serde_json::from_slice(proof_bytes)?;
    let publics: Vec<String> = serde_json::from_slice(public_bytes)?;

    // --- G1: A ---
    if proof.pi_a.len() < 2 {
        return Err(Error::ProofSerializeError("pi_a too short".into()));
    }
    let ax = field_str_to_be_bytes_32(&proof.pi_a[0])?;
    let ay = field_str_to_be_bytes_32(&proof.pi_a[1])?;
    let mut a_uncompressed = [0u8; 64];
    a_uncompressed[..32].copy_from_slice(&ax);
    a_uncompressed[32..].copy_from_slice(&ay);
    // Critical: groth16-solana expects -A.
    let a_negated = negate_g1_a(a_uncompressed)?;

    // --- G2: B ---
    // snarkjs orders Fp2 elements as [c0, c1]. groth16-solana / arkworks
    // also uses [c0, c1]; on-chain layout is [x0||x1||y0||y1] big-endian.
    if proof.pi_b.len() < 2 || proof.pi_b[0].len() < 2 || proof.pi_b[1].len() < 2 {
        return Err(Error::ProofSerializeError("pi_b malformed".into()));
    }
    let bx0 = field_str_to_be_bytes_32(&proof.pi_b[0][0])?;
    let bx1 = field_str_to_be_bytes_32(&proof.pi_b[0][1])?;
    let by0 = field_str_to_be_bytes_32(&proof.pi_b[1][0])?;
    let by1 = field_str_to_be_bytes_32(&proof.pi_b[1][1])?;
    let mut b_uncompressed = [0u8; 128];
    b_uncompressed[0..32].copy_from_slice(&bx0);
    b_uncompressed[32..64].copy_from_slice(&bx1);
    b_uncompressed[64..96].copy_from_slice(&by0);
    b_uncompressed[96..128].copy_from_slice(&by1);

    // --- G1: C ---
    if proof.pi_c.len() < 2 {
        return Err(Error::ProofSerializeError("pi_c too short".into()));
    }
    let cx = field_str_to_be_bytes_32(&proof.pi_c[0])?;
    let cy = field_str_to_be_bytes_32(&proof.pi_c[1])?;
    let mut c_uncompressed = [0u8; 64];
    c_uncompressed[..32].copy_from_slice(&cx);
    c_uncompressed[32..].copy_from_slice(&cy);

    let groth = Groth16Proof {
        a: a_negated,
        b: b_uncompressed,
        c: c_uncompressed,
    };

    // --- Public inputs ---
    //
    // Field order from the SPEC:
    //   [root, in_nf_0, in_nf_1, out_cm_0, out_cm_1, public_amount, asset_id, ext_data_hash]
    //
    // The circuit arity is fixed at 2 inputs / 2 outputs for the v0
    // transfer; future arities will rev the circuit and bump this
    // crate. We validate length here defensively.
    const EXPECTED_PUBLICS: usize = 8;
    if publics.len() != EXPECTED_PUBLICS {
        return Err(Error::ProofSerializeError(format!(
            "expected {EXPECTED_PUBLICS} public signals, got {}",
            publics.len()
        )));
    }

    let root = MerkleRoot(read_field(&publics[0])?);
    let in_nf_0 = Nullifier(read_field(&publics[1])?);
    let in_nf_1 = Nullifier(read_field(&publics[2])?);
    let out_cm_0 = Commitment(read_field(&publics[3])?);
    let out_cm_1 = Commitment(read_field(&publics[4])?);
    let public_amount = read_field(&publics[5])?;
    let asset_id = AssetId(read_field(&publics[6])?);
    let ext_data_hash: FieldBytes = read_field(&publics[7])?;

    // Cross-check: the witness-declared asset_id and public_amount should
    // match what the circuit produced. (We're permissive about
    // public_amount sign because the circuit emits the canonical-form
    // field value; we just copy the i128 from the witness.)
    if asset_id != witness.asset_id {
        return Err(Error::WitnessInvalid(format!(
            "asset_id mismatch witness={} circuit={}",
            hex::encode(witness.asset_id.0),
            hex::encode(asset_id.0)
        )));
    }
    // Suppress unused; we keep it for forward compatibility:
    let _ = public_amount;

    let public_inputs = PublicInputs {
        root,
        input_nullifiers: vec![in_nf_0, in_nf_1],
        output_commitments: vec![out_cm_0, out_cm_1],
        public_amount: witness.public_amount,
        asset_id,
        ext_data_hash,
    };

    Ok(ProofBundle {
        proof: groth,
        public_inputs,
    })
}

fn read_field(s: &str) -> Result<FieldBytes> {
    field_str_to_be_bytes_32(s)
}

// stderr redaction lives in the shared `crate::backend::redact` module so
// both this backend and the rapidsnark backend route stderr through the
// same logic (which also neutralizes the JSON byte-array form of the key).

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_pi_a() {
        let j = serde_json::json!({
            "pi_a": ["1", "2", "1"],
            "pi_b": [["1", "0"], ["1", "0"], ["1", "0"]],
            "pi_c": ["1", "2", "1"]
        });
        let v: SnarkjsProofJson = serde_json::from_value(j).unwrap();
        assert_eq!(v.pi_a.len(), 3);
        assert_eq!(v.pi_b.len(), 3);
        assert_eq!(v.pi_c.len(), 3);
    }

    /// The prove path must emit circom input.json: DECIMAL STRINGS under the
    /// circuit's signal names — not a verbatim serde dump of the witness
    /// (Rust field names + 32-element byte arrays), which snarkjs rejects and
    /// whose echoed stderr leaked the spending key.
    #[test]
    fn circom_input_uses_signal_names_and_decimal_strings_not_byte_arrays() {
        // Field elements must be < the BN254 modulus, so keep them small
        // (leading bytes zero) — Poseidon rejects inputs ≥ p.
        let mut asset_bytes = [0u8; 32];
        asset_bytes[31] = 0xAA;
        let asset = AssetId(asset_bytes);
        let owner_sk: FieldBytes = [7u8; 32];
        let note = said_shielded_pool_types::Note {
            amount: 1000,
            asset_id: asset,
            owner_pubkey: [0u8; 32],
            blinding: [3u8; 32],
        };
        // Deposit: no real inputs, one real output, public_amount = -1000.
        let w = TransferWitness {
            input_notes: vec![],
            input_paths: vec![],
            input_indices: vec![],
            output_notes: vec![note],
            spending_key: owner_sk,
            public_amount: -1000,
            asset_id: asset,
            ext_data_hash: [0u8; 32],
        };

        let v = circom_input_from_witness(&w).unwrap();
        let obj = v.as_object().expect("input.json must be a JSON object");

        // Circuit signal names present.
        for sig in [
            "root",
            "inputNullifier",
            "outputCommitment",
            "publicAmount",
            "publicAmountIsNeg",
            "publicAmountMagnitude",
            "assetId",
            "extDataHash",
            "inAmount",
            "inBlinding",
            "inPrivateKey",
            "inLeafIndex",
            "inPathElements",
            "outAmount",
            "outBlinding",
            "outOwnerPubkey",
        ] {
            assert!(obj.contains_key(sig), "missing circuit signal `{sig}`");
        }
        // Verbatim Rust witness field names must be ABSENT.
        for f in ["spending_key", "input_notes", "output_notes", "input_paths"] {
            assert!(!obj.contains_key(f), "leaked Rust field `{f}`");
        }

        // Scalars are decimal strings; path is [TREE_DEPTH] of strings.
        assert!(v["assetId"].is_string());
        assert!(v["root"].is_string());
        assert!(v["inputNullifier"][0].is_string());
        let path0 = v["inPathElements"][0].as_array().expect("path is array");
        assert_eq!(path0.len(), TREE_DEPTH);
        assert!(path0[0].is_string());

        // The spending key must not appear anywhere as a JSON byte array.
        let dump = serde_json::to_string(&v).unwrap();
        assert!(
            !dump.contains("[7,7,7,7,7,7,7,7"),
            "spending key leaked as byte array"
        );

        // H1 signed-amount hints reflect the deposit sign (publicAmount<0).
        assert_eq!(v["publicAmountIsNeg"], "1");
        assert_eq!(v["publicAmountMagnitude"], "1000");
    }
}
