use anchor_lang::prelude::*;

use crate::state::IdentityRecord;

#[derive(Accounts)]
pub struct UpdateProfileUri<'info> {
    #[account(
        constraint = identity.authority == authority.key(),
        constraint = identity.active,
    )]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub identity: Account<'info, IdentityRecord>,
}

pub fn handler(ctx: Context<UpdateProfileUri>, profile_uri: String) -> Result<()> {
    let identity = &mut ctx.accounts.identity;
    identity.profile_uri = profile_uri;
    identity.updated_at = Clock::get()?.unix_timestamp;
    Ok(())
}
