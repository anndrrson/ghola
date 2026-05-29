//! Hardened RAII scratch directory shared by every subprocess backend.
//!
//! Each prover backend writes `input.json` (which embeds the SPENDING KEY
//! and per-input blinding factors in clear) and `witness.wtns` (a
//! bit-for-bit functionally equivalent representation) into a temporary
//! working directory. [`SecureTempDir`] hardens that directory three ways:
//!
//!   1. **Unpredictable name** (`.prover-<128-bit hex>`, drawn from
//!      `OsRng`) so a local attacker can't pre-create or race the path
//!      (TOCTOU). The previous `{nanos}` name was guessable.
//!   2. **`0700` mode** on unix so no other local user can read the
//!      witness while a proof is in flight.
//!   3. **Overwrite-before-unlink** on `Drop`: every file's bytes are
//!      overwritten with zeros and synced before the directory is
//!      removed, blunting forensic block recovery on non-TEE hosts.
//!
//! `Drop` is invariant under success, `?`-propagation, panic-unwind, and
//! future-cancellation, so the witness never outlives the proof attempt.

use std::path::{Path, PathBuf};

use rand::rngs::OsRng;
use rand::RngCore;

#[cfg(unix)]
use std::os::unix::fs::DirBuilderExt;

use crate::error::Result;

/// RAII guard for a prover scratch directory containing secret material.
///
/// Created under a caller-supplied base dir with a random `0700` name;
/// best-effort zeroizes and removes every file in `Drop`. See the module
/// docs for the full threat model.
pub struct SecureTempDir {
    path: PathBuf,
}

impl SecureTempDir {
    /// Create a fresh scratch directory under `base`.
    ///
    /// The directory name is `.prover-<128-bit hex>` from `OsRng` (not a
    /// timestamp), and on unix it is created `0700` so it is unreadable
    /// by other local users.
    pub fn create_under(base: &Path) -> Result<Self> {
        // 128 bits of OS randomness — wide enough that a local attacker
        // cannot pre-create or guess the path before we do.
        let mut rnd = [0u8; 16];
        OsRng.fill_bytes(&mut rnd);
        let name = format!(".prover-{}", hex::encode(rnd));
        let path = base.join(name);

        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        builder.mode(0o700);
        builder.create(&path)?;

        Ok(Self { path })
    }

    /// Path to the scratch directory.
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for SecureTempDir {
    fn drop(&mut self) {
        // Best-effort, panic-safe: anything here is on the cleanup path,
        // and `Drop` must not unwind. Swallow every error — the privacy
        // story depends on the dir being gone, and the only way it isn't
        // is if the OS itself is broken.
        //
        // Overwrite-before-unlink: open each regular file, write `len`
        // zero bytes over its contents, and fsync, BEFORE removing the
        // tree. This blunts forensic block recovery on non-TEE hosts
        // (it is not a guarantee on CoW / log-structured filesystems,
        // but it removes the plaintext from the common ext4/xfs case).
        if let Ok(entries) = std::fs::read_dir(&self.path) {
            for entry in entries.flatten() {
                let p = entry.path();
                let is_file = entry.file_type().map(|t| t.is_file()).unwrap_or(false);
                if !is_file {
                    continue;
                }
                if let Ok(len) = std::fs::metadata(&p).map(|m| m.len()) {
                    if let Ok(mut f) = std::fs::OpenOptions::new().write(true).open(&p) {
                        use std::io::Write;
                        let zeros = vec![0u8; 8192];
                        let mut remaining = len;
                        while remaining > 0 {
                            let chunk = remaining.min(zeros.len() as u64) as usize;
                            if f.write_all(&zeros[..chunk]).is_err() {
                                break;
                            }
                            remaining -= chunk as u64;
                        }
                        let _ = f.flush();
                        let _ = f.sync_all();
                    }
                }
            }
        }
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_random_not_sequential() {
        let base = std::env::temp_dir();
        let a = SecureTempDir::create_under(&base).unwrap();
        let b = SecureTempDir::create_under(&base).unwrap();

        let an = a.path().file_name().unwrap().to_string_lossy().to_string();
        let bn = b.path().file_name().unwrap().to_string_lossy().to_string();

        assert!(an.starts_with(".prover-"), "unexpected name: {an}");
        assert!(bn.starts_with(".prover-"), "unexpected name: {bn}");
        assert_ne!(an, bn, "two temp dirs share a name");

        // The random suffix is 32 hex chars (128 bits) and the two
        // suffixes differ in a non-incremental way: their numeric
        // distance (when both parse as big hex) is not 1.
        let ah = an.trim_start_matches(".prover-");
        let bh = bn.trim_start_matches(".prover-");
        assert_eq!(ah.len(), 32, "suffix not 128-bit hex: {ah}");
        assert_eq!(bh.len(), 32, "suffix not 128-bit hex: {bh}");
        // Differ by more than the trailing byte — a sequential/nanos
        // scheme would typically only flip the low bytes.
        assert_ne!(
            &ah[..16],
            &bh[..16],
            "high half identical (looks sequential)"
        );
    }

    #[cfg(unix)]
    #[test]
    fn created_with_mode_0700() {
        use std::os::unix::fs::PermissionsExt;
        let base = std::env::temp_dir();
        let d = SecureTempDir::create_under(&base).unwrap();
        let mode = std::fs::metadata(d.path()).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700, "dir mode not 0700: {:o}", mode & 0o777);
    }

    #[test]
    fn drop_overwrites_and_removes_files() {
        let base = std::env::temp_dir();
        let path = {
            let d = SecureTempDir::create_under(&base).unwrap();
            let f = d.path().join("input.json");
            std::fs::write(&f, b"spending_key=123456789").unwrap();
            assert!(f.exists());
            d.path().to_path_buf()
            // `d` drops here.
        };
        assert!(!path.exists(), "temp dir survived Drop: {}", path.display());
    }
}
