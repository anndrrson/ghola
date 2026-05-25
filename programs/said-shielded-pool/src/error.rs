use anchor_lang::prelude::*;

#[error_code]
pub enum ShieldedPoolError {
    #[msg("Groth16 proof verification failed")]
    InvalidProof,
    #[msg("Nullifier has already been used (double-spend attempt)")]
    NullifierAlreadyUsed,
    #[msg("Merkle root not present in recent root history")]
    RootNotInHistory,
    #[msg("Asset id in proof does not match the mint of the escrow account")]
    AssetMismatch,
    #[msg("Public amount in proof is inconsistent with declared deposit / withdrawal value")]
    InsufficientValue,
    #[msg("Pool is currently paused")]
    Paused,
    #[msg("Signer is not the pool admin")]
    Unauthorized,
    #[msg("Verifier key bytes do not match the hash recorded in PoolConfig")]
    VerifierKeyMismatch,
    #[msg("Public input vector has unexpected length")]
    BadPublicInputs,
    #[msg("Merkle tree commitment queue is full — wait for the forester to drain")]
    QueueFull,
    #[msg("Fee basis points value out of range (max 10000)")]
    FeeOutOfRange,
    #[msg("Numerical overflow")]
    Overflow,
    #[msg("Recipient token account asset mismatch")]
    RecipientAssetMismatch,
    #[msg("Tree depth or root configuration invalid")]
    InvalidTreeConfig,

    // ---- Stream 4: governance + V2 hardening errors ----
    #[msg("Timelock has not yet elapsed for this governance proposal")]
    TimelockNotElapsed,
    #[msg("Provided value does not match the pending governance proposal")]
    ProposalMismatch,
    #[msg("No pending governance proposal exists for this slot")]
    NoPendingProposal,
    #[msg("Signer is not a member of the authorized forester set")]
    ForesterNotAuthorized,
    #[msg("Pool config V2 migration has already been applied")]
    MigrationAlreadyApplied,

    // ---- Security-review hardening (C1–C4, H2) ----
    #[msg("Declared amount does not match the proof's public_amount field element")]
    PublicAmountMismatch,
    #[msg("ext_data_hash does not bind the supplied recipient / relayer / fee context")]
    ExtDataHashMismatch,
    #[msg("A public input is not a canonical BN254 scalar field element (>= field modulus)")]
    NonCanonicalPublicInput,
    #[msg("Batched commitment does not match the queued CommitmentRecord")]
    CommitmentMismatch,
    #[msg("CommitmentRecord has already been folded into the tree")]
    CommitmentAlreadyInserted,
}
