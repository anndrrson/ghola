use anchor_lang::prelude::*;

use crate::error::RegistryError;
use crate::events::ReputationAttested;
use crate::state::{IdentityRecord, ReputationAttestation};

#[derive(Accounts)]
pub struct AttestReputation<'info> {
    /// The platform authority that signs reputation attestations.
    #[account(mut)]
    pub authority: Signer<'info>,

    /// The identity record being attested.
    pub entity_identity: Account<'info, IdentityRecord>,

    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + ReputationAttestation::INIT_SPACE,
        seeds = [b"reputation", entity_identity.key().as_ref()],
        bump,
    )]
    pub attestation: Account<'info, ReputationAttestation>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<AttestReputation>,
    overall_score: u16,
    confidence: u16,
    total_transactions: u32,
) -> Result<()> {
    require!(overall_score <= 10000, RegistryError::ScoreOutOfRange);
    require!(confidence <= 10000, RegistryError::ScoreOutOfRange);

    let clock = Clock::get()?;
    let attestation = &mut ctx.accounts.attestation;
    attestation.authority = ctx.accounts.authority.key();
    attestation.entity = ctx.accounts.entity_identity.key();
    attestation.overall_score = overall_score;
    attestation.confidence = confidence;
    attestation.total_transactions = total_transactions;
    attestation.attested_at = clock.unix_timestamp;
    attestation.bump = ctx.bumps.attestation;

    emit!(ReputationAttested {
        entity: ctx.accounts.entity_identity.key(),
        overall_score,
        confidence,
        total_transactions,
    });

    Ok(())
}
