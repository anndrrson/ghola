use anchor_lang::prelude::*;

use crate::events::ServiceRegistered;
use crate::state::{DelegationRecord, IdentityRecord};

#[derive(Accounts)]
#[instruction(token_hash: [u8; 32], capabilities_hash: [u8; 32])]
pub struct RecordDelegation<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// The issuer's identity record.
    #[account(
        constraint = issuer.authority == authority.key(),
        constraint = issuer.active,
    )]
    pub issuer: Account<'info, IdentityRecord>,

    /// The audience's identity record.
    pub audience: Account<'info, IdentityRecord>,

    #[account(
        init,
        payer = authority,
        space = 8 + DelegationRecord::INIT_SPACE,
        seeds = [b"delegation", issuer.key().as_ref(), audience.key().as_ref(), token_hash.as_ref()],
        bump,
    )]
    pub delegation: Account<'info, DelegationRecord>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<RecordDelegation>,
    token_hash: [u8; 32],
    capabilities_hash: [u8; 32],
    expires_at: i64,
) -> Result<()> {
    let clock = Clock::get()?;
    let delegation = &mut ctx.accounts.delegation;
    delegation.issuer = ctx.accounts.issuer.key();
    delegation.audience = ctx.accounts.audience.key();
    delegation.capabilities_hash = capabilities_hash;
    delegation.token_hash = token_hash;
    delegation.expires_at = expires_at;
    delegation.revoked = false;
    delegation.created_at = clock.unix_timestamp;
    delegation.bump = ctx.bumps.delegation;

    // Reuse ServiceRegistered event structure for logging (or we could emit a custom event)
    // For now, emit nothing extra — the PDA creation is the proof

    Ok(())
}
