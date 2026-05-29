//! Backwards-compatible environment-variable lookup for the `ghola-*`
//! rebrand.
//!
//! The crates were renamed from `thumper-*`/`orni-models-*` to `ghola-*`
//! and their env-var prefixes migrated `THUMPER_*`/`ORNI_*` → `GHOLA_*`.
//! Live deployments (Render/Fly dashboards) still hold the legacy names,
//! which we cannot edit from the repo. To avoid breaking running services
//! on the next deploy, readers prefer the new `GHOLA_*` name but fall back
//! to the legacy name, emitting a one-time deprecation notice on stderr.
//!
//! Drop-in for `std::env::var`: returns the same `Result<String, VarError>`
//! so existing `.ok()`/`.expect()`/`.map()` call sites keep working.

use std::env::{self, VarError};

/// Read `new_key`, falling back to `legacy_key` (with a deprecation notice)
/// when the new name is unset. If both are unset, returns the `VarError`
/// for the new name so error messages point operators at the current name.
pub fn env_compat(new_key: &str, legacy_key: &str) -> Result<String, VarError> {
    match env::var(new_key) {
        Ok(v) => Ok(v),
        Err(new_err) => match env::var(legacy_key) {
            Ok(v) => {
                eprintln!(
                    "[ghola] DEPRECATION: env var `{legacy_key}` is deprecated; \
                     rename it to `{new_key}`. Honoring the legacy name for now."
                );
                Ok(v)
            }
            Err(_) => Err(new_err),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::env_compat;

    // Uses process-unique key names so the tests don't collide with each
    // other or with ambient environment state.
    #[test]
    fn prefers_new_key() {
        // SAFETY: test-only, single-threaded access to these unique keys.
        unsafe {
            std::env::set_var("GHOLA_EC_T1", "new");
            std::env::set_var("THUMPER_EC_T1", "legacy");
        }
        assert_eq!(env_compat("GHOLA_EC_T1", "THUMPER_EC_T1").unwrap(), "new");
    }

    #[test]
    fn falls_back_to_legacy() {
        unsafe {
            std::env::remove_var("GHOLA_EC_T2");
            std::env::set_var("THUMPER_EC_T2", "legacy");
        }
        assert_eq!(env_compat("GHOLA_EC_T2", "THUMPER_EC_T2").unwrap(), "legacy");
    }

    #[test]
    fn errors_when_both_unset() {
        unsafe {
            std::env::remove_var("GHOLA_EC_T3");
            std::env::remove_var("THUMPER_EC_T3");
        }
        assert!(env_compat("GHOLA_EC_T3", "THUMPER_EC_T3").is_err());
    }
}
