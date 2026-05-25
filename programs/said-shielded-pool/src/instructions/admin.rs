use anchor_lang::prelude::*;

use crate::error::ShieldedPoolError;
use crate::events::{FeeUpdated, PausedToggled};
use crate::state::{PoolConfig, MAX_FEE_BPS};

/// Admin-only context used for `set_fee_bps`. `set_paused` uses a
/// looser context (`SetPaused`) so the pause authority can also call it.
#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool_config"],
        bump = pool_config.bump,
        has_one = admin @ ShieldedPoolError::Unauthorized,
    )]
    pub pool_config: Account<'info, PoolConfig>,
}

/// Context for `set_paused`. Either `pool_config.admin` OR
/// `pool_config.pause_authority` may sign. No has_one shortcut — we
/// match manually inside the handler.
#[derive(Accounts)]
pub struct SetPaused<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool_config"],
        bump = pool_config.bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,
}

pub fn set_paused_handler(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
    let cfg = &mut ctx.accounts.pool_config;
    let signer = ctx.accounts.authority.key();
    require!(
        signer == cfg.admin || signer == cfg.pause_authority,
        ShieldedPoolError::Unauthorized
    );
    cfg.paused = paused;
    emit!(PausedToggled { paused });
    Ok(())
}

pub fn set_fee_bps_handler(ctx: Context<AdminOnly>, fee_bps: u16) -> Result<()> {
    require!(fee_bps <= MAX_FEE_BPS, ShieldedPoolError::FeeOutOfRange);
    ctx.accounts.pool_config.fee_bps = fee_bps;
    emit!(FeeUpdated { fee_bps });
    Ok(())
}

// NOTE: the legacy `update_verifier_key` immediate-rotate path has been
// removed. VK rotation now goes through the timelocked two-step flow in
// `instructions::governance`:
//   1. `propose_vk_rotation(new_vk_hash)` — admin commits to the SHA-256.
//   2. `accept_vk_rotation(new_vk_bytes)` — after `timelock_secs`, admin
//      submits the bytes; the program verifies `sha256(bytes) ==
//      pending_vk_hash` and writes the new vk.
// See `docs/shielded-pool/GOVERNANCE.md` § 11 (Runbooks) for the operator procedure.
