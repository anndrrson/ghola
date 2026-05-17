use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::ID as SYSVAR_IX_ID;

use crate::ed25519_verify::verify_ed25519_signature;
use crate::error::RegistryError;
use crate::events::IdentityRegistered;
use crate::state::IdentityRecord;

#[derive(Accounts)]
#[instruction(master_pubkey: [u8; 32], did_key: String)]
pub struct Register<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + IdentityRecord::INIT_SPACE,
        seeds = [b"identity", master_pubkey.as_ref()],
        bump,
    )]
    pub identity: Account<'info, IdentityRecord>,

    pub system_program: Program<'info, System>,

    /// CHECK: Must be the instructions sysvar
    #[account(address = SYSVAR_IX_ID)]
    pub instructions_sysvar: AccountInfo<'info>,
}

pub fn handler(
    ctx: Context<Register>,
    master_pubkey: [u8; 32],
    did_key: String,
) -> Result<()> {
    require!(did_key.len() <= 64, RegistryError::DidKeyTooLong);

    // Build the expected message: "said:register:<base58 pubkey>:<did_key>"
    let b58_pubkey = bs58::encode(&master_pubkey).into_string();
    let message = format!("said:register:{}:{}", b58_pubkey, did_key);

    // Verify the Ed25519 signature instruction exists and is valid
    verify_ed25519_signature(
        &ctx.accounts.instructions_sysvar,
        &master_pubkey,
        message.as_bytes(),
    )?;

    let clock = Clock::get()?;
    let identity = &mut ctx.accounts.identity;
    identity.authority = ctx.accounts.payer.key();
    identity.master_pubkey = master_pubkey;
    identity.did_key = did_key.clone();
    identity.profile_uri = String::new();
    identity.registered_at = clock.unix_timestamp;
    identity.updated_at = clock.unix_timestamp;
    identity.active = true;
    identity.bump = ctx.bumps.identity;

    emit!(IdentityRegistered {
        master_pubkey,
        did_key,
        authority: ctx.accounts.payer.key(),
    });

    Ok(())
}
