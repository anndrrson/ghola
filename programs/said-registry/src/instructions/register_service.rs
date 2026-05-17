use anchor_lang::prelude::*;

use crate::error::RegistryError;
use crate::events::ServiceRegistered;
use crate::state::{IdentityRecord, ServiceRecord};

#[derive(Accounts)]
#[instruction(slug: String, base_url: String, registry_url: String)]
pub struct RegisterService<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The identity record that owns this service.
    #[account(
        constraint = identity.authority == payer.key(),
        constraint = identity.active @ RegistryError::IdentityNotActive,
    )]
    pub identity: Account<'info, IdentityRecord>,

    #[account(
        init,
        payer = payer,
        space = 8 + ServiceRecord::INIT_SPACE,
        seeds = [b"service", identity.key().as_ref(), slug.as_bytes()],
        bump,
    )]
    pub service: Account<'info, ServiceRecord>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<RegisterService>,
    slug: String,
    base_url: String,
    registry_url: String,
    price_micro_usdc: u64,
) -> Result<()> {
    require!(slug.len() <= 64, RegistryError::SlugTooLong);
    require!(base_url.len() <= 128, RegistryError::BaseUrlTooLong);
    require!(registry_url.len() <= 128, RegistryError::RegistryUrlTooLong);

    let clock = Clock::get()?;
    let service = &mut ctx.accounts.service;
    service.authority = ctx.accounts.payer.key();
    service.identity_record = ctx.accounts.identity.key();
    service.slug = slug.clone();
    service.base_url = base_url.clone();
    service.registry_url = registry_url;
    service.price_micro_usdc = price_micro_usdc;
    service.registered_at = clock.unix_timestamp;
    service.updated_at = clock.unix_timestamp;
    service.active = true;
    service.bump = ctx.bumps.service;

    emit!(ServiceRegistered {
        identity_record: ctx.accounts.identity.key(),
        slug,
        base_url,
        authority: ctx.accounts.payer.key(),
    });

    Ok(())
}
