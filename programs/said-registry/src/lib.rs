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

    pub fn register_service(
        ctx: Context<RegisterService>,
        slug: String,
        base_url: String,
        registry_url: String,
        price_micro_usdc: u64,
    ) -> Result<()> {
        instructions::register_service::handler(ctx, slug, base_url, registry_url, price_micro_usdc)
    }

    pub fn deactivate_service(ctx: Context<DeactivateService>) -> Result<()> {
        instructions::deactivate_service::handler(ctx)
    }

    pub fn attest_reputation(
        ctx: Context<AttestReputation>,
        overall_score: u16,
        confidence: u16,
        total_transactions: u32,
    ) -> Result<()> {
        instructions::attest_reputation::handler(ctx, overall_score, confidence, total_transactions)
    }

    pub fn record_delegation(
        ctx: Context<RecordDelegation>,
        token_hash: [u8; 32],
        capabilities_hash: [u8; 32],
        expires_at: i64,
    ) -> Result<()> {
        instructions::record_delegation::handler(ctx, token_hash, capabilities_hash, expires_at)
    }

    pub fn revoke_delegation(ctx: Context<RevokeDelegation>) -> Result<()> {
        instructions::revoke_delegation::handler(ctx)
    }
}
