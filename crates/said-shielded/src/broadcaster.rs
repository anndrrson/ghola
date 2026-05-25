//! Adapter broadcaster client.
//!
//! POSTs a signed [`ShieldedTransitionRequest`](crate::transition::ShieldedTransitionRequest)
//! to `{ADAPTER_URL}/verify`, validates the Ed25519 signature on the
//! response against the configured adapter public key, and replay-
//! checks the `(provider, receipt_or_nullifier)` tuple against a
//! pluggable cache.
//!
//! Wire shape (per Tier 2K §0):
//!
//! ```text
//! {
//!   "settled": true,
//!   "amount": 12345,
//!   "receipt_or_nullifier": "...",
//!   "provider": "aleo",
//!   "network": "aleo:mainnet",
//!   "asset": "USDCx",
//!   "destination": "aleo1...",
//!   "proof_digest": "hex",
//!   "observation_time": 1700000000,
//!   "expiration_time": 1700000600,
//!   "signature": "base64-ed25519"
//! }
//! ```
//!
//! The signature is computed by the adapter over the canonical JSON of
//! the body *without* the `signature` field — see
//! [`canonical_message_for_signature`].

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};

use crate::error::ShieldedError;
use crate::transition::ShieldedTransitionRequest;

/// Adapter-signed receipt as returned by `/verify`. Field names match
/// the wire spec verbatim — do not rename without bumping the adapter
/// protocol version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdapterReceipt {
    /// Whether the adapter considered the transition settled.
    pub settled: bool,
    /// Amount (micro-USDC) the adapter observed credited.
    pub amount: u64,
    /// Adapter-stable identifier for replay protection — typically a
    /// shielded nullifier or opaque receipt id.
    pub receipt_or_nullifier: String,
    /// Echoed provider tag, e.g. `"aleo"`.
    pub provider: String,
    /// Echoed network tag.
    pub network: String,
    /// Echoed asset tag, e.g. `"USDCx"`.
    pub asset: String,
    /// Echoed destination (recipient) address.
    pub destination: String,
    /// Hex digest of the proof the adapter verified.
    pub proof_digest: String,
    /// Adapter-side observation timestamp (unix seconds).
    pub observation_time: i64,
    /// Receipt expiration timestamp (unix seconds).
    pub expiration_time: i64,
    /// Ed25519 signature over the canonical body, base64-encoded.
    pub signature: String,
}

/// A receipt whose signature has verified and whose replay check has
/// passed. Construct only via [`AdapterClient::verify`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedReceipt {
    /// The underlying signed receipt.
    pub receipt: AdapterReceipt,
}

/// Replay cache. Production wires a Postgres-backed implementation;
/// [`MemoryReplayCache`] is the dev/test default.
#[async_trait]
pub trait ReplayCache: Send + Sync {
    /// Insert `(provider, key)` into the cache. Returns `Ok(true)` if
    /// the entry was new, `Ok(false)` if it had already been recorded
    /// (i.e. replay).
    async fn record(&self, provider: &str, key: &str) -> Result<bool, ShieldedError>;
}

/// In-memory [`ReplayCache`] backed by a `HashSet`. Tests only — real
/// deployments use the Postgres-backed `x402_payments` table.
#[derive(Debug, Default)]
pub struct MemoryReplayCache {
    seen: Mutex<HashSet<String>>,
}

impl MemoryReplayCache {
    /// Construct an empty in-memory replay cache.
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl ReplayCache for MemoryReplayCache {
    async fn record(&self, provider: &str, key: &str) -> Result<bool, ShieldedError> {
        let composite = format!("{provider}:{key}");
        let mut guard = self
            .seen
            .lock()
            .map_err(|_| ShieldedError::AdapterRejected("replay cache poisoned".into()))?;
        Ok(guard.insert(composite))
    }
}

/// HTTP transport abstraction. The default impl uses `reqwest`; tests
/// inject a fake.
#[async_trait]
pub trait AdapterTransport: Send + Sync {
    /// Send `body` to `{base_url}/verify` and return the parsed receipt
    /// (still unverified — caller validates signature + replay).
    async fn post_verify(
        &self,
        base_url: &str,
        body: &ShieldedTransitionRequest,
    ) -> Result<AdapterReceipt, ShieldedError>;
}

/// Default `reqwest`-backed [`AdapterTransport`].
#[derive(Debug, Clone)]
pub struct ReqwestTransport {
    client: reqwest::Client,
}

impl ReqwestTransport {
    /// Construct a transport with a 10 s default timeout. For custom
    /// timeouts pass a pre-built `reqwest::Client` to
    /// [`ReqwestTransport::with_client`].
    pub fn new() -> Result<Self, ShieldedError> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|e| ShieldedError::AdapterUnreachable(e.to_string()))?;
        Ok(Self { client })
    }

    /// Construct from a pre-built `reqwest::Client`.
    pub fn with_client(client: reqwest::Client) -> Self {
        Self { client }
    }
}

#[async_trait]
impl AdapterTransport for ReqwestTransport {
    async fn post_verify(
        &self,
        base_url: &str,
        body: &ShieldedTransitionRequest,
    ) -> Result<AdapterReceipt, ShieldedError> {
        let url = format!("{}/verify", base_url.trim_end_matches('/'));
        let resp = self
            .client
            .post(&url)
            .json(body)
            .send()
            .await
            .map_err(|e| ShieldedError::AdapterUnreachable(e.to_string()))?;
        if !resp.status().is_success() {
            return Err(ShieldedError::AdapterRejected(format!(
                "adapter returned status {}",
                resp.status()
            )));
        }
        resp.json::<AdapterReceipt>()
            .await
            .map_err(|e| ShieldedError::AdapterUnreachable(e.to_string()))
    }
}

/// High-level shielded-rail client. Holds the transport, the adapter's
/// public key, and the replay cache.
pub struct AdapterClient<T: AdapterTransport, C: ReplayCache> {
    base_url: String,
    transport: T,
    adapter_pubkey: VerifyingKey,
    replay: C,
}

impl<T: AdapterTransport, C: ReplayCache> AdapterClient<T, C> {
    /// Construct a client.
    pub fn new(base_url: impl Into<String>, transport: T, adapter_pubkey: VerifyingKey, replay: C) -> Self {
        Self {
            base_url: base_url.into(),
            transport,
            adapter_pubkey,
            replay,
        }
    }

    /// Submit a transition request, validate the response signature,
    /// enforce the amount floor, and replay-check.
    pub async fn verify(
        &self,
        req: &ShieldedTransitionRequest,
        required_amount: u64,
        now_unix: i64,
    ) -> Result<VerifiedReceipt, ShieldedError> {
        let receipt = self.transport.post_verify(&self.base_url, req).await?;
        verify_receipt(&receipt, &self.adapter_pubkey, required_amount, now_unix)?;
        let fresh = self
            .replay
            .record(&receipt.provider, &receipt.receipt_or_nullifier)
            .await?;
        if !fresh {
            return Err(ShieldedError::Replay);
        }
        Ok(VerifiedReceipt { receipt })
    }
}

/// Validate signature, settled flag, amount, and expiry on a receipt.
/// Exposed so callers that already have a receipt (e.g. from a relay
/// queue) can re-verify without re-broadcasting.
pub fn verify_receipt(
    receipt: &AdapterReceipt,
    pubkey: &VerifyingKey,
    required_amount: u64,
    now_unix: i64,
) -> Result<(), ShieldedError> {
    if !receipt.settled {
        return Err(ShieldedError::AdapterRejected("settled=false".into()));
    }
    if receipt.amount < required_amount {
        return Err(ShieldedError::AmountInsufficient {
            required: required_amount,
            got: receipt.amount,
        });
    }
    if receipt.expiration_time < now_unix {
        return Err(ShieldedError::Expired(receipt.expiration_time));
    }
    let sig_bytes = B64
        .decode(receipt.signature.as_bytes())
        .map_err(|_| ShieldedError::BadSignature)?;
    let sig_arr: [u8; 64] = sig_bytes
        .as_slice()
        .try_into()
        .map_err(|_| ShieldedError::BadSignature)?;
    let signature = Signature::from_bytes(&sig_arr);
    let msg = canonical_message_for_signature(receipt);
    pubkey
        .verify(&msg, &signature)
        .map_err(|_| ShieldedError::BadSignature)?;
    Ok(())
}

/// Canonical byte-string the adapter signs. Every signed field is
/// included; `signature` is excluded by construction.
///
/// Format: a sorted-key JSON object. Keep this stable across releases —
/// changing it invalidates every previously issued receipt.
pub fn canonical_message_for_signature(r: &AdapterReceipt) -> Vec<u8> {
    // Hand-rolled to guarantee byte-for-byte determinism without
    // pulling in `serde_json::Value` ordering surprises.
    let payload = serde_json::json!({
        "amount": r.amount,
        "asset": r.asset,
        "destination": r.destination,
        "expiration_time": r.expiration_time,
        "network": r.network,
        "observation_time": r.observation_time,
        "proof_digest": r.proof_digest,
        "provider": r.provider,
        "receipt_or_nullifier": r.receipt_or_nullifier,
        "settled": r.settled,
    });
    serde_json::to_vec(&payload).expect("static json payload always serializes")
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use rand::rngs::OsRng;

    fn make_signing_key() -> SigningKey {
        SigningKey::generate(&mut OsRng)
    }

    fn make_receipt(signer: &SigningKey, amount: u64, expiration: i64, nullifier: &str) -> AdapterReceipt {
        let mut r = AdapterReceipt {
            settled: true,
            amount,
            receipt_or_nullifier: nullifier.into(),
            provider: "aleo".into(),
            network: "aleo:mainnet".into(),
            asset: "USDCx".into(),
            destination: "aleo1recipient".into(),
            proof_digest: "deadbeef".into(),
            observation_time: 1_700_000_000,
            expiration_time: expiration,
            signature: String::new(),
        };
        let msg = canonical_message_for_signature(&r);
        let sig = signer.sign(&msg);
        r.signature = B64.encode(sig.to_bytes());
        r
    }

    #[test]
    fn well_formed_receipt_verifies() {
        let sk = make_signing_key();
        let r = make_receipt(&sk, 1000, 1_700_000_600, "null-1");
        verify_receipt(&r, &sk.verifying_key(), 1000, 1_700_000_500).unwrap();
    }

    #[test]
    fn tampered_amount_fails_signature() {
        let sk = make_signing_key();
        let mut r = make_receipt(&sk, 1000, 1_700_000_600, "null-1");
        r.amount = 9_999; // mutate after signing
        let err = verify_receipt(&r, &sk.verifying_key(), 1000, 1_700_000_500).unwrap_err();
        assert!(matches!(err, ShieldedError::BadSignature));
    }

    #[test]
    fn tampered_signature_fails() {
        let sk = make_signing_key();
        let mut r = make_receipt(&sk, 1000, 1_700_000_600, "null-1");
        // Flip a byte of the signature.
        let mut sig_bytes = B64.decode(r.signature.as_bytes()).unwrap();
        sig_bytes[0] ^= 0xFF;
        r.signature = B64.encode(&sig_bytes);
        let err = verify_receipt(&r, &sk.verifying_key(), 1000, 1_700_000_500).unwrap_err();
        assert!(matches!(err, ShieldedError::BadSignature));
    }

    #[test]
    fn amount_below_required_rejected() {
        let sk = make_signing_key();
        let r = make_receipt(&sk, 500, 1_700_000_600, "null-1");
        let err = verify_receipt(&r, &sk.verifying_key(), 1000, 1_700_000_500).unwrap_err();
        assert!(matches!(err, ShieldedError::AmountInsufficient { required: 1000, got: 500 }));
    }

    #[test]
    fn expired_receipt_rejected() {
        let sk = make_signing_key();
        let r = make_receipt(&sk, 1000, 1_700_000_000, "null-1");
        let err = verify_receipt(&r, &sk.verifying_key(), 1000, 1_700_000_500).unwrap_err();
        assert!(matches!(err, ShieldedError::Expired(_)));
    }

    #[test]
    fn unsettled_receipt_rejected() {
        let sk = make_signing_key();
        let mut r = make_receipt(&sk, 1000, 1_700_000_600, "null-1");
        r.settled = false;
        // settled=false short-circuits before signature verification.
        let err = verify_receipt(&r, &sk.verifying_key(), 1000, 1_700_000_500).unwrap_err();
        assert!(matches!(err, ShieldedError::AdapterRejected(_)));
    }

    #[tokio::test]
    async fn memory_replay_cache_rejects_second_submission() {
        let cache = MemoryReplayCache::new();
        let first = cache.record("aleo", "null-1").await.unwrap();
        let second = cache.record("aleo", "null-1").await.unwrap();
        assert!(first, "first insertion is new");
        assert!(!second, "second insertion must be flagged as seen");
    }

    #[tokio::test]
    async fn memory_replay_cache_partitions_by_provider() {
        let cache = MemoryReplayCache::new();
        assert!(cache.record("aleo", "k").await.unwrap());
        assert!(cache.record("zcash", "k").await.unwrap());
    }

    // --- end-to-end client test via a fake transport ---

    struct FakeTransport {
        receipt: AdapterReceipt,
    }

    #[async_trait]
    impl AdapterTransport for FakeTransport {
        async fn post_verify(
            &self,
            _base_url: &str,
            _body: &ShieldedTransitionRequest,
        ) -> Result<AdapterReceipt, ShieldedError> {
            Ok(self.receipt.clone())
        }
    }

    fn dummy_request() -> ShieldedTransitionRequest {
        ShieldedTransitionRequest::new(
            "ghola_pay.aleo",
            "pay",
            "aleo1sender",
            "aleo1recipient",
            1000,
            "aleo:mainnet",
            [0u8; 16],
        )
    }

    #[tokio::test]
    async fn adapter_client_happy_path() {
        let sk = make_signing_key();
        let receipt = make_receipt(&sk, 1000, 1_700_000_600, "null-happy");
        let client = AdapterClient::new(
            "http://test",
            FakeTransport { receipt },
            sk.verifying_key(),
            MemoryReplayCache::new(),
        );
        let v = client.verify(&dummy_request(), 1000, 1_700_000_500).await.unwrap();
        assert_eq!(v.receipt.receipt_or_nullifier, "null-happy");
    }

    #[tokio::test]
    async fn adapter_client_replay_detected_on_second_call() {
        let sk = make_signing_key();
        let receipt = make_receipt(&sk, 1000, 1_700_000_600, "null-replay");
        let client = AdapterClient::new(
            "http://test",
            FakeTransport { receipt },
            sk.verifying_key(),
            MemoryReplayCache::new(),
        );
        client.verify(&dummy_request(), 1000, 1_700_000_500).await.unwrap();
        let err = client.verify(&dummy_request(), 1000, 1_700_000_500).await.unwrap_err();
        assert!(matches!(err, ShieldedError::Replay));
    }

    #[tokio::test]
    async fn adapter_client_rejects_wrong_pubkey() {
        let signing = make_signing_key();
        let other = make_signing_key();
        let receipt = make_receipt(&signing, 1000, 1_700_000_600, "null-wrong-pk");
        let client = AdapterClient::new(
            "http://test",
            FakeTransport { receipt },
            other.verifying_key(),
            MemoryReplayCache::new(),
        );
        let err = client.verify(&dummy_request(), 1000, 1_700_000_500).await.unwrap_err();
        assert!(matches!(err, ShieldedError::BadSignature));
    }
}
