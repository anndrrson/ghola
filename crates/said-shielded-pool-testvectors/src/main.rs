//! `gen-vectors` — write the canonical, deterministic set of shielded-pool
//! test vectors to `crates/said-shielded-pool-testvectors/vectors/`.
//!
//! Run from the workspace root:
//!
//! ```bash
//! cargo run -p said-shielded-pool-testvectors --bin gen-vectors
//! ```
//!
//! Output is reproducible: every run produces byte-for-byte identical JSON
//! files. The RNG is seeded with `said_shielded_pool_testvectors::VECTOR_SEED`
//! (`0xDEADBEEF`), and that seed is offset per-scenario by a constant.

use std::fs;
use std::path::PathBuf;

use said_shielded_pool_testvectors::{scenarios, vector_to_json, VECTOR_SEED};

fn main() -> std::io::Result<()> {
    // The vectors directory lives next to Cargo.toml. We resolve it relative
    // to CARGO_MANIFEST_DIR so the binary works regardless of cwd.
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let out_dir = PathBuf::from(manifest_dir).join("vectors");
    fs::create_dir_all(&out_dir)?;

    let vectors = scenarios::all_scenarios();
    eprintln!(
        "gen-vectors: seed = 0x{:X}, scenarios = {}, output = {}",
        VECTOR_SEED,
        vectors.len(),
        out_dir.display()
    );

    // Also write an index.json listing every vector with its metadata so
    // tools can enumerate without globbing.
    let mut index_entries = Vec::with_capacity(vectors.len());

    for v in &vectors {
        let json = vector_to_json(v);
        let pretty = serde_json::to_string_pretty(&json).expect("vector serializes");
        let path = out_dir.join(format!("{}.json", v.name));
        fs::write(&path, format!("{pretty}\n"))?;
        eprintln!(
            "  wrote {:<48}  should_prove={:<5}  should_verify={}",
            v.name, v.should_prove, v.should_verify
        );

        index_entries.push(serde_json::json!({
            "name": v.name,
            "file": format!("{}.json", v.name),
            "description": v.description,
            "should_prove": v.should_prove,
            "should_verify": v.should_verify,
        }));
    }

    let index = serde_json::json!({
        "seed_hex": format!("0x{:X}", VECTOR_SEED),
        "schema_version": 1,
        "count": vectors.len(),
        "vectors": index_entries,
    });
    let index_path = out_dir.join("index.json");
    fs::write(
        &index_path,
        format!("{}\n", serde_json::to_string_pretty(&index).expect("index")),
    )?;
    eprintln!("  wrote index.json ({} entries)", vectors.len());

    Ok(())
}
