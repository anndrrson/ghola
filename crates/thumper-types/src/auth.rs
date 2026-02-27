use serde::{Deserialize, Serialize};

/// Authentication message sent as the first WebSocket frame.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthMessage {
    /// Wallet public key as base58.
    pub pubkey: String,
    /// Unix timestamp in seconds.
    pub timestamp: u64,
    /// Random nonce to prevent replay.
    pub nonce: String,
    /// Connection role.
    pub role: ConnectionRole,
}

/// Ed25519-signed authentication payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthPayload {
    pub message: AuthMessage,
    /// Ed25519 signature of the canonical message bytes, base64-encoded.
    pub signature: String,
}

/// Whether this connection is a device or an MCP client.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionRole {
    Device,
    McpClient,
}

impl AuthMessage {
    /// Produce the canonical byte representation for signing/verification.
    pub fn canonical_bytes(&self) -> Vec<u8> {
        format!(
            "thumper-auth:{}:{}:{}:{}",
            self.pubkey,
            self.timestamp,
            self.nonce,
            match self.role {
                ConnectionRole::Device => "device",
                ConnectionRole::McpClient => "mcp_client",
            }
        )
        .into_bytes()
    }
}
