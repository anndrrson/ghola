//! Convenience helpers + macros for emitting redacted log fields.
//!
//! Prefer these at call sites over relying on the layer alone — the
//! layer is defense-in-depth, but explicit redaction at the source is
//! more auditable and survives downstream subscriber reconfiguration.

use common_secrets::ScrubbedString;

/// Tag a 32-byte Solana / Ed25519 / curve25519 public key for log
/// emission. Produces a 6-hex-char prefix + ellipsis.
///
/// # Example
///
/// ```
/// use common_log::scrub_pubkey;
/// let pk = [0xABu8; 32];
/// let tag = scrub_pubkey(&pk);
/// assert_eq!(tag.as_str(), "ababab…");
/// ```
pub fn scrub_pubkey(p: &[u8; 32]) -> ScrubbedString {
    ScrubbedString::from_bytes(p)
}

/// Tag any fixed-size hex-like byte array (proofs, commitments,
/// signatures). 6-hex-char prefix + ellipsis.
///
/// # Example
///
/// ```
/// use common_log::scrub_hex;
/// let sig = [0xDEu8; 64];
/// let tag = scrub_hex(&sig);
/// assert_eq!(tag.as_str(), "dedede…");
/// ```
pub fn scrub_hex<const N: usize>(b: &[u8; N]) -> ScrubbedString {
    ScrubbedString::from_bytes(b)
}

/// Tag a base58-encoded (or any) UTF-8 string by treating its bytes as
/// the input to the scrubber. Useful for tx-signature strings.
pub fn scrub_str(s: &str) -> ScrubbedString {
    ScrubbedString::from_bytes(s.as_bytes())
}

/// Convenience macro for tracing call sites: `redacted!(key = value)`
/// expands into `key = %scrub_str(&value.to_string())`. This lets
/// callers write
///
/// ```ignore
/// tracing::debug!(redacted!(signature = sig_b58), "tx confirmed");
/// ```
///
/// instead of the verbose `signature = %common_log::scrub_str(&sig_b58)`.
///
/// Note: this is a thin syntactic helper; the redaction layer at the
/// subscriber level still re-scrubs deny-listed fields regardless. The
/// macro is here to make the intent explicit at the call site, where
/// future readers can audit it without chasing through the subscriber
/// config.
#[macro_export]
macro_rules! redacted {
    ($name:ident = $value:expr) => {
        $name = %$crate::scrub_str(&($value).to_string())
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrub_pubkey_produces_six_hex_prefix() {
        let mut pk = [0u8; 32];
        pk[0] = 0xDE;
        pk[1] = 0xAD;
        pk[2] = 0xBE;
        let tag = scrub_pubkey(&pk);
        assert_eq!(tag.as_str(), "deadbe…");
    }

    #[test]
    fn scrub_hex_generic() {
        let proof: [u8; 8] = [0x12, 0x34, 0x56, 0x78, 0xAB, 0xCD, 0xEF, 0x00];
        let tag = scrub_hex(&proof);
        assert_eq!(tag.as_str(), "123456…");
    }

    #[test]
    fn scrub_str_treats_bytes_as_hex_input() {
        let sig = "5J7XYZ...";
        let tag = scrub_str(sig);
        // hex("5J7") = "354a37"
        assert_eq!(tag.as_str(), "354a37…");
    }
}
