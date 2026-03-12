use anchor_lang::prelude::*;

pub mod ed25519_verify;
pub mod error;
pub mod events;
pub mod instructions;
pub mod state;

pub use instructions::*;

declare_id!("3EqrapHPPQqQKeB3aykZz9AbppMBzbY9PG1fT3PA7QyR");

#[program]
pub mod said_registry {
    use super::*;

    pub fn register(
        ctx: Context<Register>,
        master_pubkey: [u8; 32],
        did_key: String,
    ) -> Result<()> {
        instructions::register::handler(ctx, master_pubkey, did_key)
    }

    pub fn deactivate(ctx: Context<Deactivate>) -> Result<()> {
        instructions::deactivate::handler(ctx)
    }

    pub fn reactivate(ctx: Context<Reactivate>) -> Result<()> {
        instructions::reactivate::handler(ctx)
    }

    pub fn update_authority(ctx: Context<UpdateAuthority>) -> Result<()> {
        instructions::update_authority::handler(ctx)
    }

    pub fn update_profile_uri(ctx: Context<UpdateProfileUri>, profile_uri: String) -> Result<()> {
        instructions::update_profile_uri::handler(ctx, profile_uri)
    }
}
