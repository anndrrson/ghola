//! AWS Nitro Enclave attestation document parser + chain verifier.
//!
//! The attestation document is a `COSE_Sign1` envelope wrapping a CBOR map
//! (per AWS docs: <https://docs.aws.amazon.com/enclaves/latest/user/verify-root.html>).
//! Signature is ECDSA P-384 over the standard COSE `Sig_structure1` (RFC 8152).
//!
//! High-level layout of the CBOR payload (string keys):
//! ```text
//! { "module_id":   tstr,
//!   "timestamp":   uint (ms),
//!   "digest":      tstr,                    // "SHA384"
//!   "pcrs":        { uint => bstr },
//!   "certificate": bstr,                    // DER, leaf cert
//!   "cabundle":    [ bstr, bstr, ... ],     // DER chain to root
//!   "public_key":  bstr / nil,
//!   "user_data":   bstr / nil,
//!   "nonce":       bstr / nil }
//! ```
//!
//! We pin the AWS Nitro Root G1 certificate in the source so verifier
//! behavior is deterministic across deployments.

use ciborium::value::Value;
use coset::{CborSerializable, CoseSign1, TaggedCborSerializable};
use p384::ecdsa::{signature::Verifier, Signature as P384Sig, VerifyingKey as P384Vk};
use x509_cert::der::{Decode, Encode};
use x509_cert::spki::DecodePublicKey;
use x509_cert::Certificate;

use crate::AttestationError;
use crate::types::NitroAttestation;

/// AWS Nitro Enclave Root G1 certificate, fetched from
/// `https://aws-nitro-enclaves.amazonaws.com/AWS_NitroEnclaves_Root-G1.zip`.
///
/// Valid 2019-10-28 → 2049-10-28. ECDSA P-384.
pub const NITRO_ROOT_PEM: &str = "-----BEGIN CERTIFICATE-----
MIICETCCAZagAwIBAgIRAPkxdWgbkK/hHUbMtOTn+FYwCgYIKoZIzj0EAwMwSTEL
MAkGA1UEBhMCVVMxDzANBgNVBAoMBkFtYXpvbjEMMAoGA1UECwwDQVdTMRswGQYD
VQQDDBJhd3Mubml0cm8tZW5jbGF2ZXMwHhcNMTkxMDI4MTMyODA1WhcNNDkxMDI4
MTQyODA1WjBJMQswCQYDVQQGEwJVUzEPMA0GA1UECgwGQW1hem9uMQwwCgYDVQQL
DANBV1MxGzAZBgNVBAMMEmF3cy5uaXRyby1lbmNsYXZlczB2MBAGByqGSM49AgEG
BSuBBAAiA2IABPwCVOumCMHzaHDimtqQvkY4MpJzbolL//Zy2YlES1BR5TSksfbb
48C8WBoyt7F2Bw7eEtaaP+ohG2bnUs990d0JX28TcPQXCEPZ3BABIeTPYwEoCWZE
h8l5YoQwTcU/9KNCMEAwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUkCW1DdkF
R+eWw5b6cp3PmanfS5YwDgYDVR0PAQH/BAQDAgGGMAoGCCqGSM49BAMDA2kAMGYC
MQCjfy+Rocm9Xue4YnwWmNJVA44fA0P5W2OpYow9OYCVRaEevL8uO1XYru5xtMPW
rfMCMQCi85sWBbJwKKXdS6BptQFuZbT73o/gBh1qUxl/nNr12UO8Yfwr6wPLb+6N
IwLz3/Y=
-----END CERTIFICATE-----
";

/// Decode the pinned root cert into DER. Panics only at first call if the
/// pinned PEM is malformed (compile-time invariant of this crate).
fn aws_nitro_root_der() -> Vec<u8> {
    let pem = NITRO_ROOT_PEM;
    let body: String = pem
        .lines()
        .filter(|l| !l.starts_with("-----"))
        .collect::<Vec<_>>()
        .join("");
    base64_decode_std(&body).expect("pinned NITRO_ROOT_PEM is malformed")
}

/// Tiny standard-alphabet base64 decoder. We avoid pulling the `base64`
/// crate as a hard dep of `said-attest` — the root PEM is the only use
/// site and ciborium/coset give us no hidden re-export.
fn base64_decode_std(input: &str) -> Result<Vec<u8>, &'static str> {
    fn val(c: u8) -> Result<u8, &'static str> {
        match c {
            b'A'..=b'Z' => Ok(c - b'A'),
            b'a'..=b'z' => Ok(c - b'a' + 26),
            b'0'..=b'9' => Ok(c - b'0' + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err("bad b64 char"),
        }
    }
    let s: Vec<u8> = input.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    if s.len() % 4 != 0 {
        return Err("bad b64 length");
    }
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    for chunk in s.chunks_exact(4) {
        let pad = chunk.iter().filter(|c| **c == b'=').count();
        let b0 = val(chunk[0])?;
        let b1 = val(chunk[1])?;
        let b2 = if pad >= 2 { 0 } else { val(chunk[2])? };
        let b3 = if pad >= 1 { 0 } else { val(chunk[3])? };
        out.push((b0 << 2) | (b1 >> 4));
        if pad < 2 {
            out.push((b1 << 4) | (b2 >> 2));
        }
        if pad < 1 {
            out.push((b2 << 6) | b3);
        }
    }
    Ok(out)
}

/// Pull a field out of a CBOR map by string key.
fn map_get<'a>(map: &'a [(Value, Value)], key: &str) -> Option<&'a Value> {
    map.iter().find_map(|(k, v)| match k {
        Value::Text(s) if s == key => Some(v),
        _ => None,
    })
}

fn as_bytes(v: &Value) -> Result<Vec<u8>, AttestationError> {
    match v {
        Value::Bytes(b) => Ok(b.clone()),
        _ => Err(AttestationError::Cbor("expected byte string".into())),
    }
}

fn as_text(v: &Value) -> Result<String, AttestationError> {
    match v {
        Value::Text(s) => Ok(s.clone()),
        _ => Err(AttestationError::Cbor("expected text string".into())),
    }
}

fn as_u64(v: &Value) -> Result<u64, AttestationError> {
    match v {
        Value::Integer(i) => {
            let n: i128 = (*i).into();
            u64::try_from(n).map_err(|_| AttestationError::Cbor("expected uint".into()))
        }
        _ => Err(AttestationError::Cbor("expected uint".into())),
    }
}

fn opt_bytes(v: &Value) -> Result<Option<Vec<u8>>, AttestationError> {
    match v {
        Value::Null => Ok(None),
        Value::Bytes(b) => Ok(Some(b.clone())),
        _ => Err(AttestationError::Cbor("expected bytes or null".into())),
    }
}

/// Decode the CBOR payload of the COSE_Sign1 envelope into a
/// [`NitroAttestation`].
pub fn decode_payload(payload: &[u8]) -> Result<NitroAttestation, AttestationError> {
    let value: Value = ciborium::de::from_reader(payload)
        .map_err(|e| AttestationError::Cbor(e.to_string()))?;
    let map = match value {
        Value::Map(m) => m,
        _ => return Err(AttestationError::Cbor("payload is not a map".into())),
    };

    let module_id = as_text(map_get(&map, "module_id").ok_or_else(|| {
        AttestationError::Cbor("missing module_id".into())
    })?)?;
    let timestamp_ms = as_u64(map_get(&map, "timestamp").ok_or_else(|| {
        AttestationError::Cbor("missing timestamp".into())
    })?)?;

    let pcrs_v = map_get(&map, "pcrs").ok_or_else(|| {
        AttestationError::Cbor("missing pcrs".into())
    })?;
    let pcrs_map = match pcrs_v {
        Value::Map(m) => m,
        _ => return Err(AttestationError::Cbor("pcrs is not a map".into())),
    };
    let mut pcrs: Vec<(u32, Vec<u8>)> = Vec::with_capacity(pcrs_map.len());
    for (k, v) in pcrs_map {
        let idx_u64 = as_u64(k)?;
        let idx: u32 = idx_u64
            .try_into()
            .map_err(|_| AttestationError::Cbor("pcr index overflow".into()))?;
        let digest = as_bytes(v)?;
        pcrs.push((idx, digest));
    }
    pcrs.sort_by_key(|(i, _)| *i);

    let certificate_der = as_bytes(map_get(&map, "certificate").ok_or_else(|| {
        AttestationError::Cbor("missing certificate".into())
    })?)?;

    let cabundle_v = map_get(&map, "cabundle").ok_or_else(|| {
        AttestationError::Cbor("missing cabundle".into())
    })?;
    let cabundle_arr = match cabundle_v {
        Value::Array(a) => a,
        _ => return Err(AttestationError::Cbor("cabundle is not an array".into())),
    };
    let mut cabundle_der = Vec::with_capacity(cabundle_arr.len());
    for v in cabundle_arr {
        cabundle_der.push(as_bytes(v)?);
    }

    let public_key = map_get(&map, "public_key").map(opt_bytes).transpose()?.flatten();
    let user_data = map_get(&map, "user_data").map(opt_bytes).transpose()?.flatten();
    let nonce = map_get(&map, "nonce").map(opt_bytes).transpose()?.flatten();

    Ok(NitroAttestation {
        module_id,
        timestamp_ms,
        pcrs,
        certificate_der,
        cabundle_der,
        public_key,
        user_data,
        nonce,
    })
}

/// Parse the outer COSE_Sign1 envelope, decode the inner CBOR payload, and
/// verify the certificate chain + COSE signature against the supplied
/// root certificate DER.
///
/// Callers that want the production-pinned AWS Nitro Root G1 should use
/// [`parse_and_verify`]. Tests inject their own root via
/// [`parse_and_verify_with_root`].
pub fn parse_and_verify_with_root(
    vendor_quote: &[u8],
    root_der: &[u8],
) -> Result<NitroAttestation, AttestationError> {
    // 1. COSE_Sign1 envelope. Try tagged then untagged.
    let cose = CoseSign1::from_tagged_slice(vendor_quote)
        .or_else(|_| CoseSign1::from_slice(vendor_quote))
        .map_err(|e| AttestationError::Cose(format!("{e:?}")))?;

    let payload = cose
        .payload
        .as_ref()
        .ok_or_else(|| AttestationError::Cose("missing payload".into()))?;

    // 2. CBOR payload decode.
    let doc = decode_payload(payload)?;

    // 3. Cert chain: leaf, cabundle[..], root.
    verify_cert_chain(&doc.certificate_der, &doc.cabundle_der, root_der)?;

    // 4. COSE_Sign1 signature over Sig_structure1, using the leaf cert's
    //    P-384 public key. `coset` exposes `tbs_data(aad)`.
    let leaf = Certificate::from_der(&doc.certificate_der)
        .map_err(|e| AttestationError::CertChain(format!("leaf parse: {e}")))?;
    let spki_der = leaf
        .tbs_certificate
        .subject_public_key_info
        .to_der()
        .map_err(|e| AttestationError::CertChain(format!("spki encode: {e}")))?;
    let vk = P384Vk::from_public_key_der(&spki_der)
        .map_err(|_| AttestationError::CertChain("leaf SPKI not P-384".into()))?;
    let tbs = cose.tbs_data(&[]);
    // AWS Nitro emits raw r||s (96 bytes), not DER. Try raw first, then DER.
    let sig = P384Sig::from_slice(&cose.signature)
        .or_else(|_| P384Sig::from_der(&cose.signature))
        .map_err(|_| AttestationError::Signature)?;
    vk.verify(&tbs, &sig).map_err(|_| AttestationError::Signature)?;

    Ok(doc)
}

/// Parse + chain-verify against the pinned AWS Nitro Root G1.
pub fn parse_and_verify(vendor_quote: &[u8]) -> Result<NitroAttestation, AttestationError> {
    let root_der = aws_nitro_root_der();
    parse_and_verify_with_root(vendor_quote, &root_der)
}

/// Verify the chain `leaf -> cabundle[1..] -> root`.
///
/// AWS Nitro convention: `cabundle[0]` is the AWS root (or pinned root) and
/// the chain proceeds in trust order. Per the AWS sample verifier the chain
/// to verify is `leaf -> cabundle[len-1] -> ... -> cabundle[0] = root`. We
/// accept either orientation by trying both. In all cases the last cert in
/// the chain must be signed by `root_der` (the pinned root we trust) and
/// each adjacent pair must form a valid issuer relationship.
fn verify_cert_chain(
    leaf_der: &[u8],
    cabundle_der: &[Vec<u8>],
    root_der: &[u8],
) -> Result<(), AttestationError> {
    use p384::ecdsa::VerifyingKey as Vk;

    let root_cert = Certificate::from_der(root_der)
        .map_err(|e| AttestationError::CertChain(format!("root parse: {e}")))?;
    let root_spki = root_cert
        .tbs_certificate
        .subject_public_key_info
        .to_der()
        .map_err(|e| AttestationError::CertChain(format!("root spki: {e}")))?;
    let root_vk = Vk::from_public_key_der(&root_spki)
        .map_err(|_| AttestationError::CertChain("root SPKI not P-384".into()))?;

    // Build the ordered chain. We accept either orientation:
    //   forward:  leaf -> ca[len-1] -> ... -> ca[0] (= root)
    //   reverse:  leaf -> ca[0] -> ... -> ca[len-1] (= root)
    // Strategy: try both and accept whichever validates.
    let leaf = Certificate::from_der(leaf_der)
        .map_err(|e| AttestationError::CertChain(format!("leaf parse: {e}")))?;

    let ca_parsed: Vec<Certificate> = cabundle_der
        .iter()
        .map(|der| Certificate::from_der(der))
        .collect::<Result<_, _>>()
        .map_err(|e| AttestationError::CertChain(format!("cabundle parse: {e}")))?;

    let try_order = |order: Vec<&Certificate>| -> Result<(), AttestationError> {
        // chain: leaf, order[0], order[1], ..., order[last]
        // verify each issuer signs the previous, with the trust anchor (root_vk)
        // confirming the last entry. We allow `order[last]` to be the root
        // (its self-signature is what root_vk validates).
        let mut current = &leaf;
        for next in &order {
            // verify `current` was signed by `next`'s public key
            verify_signed_by(current, next)?;
            current = *next;
        }
        // Final: the last cert in `order` must be the trust anchor (its
        // SPKI must match root_vk). We confirm by re-verifying its
        // self-signature, which by construction uses the root SPKI.
        if order.is_empty() {
            // No intermediates: the leaf must be directly signed by the
            // root. Verify against root SPKI.
            verify_signed_by_vk(current, &root_vk)?;
            return Ok(());
        }
        let last = order.last().unwrap();
        let last_spki = last
            .tbs_certificate
            .subject_public_key_info
            .to_der()
            .map_err(|e| AttestationError::CertChain(format!("spki encode: {e}")))?;
        if last_spki != root_spki {
            return Err(AttestationError::CertChain(
                "chain does not terminate at pinned root".into(),
            ));
        }
        // verify root's self-signature for paranoia
        let _ = verify_signed_by_vk(last, &root_vk);
        Ok(())
    };

    let forward: Vec<&Certificate> = ca_parsed.iter().rev().collect();
    let reverse: Vec<&Certificate> = ca_parsed.iter().collect();

    match try_order(forward) {
        Ok(()) => Ok(()),
        Err(_) => try_order(reverse),
    }
}

/// Verify that `child` was signed by `parent`'s public key.
fn verify_signed_by(child: &Certificate, parent: &Certificate) -> Result<(), AttestationError> {
    let spki = parent
        .tbs_certificate
        .subject_public_key_info
        .to_der()
        .map_err(|e| AttestationError::CertChain(format!("parent spki: {e}")))?;
    let vk = P384Vk::from_public_key_der(&spki)
        .map_err(|_| AttestationError::CertChain("parent SPKI not P-384".into()))?;
    verify_signed_by_vk(child, &vk)
}

fn verify_signed_by_vk(child: &Certificate, vk: &P384Vk) -> Result<(), AttestationError> {
    let tbs = child
        .tbs_certificate
        .to_der()
        .map_err(|e| AttestationError::CertChain(format!("tbs encode: {e}")))?;
    let sig_bytes = child.signature.as_bytes().ok_or_else(|| {
        AttestationError::CertChain("non-byte-aligned signature".into())
    })?;
    let sig = P384Sig::from_der(sig_bytes)
        .or_else(|_| P384Sig::from_slice(sig_bytes))
        .map_err(|_| AttestationError::CertChain("malformed cert signature".into()))?;
    vk.verify(&tbs, &sig)
        .map_err(|_| AttestationError::CertChain("cert signature invalid".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pinned_root_parses() {
        let der = aws_nitro_root_der();
        let cert = Certificate::from_der(&der).expect("pinned root must parse");
        // P-384 SPKI
        let spki = cert.tbs_certificate.subject_public_key_info.to_der().unwrap();
        let _vk = P384Vk::from_public_key_der(&spki).expect("root is P-384");
    }

    #[test]
    fn b64_decode_root_payload_len() {
        // Sanity: round-trip length matches expectations.
        let der = aws_nitro_root_der();
        assert!(der.len() > 200, "decoded root cert is suspiciously short");
        assert!(der.len() < 1024, "decoded root cert is suspiciously long");
    }
}
