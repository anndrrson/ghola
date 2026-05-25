//! Wire-format DTOs used by the HTTP layer.
//!
//! The shared types crate's `Groth16Proof` and `ProofBundle` carry
//! fixed-size byte arrays larger than 32 bytes (`[u8; 64]`, `[u8; 128]`),
//! which serde's default derives can't handle without `serde-big-array`.
//! Rather than pull in that dep — or modify the types crate from this
//! Phase 37 PR — we hex-encode the proof bytes on the wire and convert
//! at the edges of the HTTP handlers.
//!
//! Witness payloads contain only `[u8; 32]` fields and primitives, so
//! we transcode through `serde_json::Value` for them.

use said_shielded_pool_types::{
    AssetId, Commitment, FieldBytes, ForesterProofBundle, ForesterPublicInputs, Groth16Proof,
    MerkleRoot, Nullifier, ProofBundle, PublicInputs, TransferWitness,
};
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// Hex-encoded `ProofBundle` for the wire.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProofBundleWire {
    /// 128 hex chars (64 bytes): G1 `A` point, big-endian, ALREADY NEGATED
    /// to match `groth16-solana`'s pairing check.
    pub a: String,
    /// 256 hex chars (128 bytes): G2 `B` point.
    pub b: String,
    /// 128 hex chars (64 bytes): G1 `C` point.
    pub c: String,

    /// Public inputs, hex-encoded field elements (64 chars each = 32 bytes).
    pub root: String,
    pub input_nullifiers: Vec<String>,
    pub output_commitments: Vec<String>,
    pub public_amount: i128,
    pub asset_id: String,
    pub ext_data_hash: String,
}

impl ProofBundleWire {
    pub fn from_bundle(b: &ProofBundle) -> Self {
        Self {
            a: hex::encode(b.proof.a),
            b: hex::encode(b.proof.b),
            c: hex::encode(b.proof.c),
            root: hex::encode(b.public_inputs.root.0),
            input_nullifiers: b
                .public_inputs
                .input_nullifiers
                .iter()
                .map(|n| hex::encode(n.0))
                .collect(),
            output_commitments: b
                .public_inputs
                .output_commitments
                .iter()
                .map(|c| hex::encode(c.0))
                .collect(),
            public_amount: b.public_inputs.public_amount,
            asset_id: hex::encode(b.public_inputs.asset_id.0),
            ext_data_hash: hex::encode(b.public_inputs.ext_data_hash),
        }
    }

    pub fn into_bundle(self) -> Result<ProofBundle> {
        let a = hex_to_64(&self.a)?;
        let b = hex_to_128(&self.b)?;
        let c = hex_to_64(&self.c)?;
        Ok(ProofBundle {
            proof: Groth16Proof { a, b, c },
            public_inputs: PublicInputs {
                root: MerkleRoot(hex_to_32(&self.root)?),
                input_nullifiers: self
                    .input_nullifiers
                    .iter()
                    .map(|s| hex_to_32(s).map(Nullifier))
                    .collect::<Result<Vec<_>>>()?,
                output_commitments: self
                    .output_commitments
                    .iter()
                    .map(|s| hex_to_32(s).map(Commitment))
                    .collect::<Result<Vec<_>>>()?,
                public_amount: self.public_amount,
                asset_id: AssetId(hex_to_32(&self.asset_id)?),
                ext_data_hash: hex_to_32(&self.ext_data_hash)?,
            },
        })
    }
}

/// Wire-format witness. Inner fields are 32-byte arrays that DO get
/// auto-derived serde impls, so we accept the raw JSON shape and just
/// transcode via `serde_json::Value`.
pub fn witness_from_json(v: serde_json::Value) -> Result<TransferWitness> {
    serde_json::from_value(v).map_err(|e| Error::WitnessInvalid(e.to_string()))
}

/// Hex-encoded `ForesterProofBundle` for the wire. Mirrors `ProofBundleWire`
/// but with the forester public-input shape.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ForesterProofBundleWire {
    pub a: String,
    pub b: String,
    pub c: String,
    pub old_root: String,
    pub new_root: String,
    pub start_index: u64,
    pub commitments: Vec<String>,
}

impl ForesterProofBundleWire {
    pub fn from_bundle(b: &ForesterProofBundle) -> Self {
        Self {
            a: hex::encode(b.proof.a),
            b: hex::encode(b.proof.b),
            c: hex::encode(b.proof.c),
            old_root: hex::encode(b.public_inputs.old_root.0),
            new_root: hex::encode(b.public_inputs.new_root.0),
            start_index: b.public_inputs.start_index,
            commitments: b
                .public_inputs
                .commitments
                .iter()
                .map(|c| hex::encode(c.0))
                .collect(),
        }
    }

    pub fn into_bundle(self) -> Result<ForesterProofBundle> {
        let a = hex_to_64(&self.a)?;
        let b = hex_to_128(&self.b)?;
        let c = hex_to_64(&self.c)?;
        Ok(ForesterProofBundle {
            proof: Groth16Proof { a, b, c },
            public_inputs: ForesterPublicInputs {
                old_root: MerkleRoot(hex_to_32(&self.old_root)?),
                new_root: MerkleRoot(hex_to_32(&self.new_root)?),
                start_index: self.start_index,
                commitments: self
                    .commitments
                    .iter()
                    .map(|s| hex_to_32(s).map(Commitment))
                    .collect::<Result<Vec<_>>>()?,
            },
        })
    }
}

// --- helpers ---

fn hex_to_32(s: &str) -> Result<FieldBytes> {
    let bytes = hex::decode(s).map_err(|e| Error::ProofSerializeError(format!("hex: {e}")))?;
    if bytes.len() != 32 {
        return Err(Error::ProofSerializeError(format!(
            "expected 32 bytes, got {}",
            bytes.len()
        )));
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    Ok(out)
}

fn hex_to_64(s: &str) -> Result<[u8; 64]> {
    let bytes = hex::decode(s).map_err(|e| Error::ProofSerializeError(format!("hex: {e}")))?;
    if bytes.len() != 64 {
        return Err(Error::ProofSerializeError(format!(
            "expected 64 bytes, got {}",
            bytes.len()
        )));
    }
    let mut out = [0u8; 64];
    out.copy_from_slice(&bytes);
    Ok(out)
}

fn hex_to_128(s: &str) -> Result<[u8; 128]> {
    let bytes = hex::decode(s).map_err(|e| Error::ProofSerializeError(format!("hex: {e}")))?;
    if bytes.len() != 128 {
        return Err(Error::ProofSerializeError(format!(
            "expected 128 bytes, got {}",
            bytes.len()
        )));
    }
    let mut out = [0u8; 128];
    out.copy_from_slice(&bytes);
    Ok(out)
}
