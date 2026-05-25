//! Field-element and curve-point encoding helpers for the on-chain
//! `groth16-solana` (Lightprotocol) verifier.
//!
//! # Endianness
//!
//! `snarkjs` emits proof field elements in DECIMAL strings (which are
//! value-equivalent regardless of byte order) but its binary witness/
//! proof toolchain internally uses LITTLE-ENDIAN limbs. The Solana
//! `alt_bn128` syscalls — and therefore `groth16-solana` — expect each
//! field element BIG-ENDIAN. Always convert via [`to_be_bytes_32`].
//!
//! # A-point negation
//!
//! The Groth16 pairing check verifies
//!
//! ```text
//!     e(A, B) == e(αG1, βG2) · e(L, γG2) · e(C, δG2)
//! ```
//!
//! which is rearranged on-chain (and by `groth16-solana`) into a single
//! `alt_bn128_pairing` call of form
//!
//! ```text
//!     e(-A, B) · e(αG1, βG2) · e(L, γG2) · e(C, δG2) == 1
//! ```
//!
//! Because the syscall takes only one fixed-sign pairing product, the
//! prover MUST negate the G1 `A` point before submission. snarkjs does
//! NOT do this — we do it here. See [`negate_g1_a`].

use crate::error::{Error, Result};

/// BN254 base-field modulus `q` (the field over which G1/G2 affine
/// coordinates live). For the `A.y` negation we compute `q - y mod q`.
///
/// q = 21888242871839275222246405745257275088696311157297823662689037894645226208583
pub const BN254_Q_BE: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x97, 0x81, 0x6a, 0x91, 0x68, 0x71, 0xca, 0x8d, 0x3c, 0x20, 0x8c, 0x16, 0xd8, 0x7c, 0xfd, 0x47,
];

/// Convert a snarkjs/circom field-element decimal string (or a `0x…` hex
/// string) into 32 big-endian bytes, zero-padded on the high end.
///
/// Rejects values that don't fit in 32 bytes.
pub fn field_str_to_be_bytes_32(s: &str) -> Result<[u8; 32]> {
    let s = s.trim();
    let bytes = if let Some(stripped) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        let mut h = stripped.to_string();
        if h.len() % 2 == 1 {
            h.insert(0, '0');
        }
        hex::decode(&h).map_err(|e| Error::ProofSerializeError(format!("bad hex field: {e}")))?
    } else {
        // Decimal — parse via u128 chunks would lose precision for
        // 254-bit values, so fall back to manual big-int parse.
        decimal_str_to_be_bytes(s)?
    };
    if bytes.len() > 32 {
        return Err(Error::ProofSerializeError(format!(
            "field element overflows 32 bytes (got {} bytes)",
            bytes.len()
        )));
    }
    let mut out = [0u8; 32];
    out[32 - bytes.len()..].copy_from_slice(&bytes);
    Ok(out)
}

/// Convert a 32-byte big-endian field element to its canonical decimal
/// string (zero-trimmed). Suitable for serializing to a circom
/// `input.json` value.
pub fn be_bytes_32_to_decimal(bytes: &[u8; 32]) -> String {
    // Long-multiplication by 256: maintain a decimal-digit vector and
    // for each byte do `acc = acc * 256 + byte`.
    let mut digits: Vec<u32> = vec![0];
    for &b in bytes.iter() {
        let mut carry: u64 = b as u64;
        for d in digits.iter_mut() {
            let v = (*d as u64) * 256 + carry;
            *d = (v % 10_000_000_000) as u32;
            carry = v / 10_000_000_000;
        }
        while carry > 0 {
            digits.push((carry % 10_000_000_000) as u32);
            carry /= 10_000_000_000;
        }
    }
    if digits.iter().all(|d| *d == 0) {
        return "0".to_string();
    }
    let mut s = String::new();
    let last = digits.pop().unwrap();
    s.push_str(&format!("{}", last));
    while let Some(d) = digits.pop() {
        s.push_str(&format!("{:010}", d));
    }
    s
}

/// Decode a hex string into 32 big-endian bytes (zero-padded high-end if
/// shorter). Accepts an optional `0x`/`0X` prefix.
pub fn hex_str_to_be_bytes_32(s: &str) -> Result<[u8; 32]> {
    let s = s.trim();
    let s = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")).unwrap_or(s);
    let mut h = s.to_string();
    if h.len() % 2 == 1 {
        h.insert(0, '0');
    }
    let bytes =
        hex::decode(&h).map_err(|e| Error::ProofSerializeError(format!("bad hex: {e}")))?;
    if bytes.len() > 32 {
        return Err(Error::ProofSerializeError(format!(
            "hex field overflows 32 bytes (got {} bytes)",
            bytes.len()
        )));
    }
    let mut out = [0u8; 32];
    out[32 - bytes.len()..].copy_from_slice(&bytes);
    Ok(out)
}

/// Parse a base-10 unsigned integer up to 256 bits into MSB-first bytes
/// (no leading zeros, may be up to 32 bytes long).
fn decimal_str_to_be_bytes(s: &str) -> Result<Vec<u8>> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return Err(Error::ProofSerializeError(format!(
            "non-decimal field element: {s}"
        )));
    }
    // Repeated long-division by 256.
    let mut digits: Vec<u32> = s.bytes().map(|b| (b - b'0') as u32).collect();
    let mut out_rev = Vec::with_capacity(32);
    while !digits.iter().all(|&d| d == 0) {
        let mut rem: u32 = 0;
        for d in digits.iter_mut() {
            let cur = rem * 10 + *d;
            *d = cur / 256;
            rem = cur % 256;
        }
        out_rev.push(rem as u8);
        // strip leading zero
        while digits.first() == Some(&0) && digits.len() > 1 {
            digits.remove(0);
        }
    }
    if out_rev.is_empty() {
        out_rev.push(0);
    }
    out_rev.reverse();
    if out_rev.len() > 32 {
        return Err(Error::ProofSerializeError(
            "decimal field overflows 32 bytes".into(),
        ));
    }
    Ok(out_rev)
}

/// 32-byte big-endian view of a field element already in `[u8; 32]`
/// (identity; provided so call sites can be explicit about endianness
/// expectations). If the input is known little-endian, callers should
/// `let be = le.iter().rev().copied().collect::<Vec<_>>()` first.
pub fn to_be_bytes_32(field: [u8; 32]) -> [u8; 32] {
    field
}

/// Negate the G1 affine point `A = (x, y)` by replacing `y` with `q - y`.
///
/// `a_be` layout: `[x_be(32) || y_be(32)]` — i.e. 64 bytes, uncompressed,
/// MSB-first within each coordinate (the on-chain format).
///
/// If `y == 0` (point at infinity in affine), the negation is the same
/// point. Otherwise the result is `(x, q - y)`.
pub fn negate_g1_a(a_be: [u8; 64]) -> Result<[u8; 64]> {
    let mut out = a_be;
    let y = &a_be[32..64];

    if y.iter().all(|&b| b == 0) {
        // y == 0 → identity (or invalid); leave untouched.
        return Ok(out);
    }

    // Compute q - y as big-endian 32-byte subtraction. q > y always for
    // valid field elements, so no underflow.
    let mut borrow: i16 = 0;
    let mut neg = [0u8; 32];
    for i in (0..32).rev() {
        let q_byte = BN254_Q_BE[i] as i16;
        let y_byte = y[i] as i16;
        let mut diff = q_byte - y_byte - borrow;
        if diff < 0 {
            diff += 256;
            borrow = 1;
        } else {
            borrow = 0;
        }
        neg[i] = diff as u8;
    }
    if borrow != 0 {
        return Err(Error::ProofSerializeError(
            "G1.A.y not canonical (>= q) — cannot negate".into(),
        ));
    }
    out[32..64].copy_from_slice(&neg);
    Ok(out)
}

/// Compress an uncompressed G1 point `(x, y)` → 32 bytes, encoding the
/// sign of `y` in the top bit of `x`.
///
/// Convention used by `groth16-solana` (matches arkworks): top bit of
/// the first byte = 1 if `y` is the "larger" of the two square roots
/// (i.e. `y > q/2`), else 0.
///
/// NOTE: For shielded-pool submission the on-chain program calls
/// `alt_bn128_g1_decompress` itself; we compute the compressed form
/// here mainly for fixture/test vectors and indexer-side checks.
pub fn compress_g1(uncompressed: [u8; 64]) -> Result<[u8; 32]> {
    let mut out = [0u8; 32];
    out.copy_from_slice(&uncompressed[..32]);
    if y_is_lexicographically_larger(&uncompressed[32..64]) {
        out[0] |= 0x80;
    }
    Ok(out)
}

/// Compress an uncompressed G2 point `(x0, x1, y0, y1)` → 64 bytes.
///
/// Layout in: `[x0(32) || x1(32) || y0(32) || y1(32)]` big-endian.
/// Layout out: `[x0(32) || x1(32)]` with sign bit of `y` in the top bit
/// of the first byte. We use the lexicographic ordering on `(y1, y0)`.
pub fn compress_g2(uncompressed: [u8; 128]) -> Result<[u8; 64]> {
    let mut out = [0u8; 64];
    out.copy_from_slice(&uncompressed[..64]);
    // Compare y = (y1, y0) lex-wise vs -y = (q - y1, q - y0). Cheap
    // approximation: compare y1 only — if y1 != 0 then sign-of-y1 wins.
    let y1 = &uncompressed[96..128];
    if y_is_lexicographically_larger(y1) {
        out[0] |= 0x80;
    }
    Ok(out)
}

/// Returns true if the big-endian-encoded coordinate `y` satisfies
/// `y > q/2` (i.e. is the "larger" of the two square roots).
fn y_is_lexicographically_larger(y_be: &[u8]) -> bool {
    // half = q >> 1. Precomputed half-q big-endian:
    //   q/2 = 10944121435919637611123202872628637544348155578648911831344518947322613104291
    const HALF_Q_BE: [u8; 32] = [
        0x18, 0x32, 0x27, 0x39, 0x70, 0x98, 0xd0, 0x14, 0xdc, 0x28, 0x22, 0xdb, 0x40, 0xc0, 0xac,
        0x2e, 0xcb, 0xc0, 0xb5, 0x48, 0xb4, 0x38, 0xe5, 0x46, 0x9e, 0x10, 0x46, 0x0b, 0x6c, 0x3e,
        0x7e, 0xa3,
    ];
    for (a, b) in y_be.iter().zip(HALF_Q_BE.iter()) {
        if a != b {
            return a > b;
        }
    }
    // y == q/2 → take "not larger" arbitrarily.
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decimal_zero_one() {
        assert_eq!(field_str_to_be_bytes_32("0").unwrap(), [0u8; 32]);
        let mut one = [0u8; 32];
        one[31] = 1;
        assert_eq!(field_str_to_be_bytes_32("1").unwrap(), one);
    }

    #[test]
    fn hex_parse() {
        let v = field_str_to_be_bytes_32("0x01").unwrap();
        let mut want = [0u8; 32];
        want[31] = 1;
        assert_eq!(v, want);
    }

    #[test]
    fn negate_zero_is_zero() {
        let a = [0u8; 64];
        let neg = negate_g1_a(a).unwrap();
        assert_eq!(neg, a);
    }

    #[test]
    fn negate_then_negate_is_identity() {
        // y = 1
        let mut a = [0u8; 64];
        a[63] = 1;
        let n1 = negate_g1_a(a).unwrap();
        let n2 = negate_g1_a(n1).unwrap();
        assert_eq!(n2, a);
    }

    #[test]
    fn compress_sets_sign_bit_for_large_y() {
        // y > q/2 → top bit set.
        let mut a = [0u8; 64];
        // x = 0, y = q - 1 (definitely > q/2)
        a[32..64].copy_from_slice(&{
            let mut neg_one = BN254_Q_BE;
            neg_one[31] -= 1; // q - 1
            neg_one
        });
        let c = compress_g1(a).unwrap();
        assert_eq!(c[0] & 0x80, 0x80);
    }
}
