//! `attest_evidence` — admin pushes off-chain audit-evidence root onto the
//! on-chain ring buffer.
//!
//! Used by Stream 10 (Evidence Gate) to commit hashes of proof bundles,
//! indexer state snapshots, and forester batch logs on-chain. External
//! auditors can later cross-reference an off-chain artifact's hash
//! against `EvidenceLog.history` to verify the artifact was the one the
//! protocol operator committed to at a given slot.
//!
//! PDA: `[b"evidence_log"]`. Initialized lazily on first attestation via
//! `init_if_needed`.

use anchor_lang::prelude::*;

use crate::error::ShieldedPoolError;
use crate::events::EvidenceAttested;
use crate::state::{EvidenceLog, PoolConfig};

#[derive(Accounts)]
pub struct AttestEvidence<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"pool_config"],
        bump = pool_config.bump,
        has_one = admin @ ShieldedPoolError::Unauthorized,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + EvidenceLog::INIT_SPACE,
        seeds = [b"evidence_log"],
        bump,
    )]
    pub evidence_log: Account<'info, EvidenceLog>,

    pub system_program: Program<'info, System>,
}

pub fn attest_evidence_handler(
    ctx: Context<AttestEvidence>,
    evidence_root: [u8; 32],
    commit_slot: u64,
) -> Result<()> {
    require!(
        evidence_root != [0u8; 32],
        ShieldedPoolError::BadPublicInputs
    );

    let log = &mut ctx.accounts.evidence_log;
    // Initialize bump on first call (when init_if_needed creates).
    if log.bump == 0 {
        log.bump = ctx.bumps.evidence_log;
    }
    log.push(evidence_root, commit_slot);

    emit!(EvidenceAttested {
        evidence_root,
        commit_slot,
    });

    Ok(())
}
