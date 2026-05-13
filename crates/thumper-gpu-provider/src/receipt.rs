//! v2 receipts signed by the enclave's Ed25519 key.
//!
//! Wire shape matches `apps/web/src/lib/receipt.ts::ReceiptV1` exactly:
//! the web verifier serializes `ReceiptBody` with a fixed key order and
//! signs sha256 of that JSON. We mirror the same key order here so the
//! signatures cross-verify with the TypeScript client.

use anyhow::Result;
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey as EdSigningKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use said_envelope::did_key_from_verifying;
use thumper_types::{EnclaveKeyId, InferenceRequestPayload};

/// v2 receipt produced by the in-enclave provider. Field order must
/// match `apps/web/src/lib/receipt.ts::RECEIPT_BODY_KEYS` because the
/// signature commits to `JSON.stringify(orderedBody)` — re-ordering
/// keys would invalidate the signature.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReceiptV1 {
    pub version: u8,
    pub job_id: String,
    pub mode: String,
    pub provider_id: String,
    pub model_id: Option<String>,
    pub input_token_hash: String,
    pub output_token_hash: String,
    pub issued_at: i64,
    pub enclave_key_id: Option<String>,
    pub attestation_hash: Option<String>,
    pub measurement: Option<String>,
    pub signer_did: String,
    /// base64 standard, of the Ed25519 signature over sha256 of the
    /// canonicalized body.
    pub signature: String,
}

/// Final response payload wrapped in the sealed envelope sent back to
/// the client. The web's sealed-stream consumer pulls `text` for the
/// chat surface and `receipt` for the receipt badge.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InferenceResponseWithReceipt {
    pub text: String,
    pub receipt: ReceiptV1,
}

/// Inputs needed to mint a receipt for a single inference round.
pub struct ReceiptInputs<'a> {
    pub job_id: String,
    pub provider_id: String,
    pub req: &'a InferenceRequestPayload,
    pub response_text: &'a str,
    pub enclave_key_id: EnclaveKeyId,
    /// Hex sha256 of the raw vendor attestation quote bytes — gives
    /// the web client something to cross-check against
    /// `GET /attestations/<hash>` without re-shipping the full doc.
    pub attestation_hash: String,
    /// Hex measurement (`PCR0||PCR1||PCR2` for Nitro) — opaque to the
    /// receipt, surfaced so the verifier can compare against the
    /// allowlisted set.
    pub measurement: String,
    pub issued_at_ms: i64,
}

pub fn build(inputs: ReceiptInputs<'_>, signing: &EdSigningKey) -> Result<ReceiptV1> {
    let prompt = canonical_prompt(inputs.req);
    let input_token_hash = hash_utf8(&prompt);
    let output_token_hash = hash_utf8(inputs.response_text);

    let signer_did = did_key_from_verifying(&signing.verifying_key());

    // Canonical body — same key order as the web's RECEIPT_BODY_KEYS.
    let body_json = canonical_body_json(
        inputs.job_id.as_str(),
        "private",
        inputs.provider_id.as_str(),
        inputs.req.model_id.as_str(),
        &input_token_hash,
        &output_token_hash,
        inputs.issued_at_ms,
        Some(inputs.enclave_key_id.0.as_str()),
        Some(inputs.attestation_hash.as_str()),
        Some(inputs.measurement.as_str()),
    );

    let digest = Sha256::digest(body_json.as_bytes());
    let sig = signing.sign(&digest);
    let signature_b64 = base64::engine::general_purpose::STANDARD.encode(sig.to_bytes());

    Ok(ReceiptV1 {
        version: 1,
        job_id: inputs.job_id,
        mode: "private".to_string(),
        provider_id: inputs.provider_id,
        model_id: Some(inputs.req.model_id.clone()),
        input_token_hash,
        output_token_hash,
        issued_at: inputs.issued_at_ms,
        enclave_key_id: Some(inputs.enclave_key_id.0),
        attestation_hash: Some(inputs.attestation_hash),
        measurement: Some(inputs.measurement),
        signer_did,
        signature: signature_b64,
    })
}

/// Stable string representation of the inference prompt that matches
/// what the web client hashes for `input_token_hash`. We concatenate
/// the optional system prompt with role-tagged messages joined by `\n`.
/// The web side uses the same per-message text shape it sends to the
/// model — this is a best-effort match that lets the verifier re-hash
/// the prompt without serializing the whole structured payload.
fn canonical_prompt(req: &InferenceRequestPayload) -> String {
    let mut out = String::new();
    if let Some(sys) = req.system.as_deref() {
        out.push_str("system:");
        out.push_str(sys);
        out.push('\n');
    }
    for m in &req.messages {
        out.push_str(&m.role);
        out.push(':');
        out.push_str(&m.content);
        out.push('\n');
    }
    out
}

fn hash_utf8(s: &str) -> String {
    let d = Sha256::digest(s.as_bytes());
    hex::encode(d)
}

/// Mirror of `apps/web/src/lib/receipt.ts::canonicalizeBody`.
///
/// We build the JSON by hand to guarantee the key order matches the
/// TypeScript side regardless of which `serde_json` map implementation
/// is in use. The web ordering is:
/// `version, job_id, mode, provider_id, model_id, input_token_hash,
/// output_token_hash, issued_at, enclave_key_id, attestation_hash,
/// measurement`.
#[allow(clippy::too_many_arguments)]
fn canonical_body_json(
    job_id: &str,
    mode: &str,
    provider_id: &str,
    model_id: &str,
    input_token_hash: &str,
    output_token_hash: &str,
    issued_at_ms: i64,
    enclave_key_id: Option<&str>,
    attestation_hash: Option<&str>,
    measurement: Option<&str>,
) -> String {
    fn esc(s: &str) -> String {
        // Use serde_json's string escape rules so we don't have to
        // reimplement RFC 8259 — just take a Value::String and
        // serialize it.
        serde_json::Value::String(s.to_string()).to_string()
    }
    fn maybe_str(v: Option<&str>) -> String {
        match v {
            Some(s) => esc(s),
            None => "null".to_string(),
        }
    }
    format!(
        "{{\"version\":1,\"job_id\":{job_id},\"mode\":{mode},\"provider_id\":{provider_id},\
\"model_id\":{model_id},\"input_token_hash\":{input_token_hash},\
\"output_token_hash\":{output_token_hash},\"issued_at\":{issued_at},\
\"enclave_key_id\":{enclave_key_id},\"attestation_hash\":{attestation_hash},\
\"measurement\":{measurement}}}",
        job_id = esc(job_id),
        mode = esc(mode),
        provider_id = esc(provider_id),
        model_id = esc(model_id),
        input_token_hash = esc(input_token_hash),
        output_token_hash = esc(output_token_hash),
        issued_at = issued_at_ms,
        enclave_key_id = maybe_str(enclave_key_id),
        attestation_hash = maybe_str(attestation_hash),
        measurement = maybe_str(measurement),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Verifier, VerifyingKey};
    use thumper_types::InferenceChatMessage;

    fn fresh_signing() -> EdSigningKey {
        let mut seed = [0u8; 32];
        rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut seed);
        EdSigningKey::from_bytes(&seed)
    }

    fn sample_req() -> InferenceRequestPayload {
        InferenceRequestPayload {
            job_id: "job-1".into(),
            model_id: "llama3:8b".into(),
            messages: vec![InferenceChatMessage {
                role: "user".into(),
                content: "hello".into(),
            }],
            system: Some("you are helpful".into()),
            max_tokens: 64,
            stream: false,
            temperature: None,
        }
    }

    #[test]
    fn receipt_signature_verifies() {
        let sk = fresh_signing();
        let req = sample_req();
        let r = build(
            ReceiptInputs {
                job_id: "job-1".into(),
                provider_id: "prov-1".into(),
                req: &req,
                response_text: "hi there",
                enclave_key_id: EnclaveKeyId("a".repeat(64)),
                attestation_hash: "b".repeat(64),
                measurement: "c".repeat(96),
                issued_at_ms: 1_700_000_000_000,
            },
            &sk,
        )
        .unwrap();

        // Re-derive the body, hash, and verify the signature against
        // the embedded signer_did.
        let body = canonical_body_json(
            &r.job_id,
            &r.mode,
            &r.provider_id,
            r.model_id.as_deref().unwrap(),
            &r.input_token_hash,
            &r.output_token_hash,
            r.issued_at,
            r.enclave_key_id.as_deref(),
            r.attestation_hash.as_deref(),
            r.measurement.as_deref(),
        );
        let digest = Sha256::digest(body.as_bytes());
        let sig_bytes = base64::engine::general_purpose::STANDARD
            .decode(&r.signature)
            .unwrap();
        let sig = ed25519_dalek::Signature::from_slice(&sig_bytes).unwrap();
        let vk: VerifyingKey = said_envelope::verifying_from_did_key(&r.signer_did).unwrap();
        vk.verify(&digest, &sig).expect("signature must verify");
    }

    #[test]
    fn body_matches_web_key_order() {
        // The web's RECEIPT_BODY_KEYS array starts with `version`. Any
        // accidental re-ordering here would break cross-runtime
        // signature verification.
        let body = canonical_body_json(
            "j", "private", "p", "m", "i", "o", 1, Some("e"), Some("a"), Some("ms"),
        );
        let want_prefix = "{\"version\":1,\"job_id\":\"j\",\"mode\":\"private\"";
        assert!(body.starts_with(want_prefix), "body was: {}", body);
    }
}
