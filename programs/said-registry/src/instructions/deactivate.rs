use anchor_lang::prelude::*;

use crate::error::RegistryError;
use crate::events::IdentityDeactivated;
use crate::state::IdentityRecord;

#[derive(Accounts)]
pub struct Deactivate<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority,
    )]
    pub identity: Account<'info, IdentityRecord>,
}

pub fn handler(ctx: Context<Deactivate>) -> Result<()> {
    let identity = &mut ctx.accounts.identity;
    require!(identity.active, RegistryError::AlreadyInactive);

    identity.active = false;
    identity.updated_at = Clock::get()?.unix_timestamp;

    emit!(IdentityDeactivated {
        master_pubkey: identity.master_pubkey,
    });

    Ok(())
}
