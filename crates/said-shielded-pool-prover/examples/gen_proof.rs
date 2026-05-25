//! `gen_proof` — canonical Rust pipeline for generating shielded-pool proofs.
//!
//! Replaces the legacy node/circomlibjs script
//! `crates/said-shielded-pool-circuits/circuits/tools/build_deposit_input.js`.
//!
//! Pipeline:
//!   1. Build a `TransferWitness` from the chosen scenario + CLI flags.
//!   2. Render the snarkjs-compatible `input.json` via `prover::witness`.
//!   3. Spawn `snarkjs wtns calculate` + `snarkjs groth16 prove` to
//!      produce `proof.json` + `public.json`.
//!   4. Convert the snarkjs output to the on-chain `groth16-solana` wire
//!      format (negated G1, BE-32, G2 c1||c0) and emit
//!      `proof_bundle.onchain.json`.
//!
//! Usage:
//!   cargo run -p said-shielded-pool-prover --example gen_proof -- \
//!       --scenario deposit \
//!       --amount 1000 \
//!       --asset-id <hex32> \
//!       --owner-sk 12345 \
//!       --owner-blinding 99999 \
//!       --out-dir ./out
//!
//! Outputs (all in --out-dir):
//!   * input.json                — snarkjs input
//!   * proof.json, public.json   — snarkjs raw outputs
//!   * proof_bundle.onchain.json — Solana-ready hex-encoded bundle

use std::path::{Path, PathBuf};
use std::process::Command;

use clap::{Parser, ValueEnum};
use num_bigint::BigUint;
use said_shielded_pool_prover::onchain_format::{build_onchain_proof, onchain_proof_to_json};
use said_shielded_pool_prover::witness::{build_input_json, derive_pubkey};
use said_shielded_pool_types::{AssetId, MerklePath, Note, TransferWitness, TREE_DEPTH};
use serde_json::Value;

#[derive(Copy, Clone, Debug, ValueEnum)]
enum Scenario {
    /// 2 dummy in, 1 real out + 1 dummy out, public_amount = -amount (mod p).
    Deposit,
    /// 2 real in, 2 real out; requires --witness-config supplying inputs+paths.
    Transfer2In2Out,
    /// 1 real in, 0 real outs; public_amount = +amount (full withdraw, no
    /// change). Requires --witness-config.
    Withdraw,
}

#[derive(Parser, Debug)]
#[command(name = "gen_proof", about = "Canonical Rust pipeline for shielded-pool Groth16 proofs")]
struct Cli {
    /// Scenario to generate.
    #[arg(long)]
    scenario: Scenario,

    /// Output directory (will be created).
    #[arg(long)]
    out_dir: PathBuf,

    /// Decimal amount (interpretation depends on scenario).
    #[arg(long, default_value_t = 1000u64)]
    amount: u64,

    /// Asset id as 32-byte hex (the raw Poseidon1(mint) BE bytes).
    /// For the deposit demo defaults to `11..11` (matches build_deposit_input.js).
    #[arg(long, default_value = "1111111111111111111111111111111111111111111111111111111111111111")]
    asset_id: String,

    /// Owner spending key — decimal field-string. Default 12345.
    #[arg(long, default_value = "12345")]
    owner_sk: String,

    /// Owner blinding for the (single) real output — decimal string. Default 99999.
    #[arg(long, default_value = "99999")]
    owner_blinding: String,

    /// For transfer/withdraw: JSON file describing the full witness:
    ///   {
    ///     "input_notes":[{amount, blinding(hex32), leaf_index, sk(hex32)}, …],
    ///     "input_paths":[{siblings:[hex32…], path_bits:[bool…]}, …],
    ///     "output_notes":[{amount, blinding(hex32), owner_pubkey(hex32)}, …],
    ///     "public_amount": i128,
    ///     "ext_data_hash": hex32
    ///   }
    /// Overrides --amount / --owner-* when set.
    #[arg(long)]
    witness_config: Option<PathBuf>,

    /// Indexer URL for fetching witness paths. (TODO: not wired into the
    /// transfer scenario yet — supply --witness-config instead.)
    #[arg(long)]
    indexer_url: Option<String>,

    /// Path to the `snarkjs` CLI. Defaults to the local install under the
    /// circuits crate; falls back to `snarkjs` on PATH.
    #[arg(long)]
    snarkjs: Option<PathBuf>,

    /// Path to the circuit artifacts directory. Defaults to
    /// `crates/said-shielded-pool-circuits/artifacts/`.
    #[arg(long)]
    artifacts_dir: Option<PathBuf>,

    /// Path to the proving key (zkey). Defaults to
    /// `crates/said-shielded-pool-circuits/ceremony/transaction_final.zkey`.
    #[arg(long)]
    zkey: Option<PathBuf>,
}

fn parse_field_hex32(s: &str) -> [u8; 32] {
    let s = s.trim().trim_start_matches("0x").trim_start_matches("0X");
    let bytes = hex::decode(s).expect("asset_id must be hex");
    assert!(
        bytes.len() <= 32,
        "asset_id must be ≤ 32 bytes (got {})",
        bytes.len()
    );
    let mut out = [0u8; 32];
    out[32 - bytes.len()..].copy_from_slice(&bytes);
    out
}

fn parse_decimal_field(s: &str) -> [u8; 32] {
    let n: BigUint = s.parse().expect("decimal field");
    let bytes = n.to_bytes_be();
    assert!(bytes.len() <= 32, "decimal field overflows 32 bytes");
    let mut out = [0u8; 32];
    out[32 - bytes.len()..].copy_from_slice(&bytes);
    out
}

/// Parse either `0x…hex…` or a decimal string into a 32-byte BE field.
fn parse_field_any(s: &str) -> [u8; 32] {
    if s.starts_with("0x") || s.starts_with("0X") {
        parse_field_hex32(s)
    } else if s.chars().all(|c| c.is_ascii_digit()) {
        parse_decimal_field(s)
    } else {
        // Assume hex without prefix
        parse_field_hex32(s)
    }
}

fn workspace_root() -> PathBuf {
    // CARGO_MANIFEST_DIR points to crates/said-shielded-pool-prover; root is two levels up.
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf()
}

fn default_artifacts_dir() -> PathBuf {
    workspace_root().join("crates/said-shielded-pool-circuits/artifacts")
}

fn default_zkey() -> PathBuf {
    workspace_root().join("crates/said-shielded-pool-circuits/ceremony/transaction_final.zkey")
}

fn resolve_snarkjs(cli: &Cli) -> PathBuf {
    if let Some(p) = &cli.snarkjs {
        return p.clone();
    }
    // Prefer the local install under the circuits crate.
    let local = workspace_root()
        .join("crates/said-shielded-pool-circuits/circuits/node_modules/.bin/snarkjs");
    if local.exists() {
        return local;
    }
    PathBuf::from("snarkjs")
}

fn run(cmd: &mut Command, label: &str) {
    let out = cmd.output().expect("spawn snarkjs");
    if !out.status.success() {
        eprintln!("--- {label} stdout ---\n{}", String::from_utf8_lossy(&out.stdout));
        eprintln!("--- {label} stderr ---\n{}", String::from_utf8_lossy(&out.stderr));
        panic!("{label} failed with status {}", out.status);
    }
    // Pass through snarkjs's chatty stdout so users can see progress.
    let s = String::from_utf8_lossy(&out.stdout);
    if !s.is_empty() {
        println!("{s}");
    }
}

fn build_deposit_witness(cli: &Cli) -> (TransferWitness, Vec<[u8; 32]>) {
    let asset = parse_field_hex32(&cli.asset_id);
    let sk = parse_field_any(&cli.owner_sk);
    let blinding = parse_field_any(&cli.owner_blinding);
    let owner = derive_pubkey(&sk);

    let note = Note {
        amount: cli.amount,
        asset_id: AssetId(asset),
        owner_pubkey: owner,
        blinding,
    };

    let w = TransferWitness {
        input_notes: vec![],
        input_paths: vec![],
        input_indices: vec![],
        output_notes: vec![note],
        spending_key: sk,
        // Deposit convention from the legacy node script: public_amount =
        // -DEPOSIT_AMOUNT (mod p). We store the i128 signed value; the
        // witness builder encodes it as `p - amount` when emitting JSON.
        public_amount: -(cli.amount as i128),
        asset_id: AssetId(asset),
        ext_data_hash: [0u8; 32],
    };
    (w, vec![sk])
}

/// Witness config loader for transfer / withdraw scenarios. Returns
/// (witness, per-input sks).
fn load_witness_config(path: &Path, public_amount: i128) -> (TransferWitness, Vec<[u8; 32]>) {
    let raw = std::fs::read_to_string(path).expect("read witness config");
    let v: Value = serde_json::from_str(&raw).expect("witness config JSON");

    let asset = parse_field_hex32(v["asset_id"].as_str().expect("asset_id"));
    let ext = if let Some(s) = v.get("ext_data_hash").and_then(|x| x.as_str()) {
        parse_field_hex32(s)
    } else {
        [0u8; 32]
    };
    let pa = v
        .get("public_amount")
        .and_then(|x| x.as_i64())
        .map(|x| x as i128)
        .unwrap_or(public_amount);

    let mut sks = Vec::new();
    let mut input_notes = Vec::new();
    let mut input_paths = Vec::new();
    let mut input_indices = Vec::new();
    for n in v["input_notes"].as_array().cloned().unwrap_or_default() {
        let amount = n["amount"].as_u64().unwrap_or(0);
        let blinding = parse_field_hex32(n["blinding"].as_str().expect("blinding"));
        let idx = n["leaf_index"].as_u64().unwrap_or(0);
        let sk = parse_field_any(n["sk"].as_str().expect("sk"));
        let owner = derive_pubkey(&sk);
        input_notes.push(Note {
            amount,
            asset_id: AssetId(asset),
            owner_pubkey: owner,
            blinding,
        });
        sks.push(sk);
        input_indices.push(idx);
    }
    for p in v["input_paths"].as_array().cloned().unwrap_or_default() {
        let siblings: Vec<[u8; 32]> = p["siblings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| parse_field_any(s.as_str().unwrap()))
            .collect();
        assert_eq!(siblings.len(), TREE_DEPTH);
        let path_bits: Vec<bool> = p["path_bits"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b.as_bool().unwrap())
            .collect();
        assert_eq!(path_bits.len(), TREE_DEPTH);
        input_paths.push(MerklePath {
            siblings,
            path_bits,
        });
    }
    let mut output_notes = Vec::new();
    for n in v["output_notes"].as_array().cloned().unwrap_or_default() {
        let amount = n["amount"].as_u64().unwrap_or(0);
        let blinding = parse_field_hex32(n["blinding"].as_str().expect("blinding"));
        let owner = parse_field_hex32(n["owner_pubkey"].as_str().expect("owner_pubkey"));
        output_notes.push(Note {
            amount,
            asset_id: AssetId(asset),
            owner_pubkey: owner,
            blinding,
        });
    }

    let spending_key = sks.first().copied().unwrap_or([0u8; 32]);
    let w = TransferWitness {
        input_notes,
        input_paths,
        input_indices,
        output_notes,
        spending_key,
        public_amount: pa,
        asset_id: AssetId(asset),
        ext_data_hash: ext,
    };
    (w, sks)
}

fn main() {
    let cli = Cli::parse();

    std::fs::create_dir_all(&cli.out_dir).expect("create out_dir");
    let artifacts = cli
        .artifacts_dir
        .clone()
        .unwrap_or_else(default_artifacts_dir);
    let wasm = artifacts.join("transaction_js/transaction.wasm");
    let vk_path = artifacts.join("verification_key.json");
    let zkey = cli.zkey.clone().unwrap_or_else(default_zkey);

    assert!(
        wasm.exists(),
        "wasm not found at {}; build circuits first",
        wasm.display()
    );
    assert!(
        zkey.exists(),
        "zkey not found at {}; build ceremony first",
        zkey.display()
    );
    assert!(
        vk_path.exists(),
        "verification_key.json not found at {}",
        vk_path.display()
    );

    // 1. Build the witness.
    let (witness, sks) = match cli.scenario {
        Scenario::Deposit => build_deposit_witness(&cli),
        Scenario::Transfer2In2Out => {
            let cfg = cli
                .witness_config
                .clone()
                .expect("--witness-config is required for transfer_2in_2out");
            load_witness_config(&cfg, 0)
        }
        Scenario::Withdraw => {
            let cfg = cli.witness_config.clone().expect(
                "--witness-config is required for withdraw (must include input note + Merkle path)",
            );
            // For withdraw the default public_amount is +amount; the config
            // can still override.
            load_witness_config(&cfg, cli.amount as i128)
        }
    };

    if cli.indexer_url.is_some() {
        eprintln!(
            "warning: --indexer-url is accepted but not yet wired; pass --witness-config instead."
        );
    }

    // 2. Render snarkjs input.json.
    let input = build_input_json(&witness, &sks);
    let input_path = cli.out_dir.join("input.json");
    std::fs::write(&input_path, serde_json::to_vec_pretty(&input).unwrap())
        .expect("write input.json");
    println!("wrote {}", input_path.display());

    // 3. Spawn snarkjs to compute witness + prove.
    let snarkjs = resolve_snarkjs(&cli);
    let witness_wtns = cli.out_dir.join("witness.wtns");
    let proof_path = cli.out_dir.join("proof.json");
    let public_path = cli.out_dir.join("public.json");

    println!("[1/2] snarkjs wtns calculate …");
    run(
        Command::new(&snarkjs).args([
            "wtns",
            "calculate",
            wasm.to_str().unwrap(),
            input_path.to_str().unwrap(),
            witness_wtns.to_str().unwrap(),
        ]),
        "snarkjs wtns calculate",
    );

    println!("[2/2] snarkjs groth16 prove …");
    run(
        Command::new(&snarkjs).args([
            "groth16",
            "prove",
            zkey.to_str().unwrap(),
            witness_wtns.to_str().unwrap(),
            proof_path.to_str().unwrap(),
            public_path.to_str().unwrap(),
        ]),
        "snarkjs groth16 prove",
    );

    // 4. Convert to on-chain wire format.
    let proof_json: Value =
        serde_json::from_str(&std::fs::read_to_string(&proof_path).unwrap()).unwrap();
    let public_json: Value =
        serde_json::from_str(&std::fs::read_to_string(&public_path).unwrap()).unwrap();
    let onchain = build_onchain_proof(&proof_json, &public_json);
    let bundle = onchain_proof_to_json(&onchain);
    let bundle_path = cli.out_dir.join("proof_bundle.onchain.json");
    std::fs::write(&bundle_path, serde_json::to_vec_pretty(&bundle).unwrap())
        .expect("write proof bundle");

    println!("\n✓ outputs in {}:", cli.out_dir.display());
    println!("    input.json");
    println!("    proof.json");
    println!("    public.json");
    println!("    proof_bundle.onchain.json   ({} public inputs)", onchain.public_inputs.len());

    println!("\nTo verify with snarkjs:");
    println!(
        "  snarkjs groth16 verify {} {} {}",
        vk_path.display(),
        public_path.display(),
        proof_path.display()
    );
}
