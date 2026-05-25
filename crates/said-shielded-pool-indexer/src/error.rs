//! Indexer + forester error type.

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(thiserror::Error, Debug)]
pub enum Error {
    /// Invalid configuration (env var parse error, missing required value).
    #[error("invalid config: {0}")]
    ConfigInvalid(String),

    /// The on-disk sled database is corrupted or otherwise unreadable.
    #[error("storage error: {0}")]
    Storage(String),

    /// Tree is full — the depth-26 incremental tree has accepted 2^26
    /// commitments. A new tree-id must be allocated by the on-chain program.
    #[error("merkle tree full at index {0}")]
    TreeFull(u64),

    /// A commitment query (`/witness?commitment=…`) did not match any
    /// leaf in the local mirror. The caller should retry once the indexer
    /// has caught up.
    #[error("commitment not found in tree")]
    CommitmentNotFound,

    /// The supplied leaf index is past `next_index` (tree state desynced).
    #[error("leaf index {0} out of range (tree has {1} leaves)")]
    LeafIndexOutOfRange(u64, u64),

    /// Poseidon hash failure from `light-poseidon` (input arity mismatch,
    /// non-canonical field elt, etc.). Should not happen in practice given
    /// a 2-arity tree, but surface it rather than panic.
    #[error("poseidon hash error: {0}")]
    Poseidon(String),

    /// Solana JSON-RPC error returned by the backing RPC node.
    #[error("solana rpc error: {0}")]
    SolanaRpc(String),

    /// WebSocket subscription / framing error talking to the RPC node.
    #[error("solana ws error: {0}")]
    SolanaWs(String),

    /// Failed to decode a program event from base64+borsh into a known
    /// event shape (`CommitmentQueued` / `Transferred` / `RootUpdated` /
    /// `Withdrawn` / `PoolInitialized` / `TreeInitialized` / `PausedToggled` /
    /// `VerifierKeyRotated` / `FeeUpdated`).
    #[error("event decode error: {0}")]
    EventDecode(String),

    /// The prover service returned a non-2xx, or its response body wasn't
    /// a valid Groth16 `ProofBundle`.
    #[error("prover service error: {0}")]
    Prover(String),

    /// Failed to load / parse the forester's signing keypair file.
    #[error("forester keypair error: {0}")]
    ForesterKey(String),

    /// Generic forester-side failure (witness shape mismatch, ix encoding
    /// error, etc.) not covered by another variant.
    #[error("forester error: {0}")]
    Forester(String),

    /// HTTP error (reqwest, axum, tungstenite).
    #[error("http error: {0}")]
    Http(String),

    /// Generic IO error.
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    /// JSON (de)serialization error.
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    /// Bubble-up from the shared types crate.
    #[error("types error: {0}")]
    Types(#[from] said_shielded_pool_types::Error),

    /// Bubble-up from reqwest.
    #[error("reqwest error: {0}")]
    Reqwest(#[from] reqwest::Error),

    /// Bubble-up from sled.
    #[error("sled error: {0}")]
    Sled(#[from] sled::Error),
}
