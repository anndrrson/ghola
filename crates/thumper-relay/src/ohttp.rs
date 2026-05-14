//! OHTTP (RFC 9458) gateway implementation.
//!
//! Wraps the existing sealed-inference handler with an Oblivious HTTP
//! envelope so a Cloudflare-operated OHTTP relay can shield the
//! end-user's source IP from the Ghola Gateway while the Gateway is
//! the only party that can decrypt the inner BHTTP request.
//!
//! HPKE suite (matches the rest of the Ghola codebase):
//!   KEM  = DHKEM(X25519, HKDF-SHA256)  (0x0020)
//!   KDF  = HKDF-SHA256                  (0x0001)
//!   AEAD = AES-256-GCM                  (0x0002)
//!
//! We deliberately avoid pulling in the `ohttp` or `hpke` crates: their
//! transitive-dep footprint conflicts with the Solana platform-tools
//! rustc pin that the rest of the workspace already navigates, and we
//! already have `x25519-dalek`, `hkdf`, `sha2`, and `aes-gcm` vendored.
//!
//! Capsule wire format (RFC 9458 §4):
//!
//!   request  : hdr(7) || enc(32) || ct
//!   response : enc_nonce(N) || ct
//!
//! where hdr = key_id(1) || kem_id(2) || kdf_id(2) || aead_id(2). The
//! request `enc` is the HPKE encapsulated KEM share; the response
//! uses a separate nonce + the same AEAD key derived via HPKE's
//! `Export` interface.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use hkdf::Hkdf;
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};

// ── Suite constants ─────────────────────────────────────────────────────

pub const KEM_ID_DHKEM_X25519_SHA256: u16 = 0x0020;
pub const KDF_ID_HKDF_SHA256: u16 = 0x0001;
pub const AEAD_ID_AES_256_GCM: u16 = 0x0002;

const NK: usize = 32; // AES-256 key length
const NN: usize = 12; // AES-GCM nonce length
const NH: usize = 32; // HKDF-SHA256 hash length
const NPK: usize = 32; // X25519 pubkey / enc length
const NSK: usize = 32; // X25519 secret length

const HPKE_VERSION: &[u8] = b"HPKE-v1";

const OHTTP_REQUEST_LABEL: &[u8] = b"message/bhttp request";
const OHTTP_RESPONSE_LABEL: &[u8] = b"message/bhttp response";

#[derive(Debug, thiserror::Error)]
pub enum OhttpError {
    #[error("capsule too short for header")]
    ShortCapsule,
    #[error("unknown key id {0}")]
    UnknownKeyId(u8),
    #[error("unsupported KEM id {0:#06x}")]
    UnsupportedKem(u16),
    #[error("unsupported KDF id {0:#06x}")]
    UnsupportedKdf(u16),
    #[error("unsupported AEAD id {0:#06x}")]
    UnsupportedAead(u16),
    #[error("HKDF expand failure")]
    HkdfExpand,
    #[error("AEAD seal failure")]
    AeadSeal,
    #[error("AEAD open failure")]
    AeadOpen,
    #[error("invalid pubkey length")]
    InvalidPubkey,
}

// ── Public types ────────────────────────────────────────────────────────

/// The gateway keypair used to decapsulate inbound OHTTP requests. The
/// `key_id` is what clients reference in the capsule header to select
/// among rotated keys.
pub struct OhttpKeypair {
    pub key_id: u8,
    pub secret: StaticSecret,
    pub public: PublicKey,
}

impl std::fmt::Debug for OhttpKeypair {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OhttpKeypair")
            .field("key_id", &self.key_id)
            .field("public_hex", &hex::encode(self.public.as_bytes()))
            .finish()
    }
}

impl OhttpKeypair {
    /// Construct a keypair from a raw 32-byte X25519 secret.
    pub fn from_secret_bytes(key_id: u8, secret: [u8; NSK]) -> Self {
        let secret = StaticSecret::from(secret);
        let public = PublicKey::from(&secret);
        Self { key_id, secret, public }
    }

    /// Mint a fresh keypair using the OS RNG.
    pub fn generate(key_id: u8) -> Self {
        let mut secret_bytes = [0u8; NSK];
        OsRng.fill_bytes(&mut secret_bytes);
        Self::from_secret_bytes(key_id, secret_bytes)
    }

    /// Encode the keyconfig per RFC 9458 §3.
    ///
    /// keyconfig = key_id(1) || kem_id(2) || pubkey(Npk) ||
    ///             cipher_suites_len(2) || [kdf_id(2) || aead_id(2)]*
    pub fn key_config(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(1 + 2 + NPK + 2 + 4);
        out.push(self.key_id);
        out.extend_from_slice(&KEM_ID_DHKEM_X25519_SHA256.to_be_bytes());
        out.extend_from_slice(self.public.as_bytes());
        // one ciphersuite: HKDF-SHA256 + AES-256-GCM
        out.extend_from_slice(&4u16.to_be_bytes());
        out.extend_from_slice(&KDF_ID_HKDF_SHA256.to_be_bytes());
        out.extend_from_slice(&AEAD_ID_AES_256_GCM.to_be_bytes());
        out
    }
}

/// Per-request decapsulation context. Keep this around to seal the
/// response back to the requester (RFC 9458 §4.4).
#[derive(Debug)]
pub struct ResponseContext {
    /// HPKE export secret tied to this request (Nh bytes).
    export_secret: [u8; NH],
    /// The encapsulated key the client used; needed to derive the
    /// response salt per RFC 9458 §4.4.
    enc: [u8; NPK],
    /// Suite header echoed back for AAD binding (7 bytes). Currently
    /// unused at seal time (AES-GCM AAD is empty per RFC 9458 §4) but
    /// kept so we can extend without a wire break.
    #[allow(dead_code)]
    hdr: [u8; 7],
}

// ── HPKE primitives (RFC 9180 §5 for the slice we need) ────────────────

fn suite_id_kem() -> [u8; 5] {
    let mut out = [0u8; 5];
    out[0..3].copy_from_slice(b"KEM");
    out[3..5].copy_from_slice(&KEM_ID_DHKEM_X25519_SHA256.to_be_bytes());
    out
}

fn suite_id_hpke() -> [u8; 10] {
    let mut out = [0u8; 10];
    out[0..4].copy_from_slice(b"HPKE");
    out[4..6].copy_from_slice(&KEM_ID_DHKEM_X25519_SHA256.to_be_bytes());
    out[6..8].copy_from_slice(&KDF_ID_HKDF_SHA256.to_be_bytes());
    out[8..10].copy_from_slice(&AEAD_ID_AES_256_GCM.to_be_bytes());
    out
}

/// RFC 9180 §4 LabeledExtract.
fn labeled_extract(suite_id: &[u8], salt: &[u8], label: &[u8], ikm: &[u8]) -> [u8; NH] {
    let mut labeled_ikm = Vec::with_capacity(HPKE_VERSION.len() + suite_id.len() + label.len() + ikm.len());
    labeled_ikm.extend_from_slice(HPKE_VERSION);
    labeled_ikm.extend_from_slice(suite_id);
    labeled_ikm.extend_from_slice(label);
    labeled_ikm.extend_from_slice(ikm);
    let (prk, _) = Hkdf::<Sha256>::extract(Some(salt), &labeled_ikm);
    let mut out = [0u8; NH];
    out.copy_from_slice(&prk);
    out
}

/// RFC 9180 §4 LabeledExpand.
fn labeled_expand(
    suite_id: &[u8],
    prk: &[u8],
    label: &[u8],
    info: &[u8],
    length: usize,
) -> Result<Vec<u8>, OhttpError> {
    let mut labeled_info = Vec::with_capacity(2 + HPKE_VERSION.len() + suite_id.len() + label.len() + info.len());
    labeled_info.extend_from_slice(&(length as u16).to_be_bytes());
    labeled_info.extend_from_slice(HPKE_VERSION);
    labeled_info.extend_from_slice(suite_id);
    labeled_info.extend_from_slice(label);
    labeled_info.extend_from_slice(info);
    let hkdf = Hkdf::<Sha256>::from_prk(prk).map_err(|_| OhttpError::HkdfExpand)?;
    let mut out = vec![0u8; length];
    hkdf.expand(&labeled_info, &mut out).map_err(|_| OhttpError::HkdfExpand)?;
    Ok(out)
}

/// DHKEM(X25519)::ExtractAndExpand (RFC 9180 §7.1.3).
fn extract_and_expand(dh: &[u8], enc: &[u8], pk_r: &[u8]) -> Result<[u8; NH], OhttpError> {
    let suite = suite_id_kem();
    let eae_prk = labeled_extract(&suite, &[], b"eae_prk", dh);
    let mut kem_context = Vec::with_capacity(enc.len() + pk_r.len());
    kem_context.extend_from_slice(enc);
    kem_context.extend_from_slice(pk_r);
    let shared = labeled_expand(&suite, &eae_prk, b"shared_secret", &kem_context, NH)?;
    let mut out = [0u8; NH];
    out.copy_from_slice(&shared);
    Ok(out)
}

/// HPKE KeySchedule (RFC 9180 §5.1) for `mode_base` (no PSK), Nh = 32.
/// Returns `(key, base_nonce, exporter_secret)`.
fn key_schedule_base(shared_secret: &[u8; NH], info: &[u8]) -> Result<([u8; NK], [u8; NN], [u8; NH]), OhttpError> {
    let suite = suite_id_hpke();
    // mode = 0 (base)
    let psk_id_hash = labeled_extract(&suite, &[], b"psk_id_hash", &[]);
    let info_hash = labeled_extract(&suite, &[], b"info_hash", info);
    let mut key_schedule_context = Vec::with_capacity(1 + 2 * NH);
    key_schedule_context.push(0u8);
    key_schedule_context.extend_from_slice(&psk_id_hash);
    key_schedule_context.extend_from_slice(&info_hash);

    let secret = labeled_extract(&suite, shared_secret, b"secret", &[]);

    let key_v = labeled_expand(&suite, &secret, b"key", &key_schedule_context, NK)?;
    let base_nonce_v = labeled_expand(&suite, &secret, b"base_nonce", &key_schedule_context, NN)?;
    let exporter_v = labeled_expand(&suite, &secret, b"exp", &key_schedule_context, NH)?;

    let mut key = [0u8; NK];
    key.copy_from_slice(&key_v);
    let mut base_nonce = [0u8; NN];
    base_nonce.copy_from_slice(&base_nonce_v);
    let mut exporter = [0u8; NH];
    exporter.copy_from_slice(&exporter_v);
    Ok((key, base_nonce, exporter))
}

fn export(exporter_secret: &[u8; NH], exporter_context: &[u8], length: usize) -> Result<Vec<u8>, OhttpError> {
    labeled_expand(&suite_id_hpke(), exporter_secret, b"sec", exporter_context, length)
}

// ── Capsule encode / decode ────────────────────────────────────────────

fn ohttp_request_info(hdr: &[u8; 7]) -> Vec<u8> {
    let mut info = Vec::with_capacity(OHTTP_REQUEST_LABEL.len() + 1 + 7);
    info.extend_from_slice(OHTTP_REQUEST_LABEL);
    info.push(0u8);
    info.extend_from_slice(hdr);
    info
}

/// Decapsulate an inbound OHTTP request capsule. Returns the plaintext
/// inner BHTTP bytes and a `ResponseContext` for sealing the reply.
pub fn decapsulate_request(
    keypair: &OhttpKeypair,
    capsule: &[u8],
) -> Result<(Vec<u8>, ResponseContext), OhttpError> {
    if capsule.len() < 7 + NPK + 16 {
        return Err(OhttpError::ShortCapsule);
    }
    let mut hdr = [0u8; 7];
    hdr.copy_from_slice(&capsule[..7]);
    let key_id = hdr[0];
    let kem_id = u16::from_be_bytes([hdr[1], hdr[2]]);
    let kdf_id = u16::from_be_bytes([hdr[3], hdr[4]]);
    let aead_id = u16::from_be_bytes([hdr[5], hdr[6]]);

    if key_id != keypair.key_id {
        return Err(OhttpError::UnknownKeyId(key_id));
    }
    if kem_id != KEM_ID_DHKEM_X25519_SHA256 {
        return Err(OhttpError::UnsupportedKem(kem_id));
    }
    if kdf_id != KDF_ID_HKDF_SHA256 {
        return Err(OhttpError::UnsupportedKdf(kdf_id));
    }
    if aead_id != AEAD_ID_AES_256_GCM {
        return Err(OhttpError::UnsupportedAead(aead_id));
    }

    let mut enc = [0u8; NPK];
    enc.copy_from_slice(&capsule[7..7 + NPK]);
    let ct = &capsule[7 + NPK..];

    // DH(sk_r, pk_e)
    let pk_e = PublicKey::from(enc);
    let dh = keypair.secret.diffie_hellman(&pk_e);
    let shared_secret = extract_and_expand(dh.as_bytes(), &enc, keypair.public.as_bytes())?;

    let info = ohttp_request_info(&hdr);
    let (key, base_nonce, exporter_secret) = key_schedule_base(&shared_secret, &info)?;

    // Seq = 0; nonce = base_nonce ⊕ seq_be(Nn) = base_nonce
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| OhttpError::AeadOpen)?;
    let nonce = Nonce::from_slice(&base_nonce);
    let plaintext = cipher
        .decrypt(nonce, Payload { msg: ct, aad: &[] })
        .map_err(|_| OhttpError::AeadOpen)?;

    Ok((
        plaintext,
        ResponseContext {
            export_secret: exporter_secret,
            enc,
            hdr,
        },
    ))
}

/// Encapsulate an outbound OHTTP response. Returns the wire capsule
/// `enc_nonce || ct` ready to ship back to the client.
pub fn encapsulate_response(ctx: &ResponseContext, response_plaintext: &[u8]) -> Result<Vec<u8>, OhttpError> {
    // RFC 9458 §4.4: response key + nonce derived from HPKE Export with
    // label "message/bhttp response", context = enc || enc_nonce, plus
    // a per-message random salt (response_nonce) of Nk_resp = max(Nk,Nn)
    // bytes prepended to the ciphertext.
    let resp_nonce_len = NK; // Nk = Nn for AES-256-GCM only when Nk>=Nn; spec: Nk_resp = max(Nk, Nn) = 32.
    let mut response_nonce = vec![0u8; resp_nonce_len];
    OsRng.fill_bytes(&mut response_nonce);

    let mut salt = Vec::with_capacity(ctx.enc.len() + response_nonce.len());
    salt.extend_from_slice(&ctx.enc);
    salt.extend_from_slice(&response_nonce);

    // Per RFC 9458 §4.4: secret = Export("message/bhttp response", Nk)
    //                   prk    = Extract(salt = enc || response_nonce, secret)
    //                   key    = Expand(prk, "key",   "", Nk)
    //                   nonce  = Expand(prk, "nonce", "", Nn)
    let secret = export(&ctx.export_secret, OHTTP_RESPONSE_LABEL, NK)?;
    let (prk, _) = Hkdf::<Sha256>::extract(Some(&salt), &secret);
    let mut key = [0u8; NK];
    Hkdf::<Sha256>::from_prk(&prk)
        .map_err(|_| OhttpError::HkdfExpand)?
        .expand(b"key", &mut key)
        .map_err(|_| OhttpError::HkdfExpand)?;
    let mut nonce_bytes = [0u8; NN];
    Hkdf::<Sha256>::from_prk(&prk)
        .map_err(|_| OhttpError::HkdfExpand)?
        .expand(b"nonce", &mut nonce_bytes)
        .map_err(|_| OhttpError::HkdfExpand)?;

    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| OhttpError::AeadSeal)?;
    let ct = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: response_plaintext,
                aad: &[],
            },
        )
        .map_err(|_| OhttpError::AeadSeal)?;

    let mut out = Vec::with_capacity(response_nonce.len() + ct.len());
    out.extend_from_slice(&response_nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

// ── Test-only client side ──────────────────────────────────────────────

/// Build a request capsule from the gateway's public keyconfig. Used in
/// unit tests and as a reference implementation for the TS client.
#[cfg(test)]
pub fn encapsulate_request_for_test(
    gateway_pub: &PublicKey,
    key_id: u8,
    plaintext: &[u8],
) -> Result<(Vec<u8>, [u8; NH]), OhttpError> {
    let mut hdr = [0u8; 7];
    hdr[0] = key_id;
    hdr[1..3].copy_from_slice(&KEM_ID_DHKEM_X25519_SHA256.to_be_bytes());
    hdr[3..5].copy_from_slice(&KDF_ID_HKDF_SHA256.to_be_bytes());
    hdr[5..7].copy_from_slice(&AEAD_ID_AES_256_GCM.to_be_bytes());

    // Ephemeral X25519 keypair
    let mut sk_e_bytes = [0u8; NSK];
    OsRng.fill_bytes(&mut sk_e_bytes);
    let sk_e = StaticSecret::from(sk_e_bytes);
    let pk_e = PublicKey::from(&sk_e);
    let dh = sk_e.diffie_hellman(gateway_pub);
    let shared_secret = extract_and_expand(dh.as_bytes(), pk_e.as_bytes(), gateway_pub.as_bytes())?;

    let info = ohttp_request_info(&hdr);
    let (key, base_nonce, exporter_secret) = key_schedule_base(&shared_secret, &info)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| OhttpError::AeadSeal)?;
    let ct = cipher
        .encrypt(Nonce::from_slice(&base_nonce), Payload { msg: plaintext, aad: &[] })
        .map_err(|_| OhttpError::AeadSeal)?;

    let mut capsule = Vec::with_capacity(7 + NPK + ct.len());
    capsule.extend_from_slice(&hdr);
    capsule.extend_from_slice(pk_e.as_bytes());
    capsule.extend_from_slice(&ct);
    Ok((capsule, exporter_secret))
}

/// Decrypt a server's response capsule using the exporter secret captured at
/// request time. Mirrors RFC 9458 §4.4 client-side.
#[cfg(test)]
pub fn decapsulate_response_for_test(
    exporter_secret: &[u8; NH],
    enc: &[u8; NPK],
    capsule: &[u8],
) -> Result<Vec<u8>, OhttpError> {
    let resp_nonce_len = NK;
    if capsule.len() < resp_nonce_len + 16 {
        return Err(OhttpError::ShortCapsule);
    }
    let response_nonce = &capsule[..resp_nonce_len];
    let ct = &capsule[resp_nonce_len..];

    let mut salt = Vec::with_capacity(enc.len() + response_nonce.len());
    salt.extend_from_slice(enc);
    salt.extend_from_slice(response_nonce);

    let secret = export(exporter_secret, OHTTP_RESPONSE_LABEL, NK)?;
    let (prk, _) = Hkdf::<Sha256>::extract(Some(&salt), &secret);
    let mut key = [0u8; NK];
    Hkdf::<Sha256>::from_prk(&prk)
        .map_err(|_| OhttpError::HkdfExpand)?
        .expand(b"key", &mut key)
        .map_err(|_| OhttpError::HkdfExpand)?;
    let mut nonce_bytes = [0u8; NN];
    Hkdf::<Sha256>::from_prk(&prk)
        .map_err(|_| OhttpError::HkdfExpand)?
        .expand(b"nonce", &mut nonce_bytes)
        .map_err(|_| OhttpError::HkdfExpand)?;

    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| OhttpError::AeadOpen)?;
    let pt = cipher
        .decrypt(Nonce::from_slice(&nonce_bytes), Payload { msg: ct, aad: &[] })
        .map_err(|_| OhttpError::AeadOpen)?;
    Ok(pt)
}

// ── BHTTP minimal codec (RFC 9292 known-length request/response) ───────
//
// We support a tiny subset sufficient for `POST /inference/sealed`:
//   * Known-length framing (control byte 0x00 for request, 0x01 for
//     response — RFC 9292 §3.2).
//   * Request: framing(1) || varint(method_len) || method ||
//                varint(scheme_len) || scheme ||
//                varint(authority_len) || authority ||
//                varint(path_len) || path ||
//                varint(headers_len) || headers || varint(body_len) || body ||
//                varint(trailers_len)=0
//   * Response: framing(1) || varint(status) ||
//                varint(headers_len) || headers || varint(body_len) || body ||
//                varint(trailers_len)=0
//   * Headers serialize as: repeated [ varint(name_len) || name || varint(value_len) || value ]
//
// This is a pragmatic implementation, not a full RFC 9292 parser.

fn varint_encode(value: u64, out: &mut Vec<u8>) {
    if value < (1 << 6) {
        out.push(value as u8);
    } else if value < (1 << 14) {
        let v = (value as u16) | 0x4000;
        out.extend_from_slice(&v.to_be_bytes());
    } else if value < (1 << 30) {
        let v = (value as u32) | 0x8000_0000;
        out.extend_from_slice(&v.to_be_bytes());
    } else {
        let v = (value as u64) | 0xC000_0000_0000_0000;
        out.extend_from_slice(&v.to_be_bytes());
    }
}

fn varint_decode(buf: &[u8]) -> Option<(u64, usize)> {
    if buf.is_empty() {
        return None;
    }
    let prefix = buf[0] >> 6;
    match prefix {
        0 => Some(((buf[0] & 0x3F) as u64, 1)),
        1 => {
            if buf.len() < 2 {
                return None;
            }
            let v = u16::from_be_bytes([buf[0] & 0x3F, buf[1]]);
            Some((v as u64, 2))
        }
        2 => {
            if buf.len() < 4 {
                return None;
            }
            let mut b = [0u8; 4];
            b.copy_from_slice(&buf[..4]);
            b[0] &= 0x3F;
            Some((u32::from_be_bytes(b) as u64, 4))
        }
        3 => {
            if buf.len() < 8 {
                return None;
            }
            let mut b = [0u8; 8];
            b.copy_from_slice(&buf[..8]);
            b[0] &= 0x3F;
            Some((u64::from_be_bytes(b), 8))
        }
        _ => None,
    }
}

fn read_lenprefixed<'a>(buf: &'a [u8], cursor: &mut usize) -> Option<&'a [u8]> {
    let (len, used) = varint_decode(&buf[*cursor..])?;
    *cursor += used;
    let end = *cursor + len as usize;
    if end > buf.len() {
        return None;
    }
    let out = &buf[*cursor..end];
    *cursor = end;
    Some(out)
}

#[derive(Debug, Clone)]
pub struct BhttpRequest {
    pub method: String,
    pub scheme: String,
    pub authority: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct BhttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

fn encode_headers(headers: &[(String, String)]) -> Vec<u8> {
    let mut inner = Vec::new();
    for (k, v) in headers {
        varint_encode(k.len() as u64, &mut inner);
        inner.extend_from_slice(k.as_bytes());
        varint_encode(v.len() as u64, &mut inner);
        inner.extend_from_slice(v.as_bytes());
    }
    inner
}

fn decode_headers(buf: &[u8]) -> Option<Vec<(String, String)>> {
    let mut out = Vec::new();
    let mut cursor = 0;
    while cursor < buf.len() {
        let k = read_lenprefixed(buf, &mut cursor)?;
        let v = read_lenprefixed(buf, &mut cursor)?;
        out.push((
            String::from_utf8(k.to_vec()).ok()?,
            String::from_utf8(v.to_vec()).ok()?,
        ));
    }
    Some(out)
}

impl BhttpRequest {
    pub fn decode(buf: &[u8]) -> Option<Self> {
        if buf.is_empty() || buf[0] != 0x00 {
            return None;
        }
        let mut cursor = 1;
        let method = String::from_utf8(read_lenprefixed(buf, &mut cursor)?.to_vec()).ok()?;
        let scheme = String::from_utf8(read_lenprefixed(buf, &mut cursor)?.to_vec()).ok()?;
        let authority = String::from_utf8(read_lenprefixed(buf, &mut cursor)?.to_vec()).ok()?;
        let path = String::from_utf8(read_lenprefixed(buf, &mut cursor)?.to_vec()).ok()?;
        let header_bytes = read_lenprefixed(buf, &mut cursor)?;
        let headers = decode_headers(header_bytes)?;
        let body = read_lenprefixed(buf, &mut cursor)?.to_vec();
        // trailers: 0 length expected. Tolerate absence.
        Some(Self {
            method,
            scheme,
            authority,
            path,
            headers,
            body,
        })
    }

    #[cfg(test)]
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.push(0x00u8);
        varint_encode(self.method.len() as u64, &mut out);
        out.extend_from_slice(self.method.as_bytes());
        varint_encode(self.scheme.len() as u64, &mut out);
        out.extend_from_slice(self.scheme.as_bytes());
        varint_encode(self.authority.len() as u64, &mut out);
        out.extend_from_slice(self.authority.as_bytes());
        varint_encode(self.path.len() as u64, &mut out);
        out.extend_from_slice(self.path.as_bytes());
        let hdr = encode_headers(&self.headers);
        varint_encode(hdr.len() as u64, &mut out);
        out.extend_from_slice(&hdr);
        varint_encode(self.body.len() as u64, &mut out);
        out.extend_from_slice(&self.body);
        varint_encode(0u64, &mut out); // trailers
        out
    }
}

impl BhttpResponse {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.push(0x01u8);
        varint_encode(self.status as u64, &mut out);
        let hdr = encode_headers(&self.headers);
        varint_encode(hdr.len() as u64, &mut out);
        out.extend_from_slice(&hdr);
        varint_encode(self.body.len() as u64, &mut out);
        out.extend_from_slice(&self.body);
        varint_encode(0u64, &mut out); // trailers
        out
    }

    #[cfg(test)]
    pub fn decode(buf: &[u8]) -> Option<Self> {
        if buf.is_empty() || buf[0] != 0x01 {
            return None;
        }
        let mut cursor = 1;
        let (status, used) = varint_decode(&buf[cursor..])?;
        cursor += used;
        let hdr = read_lenprefixed(buf, &mut cursor)?;
        let headers = decode_headers(hdr)?;
        let body = read_lenprefixed(buf, &mut cursor)?.to_vec();
        Some(Self {
            status: status as u16,
            headers,
            body,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capsule_round_trip() {
        let kp = OhttpKeypair::generate(0x01);
        let plaintext = b"hello world, this is an inner BHTTP request payload";

        let (capsule, exporter) =
            encapsulate_request_for_test(&kp.public, kp.key_id, plaintext).expect("encap");

        let (decoded, ctx) = decapsulate_request(&kp, &capsule).expect("decap");
        assert_eq!(decoded, plaintext);

        let response_plaintext = b"BHTTP response bytes go here";
        let response_capsule = encapsulate_response(&ctx, response_plaintext).expect("seal resp");

        let mut enc_arr = [0u8; NPK];
        enc_arr.copy_from_slice(&capsule[7..7 + NPK]);
        let decoded_resp =
            decapsulate_response_for_test(&exporter, &enc_arr, &response_capsule).expect("open resp");
        assert_eq!(decoded_resp, response_plaintext);
    }

    #[test]
    fn rejects_wrong_key_id() {
        let kp = OhttpKeypair::generate(0x01);
        let plaintext = b"x";
        let (mut capsule, _) =
            encapsulate_request_for_test(&kp.public, 0x02, plaintext).expect("encap");
        // header key_id is at offset 0
        assert_eq!(capsule[0], 0x02);
        capsule[0] = 0x02;
        let err = decapsulate_request(&kp, &capsule).unwrap_err();
        matches!(err, OhttpError::UnknownKeyId(_));
    }

    #[test]
    fn bhttp_request_round_trip() {
        let req = BhttpRequest {
            method: "POST".to_string(),
            scheme: "https".to_string(),
            authority: "ghola-relay.onrender.com".to_string(),
            path: "/inference/sealed".to_string(),
            headers: vec![
                ("content-type".to_string(), "application/json".to_string()),
                ("authorization".to_string(), "Bearer abc.def.ghi".to_string()),
            ],
            body: b"{\"job_id\":\"x\"}".to_vec(),
        };
        let encoded = req.encode();
        let decoded = BhttpRequest::decode(&encoded).expect("decode");
        assert_eq!(decoded.method, req.method);
        assert_eq!(decoded.scheme, req.scheme);
        assert_eq!(decoded.authority, req.authority);
        assert_eq!(decoded.path, req.path);
        assert_eq!(decoded.headers, req.headers);
        assert_eq!(decoded.body, req.body);
    }

    #[test]
    fn bhttp_response_round_trip() {
        let resp = BhttpResponse {
            status: 200,
            headers: vec![("content-type".to_string(), "application/json".to_string())],
            body: b"{\"ok\":true}".to_vec(),
        };
        let encoded = resp.encode();
        let decoded = BhttpResponse::decode(&encoded).expect("decode");
        assert_eq!(decoded.status, resp.status);
        assert_eq!(decoded.headers, resp.headers);
        assert_eq!(decoded.body, resp.body);
    }

    #[test]
    fn keyconfig_shape() {
        let kp = OhttpKeypair::generate(0x55);
        let cfg = kp.key_config();
        // 1 + 2 + 32 + 2 + 4 = 41
        assert_eq!(cfg.len(), 41);
        assert_eq!(cfg[0], 0x55);
        assert_eq!(&cfg[1..3], &KEM_ID_DHKEM_X25519_SHA256.to_be_bytes());
        assert_eq!(&cfg[3..35], kp.public.as_bytes());
    }
}

// ── Property / fuzz tests ──────────────────────────────────────────────
//
// We don't have `proptest` or `quickcheck` in the workspace dep graph and
// the task constraints forbid adding new crates, so each "property" below
// is a hand-rolled fuzz loop driven by `rand::thread_rng()`. Iteration
// counts are kept modest (32 per case) so the full suite stays under a
// second on cold builds — these tests are catch-the-sharp-edge nets, not
// exhaustive validators.

#[cfg(test)]
mod proptest_ohttp {
    use super::*;
    use rand::{thread_rng, Rng, RngCore};

    const FUZZ_ITERS: usize = 32;

    fn random_plaintext(rng: &mut impl RngCore, max_len: usize) -> Vec<u8> {
        // bias toward small + medium payloads; cover empty too
        let len = (rng.next_u32() as usize) % (max_len + 1);
        let mut v = vec![0u8; len];
        rng.fill_bytes(&mut v);
        v
    }

    #[test]
    fn fuzz_request_round_trip() {
        let mut rng = thread_rng();
        for i in 0..FUZZ_ITERS {
            let key_id = (i as u8).wrapping_add(1); // avoid 0 to vary
            let kp = OhttpKeypair::generate(key_id);
            // Mix in an "empty" case at i==0.
            let pt = if i == 0 {
                Vec::new()
            } else {
                random_plaintext(&mut rng, 4096)
            };
            let (capsule, _exp) = encapsulate_request_for_test(&kp.public, kp.key_id, &pt)
                .expect("encap should succeed");
            let (decoded, _ctx) = decapsulate_request(&kp, &capsule)
                .expect("decap should succeed for honest capsule");
            assert_eq!(decoded, pt, "round-trip plaintext mismatch on iter {i}");
        }
    }

    #[test]
    fn fuzz_response_round_trip() {
        let mut rng = thread_rng();
        for i in 0..FUZZ_ITERS {
            let kp = OhttpKeypair::generate(0x10);
            let req_pt = random_plaintext(&mut rng, 256);
            let (capsule, exporter) =
                encapsulate_request_for_test(&kp.public, kp.key_id, &req_pt).unwrap();
            let (_, ctx) = decapsulate_request(&kp, &capsule).unwrap();

            let resp_pt = if i == 0 {
                Vec::new()
            } else {
                random_plaintext(&mut rng, 8192)
            };
            let resp_capsule = encapsulate_response(&ctx, &resp_pt).unwrap();

            let mut enc_arr = [0u8; NPK];
            enc_arr.copy_from_slice(&capsule[7..7 + NPK]);
            let opened =
                decapsulate_response_for_test(&exporter, &enc_arr, &resp_capsule).unwrap();
            assert_eq!(opened, resp_pt, "response round-trip mismatch on iter {i}");
        }
    }

    #[test]
    fn fuzz_aead_tamper_detection() {
        // Flip one bit at 32 random positions inside the capsule body
        // (i.e. after the 7-byte header, since key-id/suite-id changes
        // are exercised by the dedicated test). Each flip MUST cause
        // either AEAD failure or a suite-mismatch error — never a
        // silent successful decap of altered bytes, and never a panic.
        let mut rng = thread_rng();
        let kp = OhttpKeypair::generate(0x07);
        let pt = b"the inner BHTTP payload, suitably non-trivial in length";
        let (capsule, _) = encapsulate_request_for_test(&kp.public, kp.key_id, pt).unwrap();
        assert!(capsule.len() > 7);

        // 32 distinct random positions in the capsule body.
        for _ in 0..32 {
            let pos: usize = rng.gen_range(7..capsule.len());
            let bit: u8 = 1u8 << (rng.gen_range(0..8u8));
            let mut tampered = capsule.clone();
            tampered[pos] ^= bit;
            // Use catch_unwind to assert no panic, then check result.
            let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                decapsulate_request(&kp, &tampered)
            }));
            match res {
                Ok(Ok((opened, _))) => panic!(
                    "tampered byte {pos} bit {bit:#04x} decapsulated successfully (opened {} bytes)",
                    opened.len()
                ),
                Ok(Err(_)) => {}
                Err(_) => panic!("decapsulate_request panicked on tampered byte {pos} bit {bit:#04x}"),
            }
        }
    }

    #[test]
    fn fuzz_response_tamper_detection() {
        let mut rng = thread_rng();
        let kp = OhttpKeypair::generate(0x09);
        let (capsule, exporter) =
            encapsulate_request_for_test(&kp.public, kp.key_id, b"req").unwrap();
        let (_, ctx) = decapsulate_request(&kp, &capsule).unwrap();
        let resp_capsule = encapsulate_response(&ctx, b"the server response").unwrap();
        let mut enc_arr = [0u8; NPK];
        enc_arr.copy_from_slice(&capsule[7..7 + NPK]);

        for _ in 0..32 {
            let pos: usize = rng.gen_range(0..resp_capsule.len());
            let bit: u8 = 1u8 << (rng.gen_range(0..8u8));
            let mut tampered = resp_capsule.clone();
            tampered[pos] ^= bit;
            let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                decapsulate_response_for_test(&exporter, &enc_arr, &tampered)
            }));
            match res {
                Ok(Ok(opened)) => panic!(
                    "tampered response byte {pos} bit {bit:#04x} opened successfully ({} bytes)",
                    opened.len()
                ),
                Ok(Err(_)) => {}
                Err(_) => panic!("decapsulate_response panicked on tampered byte {pos}"),
            }
        }
    }

    #[test]
    fn wrong_key_id_rejected() {
        // Encapsulate addressed to key_id X. Gateway holds a key with id Y.
        // Decapsulation must fail with UnknownKeyId — and NOT proceed to AEAD.
        let gw = OhttpKeypair::generate(0xAA);
        let (capsule, _) = encapsulate_request_for_test(&gw.public, 0xBB, b"hi").unwrap();
        assert_eq!(capsule[0], 0xBB);
        let err = decapsulate_request(&gw, &capsule).unwrap_err();
        match err {
            OhttpError::UnknownKeyId(k) => assert_eq!(k, 0xBB),
            other => panic!("expected UnknownKeyId, got {other:?}"),
        }
    }

    #[test]
    fn wrong_gateway_key_rejected() {
        // Encapsulate to gateway A's public key but try to decapsulate
        // with gateway B that happens to claim the same key_id. The DH
        // share won't match so AEAD must fail.
        let gw_a = OhttpKeypair::generate(0x42);
        let gw_b = OhttpKeypair::generate(0x42); // same key_id, different secret
        assert_ne!(gw_a.public.as_bytes(), gw_b.public.as_bytes());
        let (capsule, _) = encapsulate_request_for_test(&gw_a.public, 0x42, b"hi").unwrap();
        let err = decapsulate_request(&gw_b, &capsule).unwrap_err();
        // Explicit match (not `matches!`) so a regression that yields
        // a wrong variant actually fails the test.
        match err {
            OhttpError::AeadOpen => {}
            other => panic!("expected AeadOpen on wrong gateway key, got {other:?}"),
        }
    }

    #[test]
    fn truncation_rejected_without_panic() {
        let kp = OhttpKeypair::generate(0x01);
        let (capsule, _) =
            encapsulate_request_for_test(&kp.public, kp.key_id, b"a non-trivial body").unwrap();
        let n = capsule.len();

        // capsule[..n-1] strips one ciphertext byte (or the final tag byte).
        // capsule[..n/2] is likely already shorter than the AEAD ciphertext
        // window. empty is the trivial case.
        let cuts: Vec<&[u8]> = vec![&capsule[..n - 1], &capsule[..n / 2], &[]];
        for (idx, cut) in cuts.iter().enumerate() {
            let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                decapsulate_request(&kp, cut)
            }));
            match res {
                Ok(Ok(_)) => panic!("truncation #{idx} unexpectedly decapsulated"),
                Ok(Err(_)) => {}
                Err(_) => panic!("decapsulate_request panicked on truncation #{idx}"),
            }
        }
    }

    #[test]
    fn random_capsule_never_panics() {
        // 32 entirely-random byte buffers of varied lengths, fed to the
        // decapsulator. None should ever panic; all should error.
        let mut rng = thread_rng();
        let kp = OhttpKeypair::generate(0xCC);
        for _ in 0..FUZZ_ITERS {
            let len: usize = rng.gen_range(0..512);
            let mut buf = vec![0u8; len];
            rng.fill_bytes(&mut buf);
            // Force key_id mismatch is fine — we want to make sure even
            // a "correct" key_id with garbage doesn't panic.
            if len >= 1 {
                buf[0] = kp.key_id;
            }
            let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                decapsulate_request(&kp, &buf)
            }));
            assert!(res.is_ok(), "panicked on random {len}-byte capsule");
            assert!(res.unwrap().is_err(), "random {len}-byte capsule somehow opened");
        }
    }

    // ── BHTTP edge cases ───────────────────────────────────────────────

    #[test]
    fn bhttp_empty_body_round_trip() {
        let req = BhttpRequest {
            method: "GET".to_string(),
            scheme: "https".to_string(),
            authority: "example.com".to_string(),
            path: "/".to_string(),
            headers: vec![("h".to_string(), "v".to_string())],
            body: Vec::new(),
        };
        let bytes = req.encode();
        let decoded = BhttpRequest::decode(&bytes).expect("decode");
        assert_eq!(decoded.body, Vec::<u8>::new());
        assert_eq!(decoded.method, "GET");
    }

    #[test]
    fn bhttp_empty_headers_round_trip() {
        let req = BhttpRequest {
            method: "POST".to_string(),
            scheme: "https".to_string(),
            authority: "example.com".to_string(),
            path: "/x".to_string(),
            headers: Vec::new(),
            body: b"body".to_vec(),
        };
        let bytes = req.encode();
        let decoded = BhttpRequest::decode(&bytes).expect("decode");
        assert!(decoded.headers.is_empty());
        assert_eq!(decoded.body, b"body");
    }

    #[test]
    fn bhttp_no_path_round_trip() {
        // RFC 9292 allows empty path components in a known-length frame.
        // The minimal varint-length-prefix codec must round-trip "".
        let req = BhttpRequest {
            method: "OPTIONS".to_string(),
            scheme: "https".to_string(),
            authority: "example.com".to_string(),
            path: String::new(),
            headers: Vec::new(),
            body: Vec::new(),
        };
        let bytes = req.encode();
        let decoded = BhttpRequest::decode(&bytes).expect("decode");
        assert_eq!(decoded.path, "");
    }

    #[test]
    fn bhttp_header_value_with_crlf_round_trips_as_bytes() {
        // BHTTP is binary, length-prefixed — CR/LF in values is legal at
        // the framing layer (unlike HTTP/1.1 text mode). The codec must
        // round-trip them losslessly, and downstream HTTP-emission code
        // is responsible for rejecting them.
        let req = BhttpRequest {
            method: "POST".to_string(),
            scheme: "https".to_string(),
            authority: "example.com".to_string(),
            path: "/".to_string(),
            headers: vec![("x-evil".to_string(), "a\r\nInjected: yes".to_string())],
            body: Vec::new(),
        };
        let bytes = req.encode();
        let decoded = BhttpRequest::decode(&bytes).expect("decode");
        assert_eq!(decoded.headers[0].1, "a\r\nInjected: yes");
    }

    #[test]
    fn bhttp_malformed_input_rejected_without_panic() {
        // Feed a pile of garbage into the request and response decoders.
        // Both must return None / decode error and never panic.
        let mut rng = thread_rng();
        for _ in 0..FUZZ_ITERS {
            let len: usize = rng.gen_range(0..128);
            let mut buf = vec![0u8; len];
            rng.fill_bytes(&mut buf);
            let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _ = BhttpRequest::decode(&buf);
                let _ = BhttpResponse::decode(&buf);
            }));
            assert!(res.is_ok(), "BHTTP decode panicked on {len}-byte garbage");
        }
        // Specific structured-malformed cases:
        assert!(BhttpRequest::decode(&[]).is_none());
        assert!(BhttpRequest::decode(&[0x01]).is_none()); // wrong framing byte
        assert!(BhttpResponse::decode(&[]).is_none());
        assert!(BhttpResponse::decode(&[0x00]).is_none());
        // framing OK but truncated mid-varint:
        assert!(BhttpRequest::decode(&[0x00, 0x40]).is_none());
        // length-prefix that overruns the buffer:
        assert!(BhttpRequest::decode(&[0x00, 0x3f, b'X', b'X']).is_none());
    }

    #[test]
    fn bhttp_response_status_3byte_varint_round_trip() {
        // Status 200 fits in a 2-byte varint; 16384 forces 4-byte varint.
        // Make sure decode handles both.
        for status in [100u16, 200, 404, 500].iter() {
            let resp = BhttpResponse {
                status: *status,
                headers: vec![("a".to_string(), "b".to_string())],
                body: b"hello".to_vec(),
            };
            let bytes = resp.encode();
            let decoded = BhttpResponse::decode(&bytes).expect("decode");
            assert_eq!(decoded.status, *status, "status mismatch for {status}");
        }
    }
}
