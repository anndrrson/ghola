//! Unsigned transition payload that the client ships to the
//! shielded-payment adapter for broadcast.
//!
//! Per the Tier 2K doc §4.2 the on-chain transition is built locally
//! and the adapter only sees the payload it needs to broadcast and
//! verify. Concretely, this is the request body POSTed to the
//! adapter's `/verify` endpoint.

use serde::{Deserialize, Serialize};

/// Unsigned transition request — what the client builds and the
/// broadcaster forwards to the adapter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShieldedTransitionRequest {
    /// Aleo program id, e.g. `"ghola_pay.aleo"`.
    pub program: String,
    /// Function within the program, e.g. `"pay"`.
    pub function: String,
    /// Caller's Aleo address (derived from Turnkey signature).
    pub sender_address: String,
    /// Provider's Aleo address.
    pub recipient_address: String,
    /// Settlement amount in micro-USDC (1 USDC = 1_000_000).
    pub amount_micro_usdc: u64,
    /// Aleo network tag, e.g. `"aleo:mainnet"` or `"aleo:testnet3"`.
    pub network: String,
    /// Client-generated 16-byte nonce. Prevents the adapter from
    /// re-broadcasting an identical replayed transition request.
    pub nonce: [u8; 16],
}

impl ShieldedTransitionRequest {
    /// Construct a new request. Pure data; no network IO.
    pub fn new(
        program: impl Into<String>,
        function: impl Into<String>,
        sender_address: impl Into<String>,
        recipient_address: impl Into<String>,
        amount_micro_usdc: u64,
        network: impl Into<String>,
        nonce: [u8; 16],
    ) -> Self {
        Self {
            program: program.into(),
            function: function.into(),
            sender_address: sender_address.into(),
            recipient_address: recipient_address.into(),
            amount_micro_usdc,
            network: network.into(),
            nonce,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> ShieldedTransitionRequest {
        ShieldedTransitionRequest::new(
            "ghola_pay.aleo",
            "pay",
            "aleo1sender",
            "aleo1recipient",
            12_345,
            "aleo:testnet3",
            [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
        )
    }

    #[test]
    fn serde_round_trip() {
        let req = fixture();
        let encoded = serde_json::to_string(&req).unwrap();
        let decoded: ShieldedTransitionRequest = serde_json::from_str(&encoded).unwrap();
        assert_eq!(req, decoded);
    }

    #[test]
    fn json_fields_are_snake_case_stable() {
        let req = fixture();
        let v = serde_json::to_value(&req).unwrap();
        for f in [
            "program",
            "function",
            "sender_address",
            "recipient_address",
            "amount_micro_usdc",
            "network",
            "nonce",
        ] {
            assert!(v.get(f).is_some(), "missing field {f}");
        }
    }

    #[test]
    fn nonce_serializes_as_byte_array() {
        let req = fixture();
        let v = serde_json::to_value(&req).unwrap();
        let arr = v.get("nonce").unwrap().as_array().unwrap();
        assert_eq!(arr.len(), 16);
        assert_eq!(arr[0].as_u64().unwrap(), 1);
        assert_eq!(arr[15].as_u64().unwrap(), 16);
    }
}
