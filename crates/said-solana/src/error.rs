use thiserror::Error;

#[derive(Debug, Error)]
pub enum SolanaError {
    #[error("client error: {0}")]
    Client(String),
    #[error("transaction error: {0}")]
    Transaction(String),
    #[error("identity not found")]
    IdentityNotFound,
    #[error("deserialization error: {0}")]
    Deserialization(String),
}

pub type Result<T> = std::result::Result<T, SolanaError>;
