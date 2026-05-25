//! [`ScrubbedString`] — a truncated, deterministic redaction of a secret
//! for use in log fields and audit trails where correlation matters but
//! the full value MUST be suppressed.
//!
//! # Threat model
//!
//! Operators NEED to correlate "the relayer's signing key" across log
//! lines and metrics without ever emitting the actual key. A truncated
//! hex prefix gives 24 bits of entropy (3 hex bytes = 6 chars), which
//! is enough to disambiguate every key your fleet will ever hold while
//! being computationally infeasible to invert.
//!
//! # Example
//!
//! ```
//! use common_secrets::{ScrubbedString, SecretBytes};
//! let mut bytes = [0u8; 32];
//! bytes[0] = 0xDE; bytes[1] = 0xAD; bytes[2] = 0xBE; bytes[3] = 0xEF;
//! let k = SecretBytes::<32>::new(bytes);
//! let tag = ScrubbedString::from_secret(&k);
//! assert!(tag.as_str().starts_with("deadbe"));
//! assert!(tag.as_str().ends_with("…"));
//! ```

use core::fmt;

use crate::SecretBytes;

/// A short, redacted tag for a secret. Safe to emit at INFO log level.
///
/// Format: first 6 hex characters of the secret followed by `"…"`
/// (Unicode horizontal ellipsis, U+2026). The prefix length is fixed
/// at 6 chars (24 bits) — long enough to disambiguate every key in
/// any plausible fleet, short enough to be infeasible to invert.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScrubbedString(String);

impl ScrubbedString {
    /// Number of hex characters in the visible prefix.
    pub const PREFIX_LEN: usize = 6;

    /// Build from a generic secret.
    pub fn from_secret<const N: usize>(secret: &SecretBytes<N>) -> Self {
        Self::from_bytes(secret.expose_secret())
    }

    /// Build from a raw byte slice (use only at the boundary of a
    /// `Zeroizing` / `SecretBytes` lifetime — the slice itself is not
    /// zeroized).
    pub fn from_bytes(bytes: &[u8]) -> Self {
        if bytes.is_empty() {
            return Self("∅…".into());
        }
        let hex = hex::encode(bytes);
        let take = Self::PREFIX_LEN.min(hex.len());
        let mut s = String::with_capacity(take + 3);
        s.push_str(&hex[..take]);
        s.push('…');
        Self(s)
    }

    /// Borrowed view of the tag (always ASCII-safe except for the
    /// terminating ellipsis).
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ScrubbedString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_to_six_hex_prefix() {
        let mut bytes = [0u8; 32];
        bytes[0] = 0xDE;
        bytes[1] = 0xAD;
        bytes[2] = 0xBE;
        bytes[3] = 0xEF;
        let s = SecretBytes::<32>::new(bytes);
        let tag = ScrubbedString::from_secret(&s);
        assert_eq!(tag.as_str(), "deadbe…");
    }

    #[test]
    fn short_bytes_handled() {
        let tag = ScrubbedString::from_bytes(&[1, 2]);
        assert_eq!(tag.as_str(), "0102…");
    }

    #[test]
    fn empty_handled() {
        let tag = ScrubbedString::from_bytes(&[]);
        assert_eq!(tag.as_str(), "∅…");
    }

    #[test]
    fn display_round_trips() {
        let tag = ScrubbedString::from_bytes(&[0xAB, 0xCD, 0xEF, 0x12]);
        assert_eq!(format!("{tag}"), tag.as_str());
    }
}
