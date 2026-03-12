use anchor_lang::prelude::*;

use crate::events::AuthorityUpdated;
use crate::state::IdentityRecord;

#[derive(Accounts)]
pub struct UpdateAuthority<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority,
    )]
    pub identity: Account<'info, IdentityRecord>,

    /// CHECK: The new authority, validated by being a valid public key
    pub new_authority: AccountInfo<'info>,
}

pub fn handler(ctx: Context<UpdateAuthority>) -> Result<()> {
    let identity = &mut ctx.accounts.identity;
    let old_authority = identity.authority;
    identity.authority = ctx.accounts.new_authority.key();
    identity.updated_at = Clock::get()?.unix_timestamp;

    emit!(AuthorityUpdated {
        master_pubkey: identity.master_pubkey,
        old_authority,
        new_authority: ctx.accounts.new_authority.key(),
    });

    Ok(())
}
