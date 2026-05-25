//! Ghola SAID shielded pool — Groth16-verified anonymous payments on Solana.
//!
//! Phases 38 + 40: real verifier wiring + admin / pause controls.
//! Phase 45 (Stream 4): governance hardening — timelocked admin/vk rotation,
//! forester-set authorization, multi-deposit queue, decoy traffic, evidence
//! attestation, V1 → V2 state migration.
//!
//! Architecture:
//!   - One `PoolConfig` PDA + one `VerifierKey` PDA hold global state.
//!   - One `MerkleTree` PDA per supported SPL/Token-2022 mint.
//!   - Deposits transfer SPL → escrow and queue `CommitmentRecord` PDAs.
//!   - Transfers/withdrawals verify a Groth16 proof against the VK PDA,
//!     write per-nullifier marker PDAs (existence == spent), and queue
//!     output commitments.
//!   - The off-chain forester (`crates/said-shielded-pool-indexer`) folds
//!     queued commitments into the tree and submits a batched root-update
//!     proof via `update_root_via_proof`.
//!
//! On-chain wire encodings (32-byte big-endian BN254 field elements,
//! `[u8; 32]` Poseidon outputs, etc.) MUST stay byte-compatible with
//! `crates/said-shielded-pool-types`. We don't depend on that crate
//! because its `serde`/`sha2`/`thiserror` chain bloats the BPF binary.

use anchor_lang::prelude::*;

pub mod crypto;
pub mod error;
pub mod events;
pub mod groth16;
pub mod instructions;
pub mod state;
#[cfg(feature = "real-verifier")]
pub mod verifying_key;
#[cfg(feature = "real-verifier")]
pub mod forester_verifying_key;

pub use instructions::*;

declare_id!("5bmCDeaQceBpWgK8aADB4Tz4JzqZ9hkCi3qedC6oZR8A");

#[program]
pub mod said_shielded_pool {
    use super::*;

    /// Initialize the global `PoolConfig` and `VerifierKey` PDAs.
    pub fn init_pool(
        ctx: Context<InitPool>,
        fee_bps: u16,
        verifier_key_bytes: Vec<u8>,
    ) -> Result<()> {
        instructions::init_pool::init_pool_handler(ctx, fee_bps, verifier_key_bytes)
    }

    /// Initialize a per-mint `MerkleTree` PDA.
    pub fn init_tree(ctx: Context<InitTree>, initial_root: [u8; 32]) -> Result<()> {
        instructions::init_pool::init_tree_handler(ctx, initial_root)
    }

    /// Deposit SPL/Token-2022 into the shielded pool, queueing a commitment.
    pub fn deposit(ctx: Context<Deposit>, amount: u64, commitment: [u8; 32]) -> Result<()> {
        instructions::deposit::deposit_handler(ctx, amount, commitment)
    }

    /// Shielded → shielded transfer (2-in / 2-out).
    pub fn transfer(ctx: Context<Transfer>, args: TransferArgs) -> Result<()> {
        instructions::transfer::transfer_handler(ctx, args)
    }

    /// Shielded → clear-text withdrawal with optional relayer fee.
    pub fn withdraw(ctx: Context<Withdraw>, args: WithdrawArgs) -> Result<()> {
        instructions::withdraw::withdraw_handler(ctx, args)
    }

    /// Forester-submitted batched root rotation, Groth16-verified.
    pub fn update_root_via_proof(ctx: Context<UpdateRoot>, args: UpdateRootArgs) -> Result<()> {
        instructions::update_root::update_root_handler(ctx, args)
    }

    // --- admin (immediate) ---

    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        instructions::admin::set_paused_handler(ctx, paused)
    }

    pub fn set_fee_bps(ctx: Context<AdminOnly>, fee_bps: u16) -> Result<()> {
        instructions::admin::set_fee_bps_handler(ctx, fee_bps)
    }

    // --- governance (timelocked + immediate set ops) ---

    pub fn propose_admin_change(
        ctx: Context<GovernanceAdmin>,
        new_admin: Pubkey,
    ) -> Result<()> {
        instructions::governance::propose_admin_change_handler(ctx, new_admin)
    }

    pub fn accept_admin_change(ctx: Context<AcceptAdminChange>) -> Result<()> {
        instructions::governance::accept_admin_change_handler(ctx)
    }

    // NOTE (H2): the on-chain VK-rotation governance path
    // (`propose_vk_rotation` / `accept_vk_rotation`) has been REMOVED.
    // The Groth16 verifying key is compiled into the program binary
    // (see `groth16.rs`), so rotating the on-chain `VerifierKey` PDA had
    // no effect on actual proof verification — it was a cosmetic action
    // that gave a false sense of control. Changing the active VK now
    // requires a program upgrade + fresh trusted-setup ceremony. See
    // `docs/shielded-pool/GOVERNANCE.md` for the upgrade runbook.

    pub fn cancel_proposal(
        ctx: Context<GovernanceAdmin>,
        which: crate::state::ProposalKind,
    ) -> Result<()> {
        instructions::governance::cancel_proposal_handler(ctx, which)
    }

    pub fn set_forester_set(
        ctx: Context<GovernanceAdmin>,
        set: [Pubkey; crate::state::FORESTER_SET_LEN],
    ) -> Result<()> {
        instructions::governance::set_forester_set_handler(ctx, set)
    }

    pub fn set_pause_authority(
        ctx: Context<GovernanceAdmin>,
        new_pause_authority: Pubkey,
    ) -> Result<()> {
        instructions::governance::set_pause_authority_handler(ctx, new_pause_authority)
    }

    // --- migration ---

    pub fn migrate_config(ctx: Context<MigrateConfig>) -> Result<()> {
        instructions::migrate_config::migrate_config_handler(ctx)
    }

    // --- evidence attestation ---

    pub fn attest_evidence(
        ctx: Context<AttestEvidence>,
        evidence_root: [u8; 32],
        commit_slot: u64,
    ) -> Result<()> {
        instructions::attest_evidence::attest_evidence_handler(ctx, evidence_root, commit_slot)
    }
}
