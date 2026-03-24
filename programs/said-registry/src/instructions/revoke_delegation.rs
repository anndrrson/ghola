use anchor_lang::prelude::*;

use crate::state::{DelegationRecord, IdentityRecord};

#[derive(Accounts)]
pub struct RevokeDelegation<'info> {
    pub authority: Signer<'info>,

    /// The issuer's identity record.
    #[account(
        constraint = issuer.authority == authority.key(),
    )]
    pub issuer: Account<'info, IdentityRecord>,

    #[account(
        mut,
        constraint = delegation.issuer == issuer.key(),
        constraint = !delegation.revoked,
    )]
    pub delegation: Account<'info, DelegationRecord>,
}

pub fn handler(ctx: Context<RevokeDelegation>) -> Result<()> {
    ctx.accounts.delegation.revoked = true;
    Ok(())
}
