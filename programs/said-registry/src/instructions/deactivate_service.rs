use anchor_lang::prelude::*;

use crate::error::RegistryError;
use crate::events::ServiceDeactivated;
use crate::state::{IdentityRecord, ServiceRecord};

#[derive(Accounts)]
pub struct DeactivateService<'info> {
    pub authority: Signer<'info>,

    /// The identity record that owns this service.
    #[account(
        constraint = identity.authority == authority.key(),
    )]
    pub identity: Account<'info, IdentityRecord>,

    #[account(
        mut,
        constraint = service.identity_record == identity.key(),
        constraint = service.active @ RegistryError::ServiceAlreadyInactive,
    )]
    pub service: Account<'info, ServiceRecord>,
}

pub fn handler(ctx: Context<DeactivateService>) -> Result<()> {
    let clock = Clock::get()?;
    let service = &mut ctx.accounts.service;
    service.active = false;
    service.updated_at = clock.unix_timestamp;

    emit!(ServiceDeactivated {
        identity_record: ctx.accounts.identity.key(),
        slug: service.slug.clone(),
    });

    Ok(())
}
