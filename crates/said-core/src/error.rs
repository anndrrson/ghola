use thiserror::Error;

pub type Result<T> = std::result::Result<T, SaidError>;

#[derive(Debug, Error)]
pub enum SaidError {
    #[error("wallet already exists at {0}")]
    WalletExists(String),

    #[error("wallet not found at {0}")]
    WalletNotFound(String),

    #[error("encryption error: {0}")]
    Encryption(String),

    #[error("decryption error: {0}")]
    Decryption(String),

    #[error("key derivation error: {0}")]
    KeyDerivation(String),

    #[error("invalid mnemonic: {0}")]
    InvalidMnemonic(String),

    #[error("storage error: {0}")]
    Storage(String),

    #[error("serialization error: {0}")]
    Serialization(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("not found: {0}")]
    NotFound(String),

    #[error("ucan error: {0}")]
    Ucan(String),

    #[error("auth error: {0}")]
    Auth(String),

    #[error("session expired")]
    SessionExpired,

    #[error("session revoked")]
    SessionRevoked,

    #[error("insufficient capability: requires {0}")]
    InsufficientCapability(String),

    #[error("solana error: {0}")]
    Solana(String),
}
