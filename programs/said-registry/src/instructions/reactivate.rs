use anchor_lang::prelude::*;

use crate::error::RegistryError;
use crate::events::IdentityReactivated;
use crate::state::IdentityRecord;

#[derive(Accounts)]
pub struct Reactivate<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority,
    )]
    pub identity: Account<'info, IdentityRecord>,
}

pub fn handler(ctx: Context<Reactivate>) -> Result<()> {
    let identity = &mut ctx.accounts.identity;
    require!(!identity.active, RegistryError::AlreadyActive);

    identity.active = true;
    identity.updated_at = Clock::get()?.unix_timestamp;

    emit!(IdentityReactivated {
        master_pubkey: identity.master_pubkey,
    });

    Ok(())
}
