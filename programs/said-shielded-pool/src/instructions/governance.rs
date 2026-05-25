//! Governance instructions — timelocked admin/vk rotation, forester set,
//! and pause-authority management.
//!
//! Authority model:
//!   - **admin**: proposes timelocked changes; executes immediate non-
//!     sensitive ops (forester set, pause-authority, cancel).
//!   - **pending_admin**: signs `accept_admin_change` after the timelock
//!     elapses; can self-revoke by waiting for a new proposal.
//!   - **pause_authority**: incident-response key with `set_paused` rights
//!     (no timelock). Lower-blast-radius than full admin.
//!
//! All proposal storage lives inside `PoolConfig`. Only one admin proposal
//! and one vk proposal can be in flight at a time. Re-proposing while one
//! is pending overwrites (admin must explicitly `cancel_proposal` first —
//! enforced by `require!(pending_admin == default)` etc.) to keep audit
//! trail clean.

use anchor_lang::prelude::*;

use crate::error::ShieldedPoolError;
use crate::events::{
    AdminChangeProposed, ForesterSetUpdated, PauseAuthorityUpdated, ProposalCancelled,
};
use crate::state::{PoolConfig, ProposalKind, FORESTER_SET_LEN};

// =============================================================================
//                                ACCOUNT CONTEXTS
// =============================================================================

#[derive(Accounts)]
pub struct GovernanceAdmin<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool_config"],
        bump = pool_config.bump,
        has_one = admin @ ShieldedPoolError::Unauthorized,
    )]
    pub pool_config: Box<Account<'info, PoolConfig>>,
}

/// Signed by the `pending_admin` from a prior `propose_admin_change`.
/// No `has_one = admin` check; instead we manually verify the signer
/// matches `pool_config.pending_admin`.
#[derive(Accounts)]
pub struct AcceptAdminChange<'info> {
    pub pending_admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool_config"],
        bump = pool_config.bump,
    )]
    pub pool_config: Box<Account<'info, PoolConfig>>,
}

// =============================================================================
//                                  HANDLERS
// =============================================================================

pub fn propose_admin_change_handler(
    ctx: Context<GovernanceAdmin>,
    new_admin: Pubkey,
) -> Result<()> {
    require!(
        new_admin != Pubkey::default(),
        ShieldedPoolError::ProposalMismatch
    );

    let cfg = &mut ctx.accounts.pool_config;
    let clock = Clock::get()?;
    let eta = clock
        .unix_timestamp
        .checked_add(cfg.timelock_secs as i64)
        .ok_or(ShieldedPoolError::Overflow)?;

    cfg.pending_admin = new_admin;
    cfg.admin_change_eta = eta;

    emit!(AdminChangeProposed {
        current_admin: cfg.admin,
        pending_admin: new_admin,
        eta,
    });
    Ok(())
}

pub fn accept_admin_change_handler(ctx: Context<AcceptAdminChange>) -> Result<()> {
    let cfg = &mut ctx.accounts.pool_config;
    let signer = ctx.accounts.pending_admin.key();

    require!(
        cfg.pending_admin != Pubkey::default(),
        ShieldedPoolError::NoPendingProposal
    );
    require!(
        signer == cfg.pending_admin,
        ShieldedPoolError::Unauthorized
    );

    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp >= cfg.admin_change_eta,
        ShieldedPoolError::TimelockNotElapsed
    );

    let old_admin = cfg.admin;
    cfg.admin = signer;
    cfg.pending_admin = Pubkey::default();
    cfg.admin_change_eta = 0;

    emit!(crate::events::AdminChanged {
        old_admin,
        new_admin: signer,
    });
    Ok(())
}

// NOTE (H2 — security review): `propose_vk_rotation_handler`,
// `accept_vk_rotation_handler`, and the `AcceptVkRotation` context have
// been REMOVED. The Groth16 verifying key is COMPILED INTO the program
// binary (see `groth16.rs::verify_with_kind`), so writing new bytes into
// the `VerifierKey` PDA had ZERO effect on actual proof verification —
// the flow was cosmetic and gave a false sense of control. Changing the
// active VK requires a PROGRAM UPGRADE + a fresh trusted-setup ceremony.
// The `pending_vk_hash` / `vk_change_eta` fields remain in `PoolConfig`
// only to preserve the on-chain account byte-layout for already-deployed
// V2 PDAs; they are no longer written or read by any instruction.

pub fn cancel_proposal_handler(
    ctx: Context<GovernanceAdmin>,
    which: ProposalKind,
) -> Result<()> {
    let cfg = &mut ctx.accounts.pool_config;
    match which {
        ProposalKind::AdminChange => {
            require!(
                cfg.pending_admin != Pubkey::default(),
                ShieldedPoolError::NoPendingProposal
            );
            cfg.pending_admin = Pubkey::default();
            cfg.admin_change_eta = 0;
        }
        // VK rotation is no longer an on-chain proposal (see note above);
        // there is never anything to cancel. Reject explicitly.
        ProposalKind::VkRotation => {
            return err!(ShieldedPoolError::NoPendingProposal);
        }
    }
    emit!(ProposalCancelled { kind: which as u8 });
    Ok(())
}

pub fn set_forester_set_handler(
    ctx: Context<GovernanceAdmin>,
    set: [Pubkey; FORESTER_SET_LEN],
) -> Result<()> {
    let cfg = &mut ctx.accounts.pool_config;
    cfg.forester_set = set;
    emit!(ForesterSetUpdated { new_set: set });
    Ok(())
}

pub fn set_pause_authority_handler(
    ctx: Context<GovernanceAdmin>,
    new_pause_authority: Pubkey,
) -> Result<()> {
    let cfg = &mut ctx.accounts.pool_config;
    cfg.pause_authority = new_pause_authority;
    emit!(PauseAuthorityUpdated {
        new_pause_authority,
    });
    Ok(())
}
