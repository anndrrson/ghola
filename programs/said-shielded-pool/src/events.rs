use anchor_lang::prelude::*;

#[event]
pub struct PoolInitialized {
    pub admin: Pubkey,
    pub verifier_key_hash: [u8; 32],
    pub fee_bps: u16,
}

#[event]
pub struct TreeInitialized {
    pub pool: Pubkey,
    pub mint: Pubkey,
    pub depth: u8,
    pub initial_root: [u8; 32],
}

#[event]
pub struct CommitmentQueued {
    pub tree: Pubkey,
    pub queue_index: u64,
    pub commitment: [u8; 32],
    pub amount: u64,
}

#[event]
pub struct Transferred {
    pub tree: Pubkey,
    pub input_nullifiers: [[u8; 32]; 2],
    pub output_commitments: [[u8; 32]; 2],
    pub ext_data_hash: [u8; 32],
}

#[event]
pub struct Withdrawn {
    pub tree: Pubkey,
    pub nullifier: [u8; 32],
    pub recipient: Pubkey,
    pub amount: u64,
    pub relayer_fee: u64,
}

#[event]
pub struct RootUpdated {
    pub tree: Pubkey,
    pub new_root: [u8; 32],
    pub batch_size: u32,
}

#[event]
pub struct PausedToggled {
    pub paused: bool,
}

#[event]
pub struct VerifierKeyRotated {
    pub new_hash: [u8; 32],
}

#[event]
pub struct FeeUpdated {
    pub fee_bps: u16,
}

// ---- Stream 4: governance events ----

#[event]
pub struct AdminChangeProposed {
    pub current_admin: Pubkey,
    pub pending_admin: Pubkey,
    pub eta: i64,
}

#[event]
pub struct AdminChanged {
    pub old_admin: Pubkey,
    pub new_admin: Pubkey,
}

#[event]
pub struct VkRotationProposed {
    pub pending_vk_hash: [u8; 32],
    pub eta: i64,
}

#[event]
pub struct VkRotated {
    pub old_hash: [u8; 32],
    pub new_hash: [u8; 32],
}

#[event]
pub struct ProposalCancelled {
    /// 0 = admin change, 1 = vk rotation. Matches `state::ProposalKind`.
    pub kind: u8,
}

#[event]
pub struct ForesterSetUpdated {
    pub new_set: [Pubkey; 4],
}

#[event]
pub struct PauseAuthorityUpdated {
    pub new_pause_authority: Pubkey,
}

#[event]
pub struct ConfigMigrated {
    pub pool_config: Pubkey,
    pub migrated_trees: u32,
}

#[event]
pub struct EvidenceAttested {
    pub evidence_root: [u8; 32],
    pub commit_slot: u64,
}

#[event]
pub struct AuctionMarketInitialized {
    pub auction_market: Pubkey,
    pub market_commitment: [u8; 32],
    pub mint: Pubkey,
    pub batch_size: u16,
}

#[event]
pub struct AuctionEpochOpened {
    pub auction_epoch: Pubkey,
    pub auction_market: Pubkey,
    pub epoch_id: u64,
    pub closes_slot: u64,
}

#[event]
pub struct AuctionOrderCommitted {
    pub auction_epoch: Pubkey,
    pub order_commitment: [u8; 32],
    pub side: u8,
    pub amount_bucket: u16,
}

#[event]
pub struct AuctionEpochCleared {
    pub auction_epoch: Pubkey,
    pub clearing_commitment: [u8; 32],
    pub matched_count: u16,
    pub rolled_count: u16,
}

#[event]
pub struct AuctionClearingSettled {
    pub auction_epoch: Pubkey,
    pub clearing_commitment: [u8; 32],
    pub settlement_commitment: [u8; 32],
}

#[event]
pub struct AuctionOrderCancelled {
    pub auction_epoch: Pubkey,
    pub order_commitment: [u8; 32],
}
