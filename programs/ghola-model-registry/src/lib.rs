//! Ghola model registry — content-addressed open-weight model metadata
//! anchored on Solana.
//!
//! The point: a user running a model in Local mode (Tier 1A WebGPU) can
//! verify that the artifacts they downloaded match what the model's
//! creator published, without trusting ghola the company or any CDN.
//! The Tier 1A.5 a16z-thesis claim — "anonymous users read the
//! protocol, signed-in users write to it" — lives here.
//!
//! Each entry is keyed by `[b"ghola-model", sha256(model_id)]` so the
//! PDA is deterministic from the model id string alone. The web
//! client mirrors that derivation in
//! `apps/web/src/lib/model-registry.ts::deriveModelPda`.
//!
//! Fields the program stores:
//!   - creator: Solana pubkey that published the entry; only this key
//!     can update fields after registration.
//!   - weights_hash: SHA-256 of the weights manifest (the deterministic
//!     hash of the concatenated MLC param shard hashes, in order).
//!   - model_lib_hash: SHA-256 of the WASM model library.
//!   - config_hash: SHA-256 of the model config JSON.
//!   - tokenizer_hash: SHA-256 of the tokenizer.json.
//!   - ipfs_cid: IPFS CIDv1 for the weights bundle (UTF-8, up to 96 b).
//!   - license_spdx: SPDX identifier (UTF-8, up to 32 b).
//!   - price_micro_usdc: per-call price for x402 settlement.
//!   - version: increments on every update; lets clients invalidate
//!     cached metadata without re-fetching the whole record.
//!
//! Costs: ~0.0035 SOL rent for a 256-byte account at current rates.
//! Creators eat the registration fee; updates are zero-rent past the
//! initial allocation.

use anchor_lang::prelude::*;

declare_id!("MdLRegMa1iYxBg5gKhCJVTDfXkqHpQF6PoG3kRYW6S1");

#[program]
pub mod ghola_model_registry {
    use super::*;

    /// Register a new model. The signer becomes the entry's creator
    /// and is the only key that can update the entry afterwards.
    /// Fails if the entry already exists (Anchor's `init` does the
    /// uniqueness enforcement via the PDA seed collision).
    pub fn register_model(
        ctx: Context<RegisterModel>,
        args: RegisterModelArgs,
    ) -> Result<()> {
        require!(
            args.model_id.len() <= MAX_MODEL_ID_LEN,
            ModelRegistryError::ModelIdTooLong,
        );
        require!(
            args.ipfs_cid.len() <= MAX_IPFS_CID_LEN,
            ModelRegistryError::IpfsCidTooLong,
        );
        require!(
            args.license_spdx.len() <= MAX_LICENSE_LEN,
            ModelRegistryError::LicenseTooLong,
        );

        // PDA seed integrity check — the seed bytes the client used to
        // resolve this PDA must equal sha256(model_id). If a caller
        // tries to register a record under the wrong PDA the assertion
        // fails before any state writes.
        let expected_seed_hash = anchor_lang::solana_program::hash::hash(args.model_id.as_bytes());
        require!(
            ctx.accounts.model.key()
                == Pubkey::find_program_address(
                    &[SEED_PREFIX, expected_seed_hash.as_ref()],
                    ctx.program_id,
                )
                .0,
            ModelRegistryError::PdaMismatch,
        );

        let now = Clock::get()?.unix_timestamp;
        let model = &mut ctx.accounts.model;
        model.creator = ctx.accounts.creator.key();
        model.weights_hash = args.weights_hash;
        model.model_lib_hash = args.model_lib_hash;
        model.config_hash = args.config_hash;
        model.tokenizer_hash = args.tokenizer_hash;
        model.ipfs_cid = args.ipfs_cid.clone();
        model.license_spdx = args.license_spdx.clone();
        model.price_micro_usdc = args.price_micro_usdc;
        model.version = 1;
        model.model_id = args.model_id.clone();
        model.created_at = now;
        model.updated_at = now;

        emit!(ModelRegistered {
            model_id: args.model_id,
            creator: ctx.accounts.creator.key(),
            weights_hash: args.weights_hash,
            ipfs_cid: args.ipfs_cid,
        });
        Ok(())
    }

    /// Update fields that can drift over a model's lifetime (license
    /// terms, pricing, new IPFS pin location). Hash fields are
    /// **immutable** — content-addressed records must not allow the
    /// creator to retroactively swap weights under the same model id.
    pub fn update_model(ctx: Context<UpdateModel>, args: UpdateModelArgs) -> Result<()> {
        require!(
            args.ipfs_cid.len() <= MAX_IPFS_CID_LEN,
            ModelRegistryError::IpfsCidTooLong,
        );
        require!(
            args.license_spdx.len() <= MAX_LICENSE_LEN,
            ModelRegistryError::LicenseTooLong,
        );
        let model = &mut ctx.accounts.model;
        model.ipfs_cid = args.ipfs_cid.clone();
        model.license_spdx = args.license_spdx.clone();
        model.price_micro_usdc = args.price_micro_usdc;
        model.version = model.version.checked_add(1).unwrap_or(u16::MAX);
        model.updated_at = Clock::get()?.unix_timestamp;
        emit!(ModelUpdated {
            model_id: model.model_id.clone(),
            version: model.version,
            price_micro_usdc: model.price_micro_usdc,
            ipfs_cid: args.ipfs_cid,
        });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// PDA / size constants
// ---------------------------------------------------------------------------

pub const SEED_PREFIX: &[u8] = b"ghola-model";

pub const MAX_MODEL_ID_LEN: usize = 64;
pub const MAX_IPFS_CID_LEN: usize = 96;
pub const MAX_LICENSE_LEN: usize = 32;

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(args: RegisterModelArgs)]
pub struct RegisterModel<'info> {
    #[account(
        init,
        payer = creator,
        space = 8 + ModelRecord::MAX_SIZE,
        seeds = [
            SEED_PREFIX,
            // Use a SHA-256 of the model_id as the seed because raw
            // model ids can exceed Solana's 32-byte per-seed limit
            // (e.g. "Llama-3.2-1B-Instruct-q4f16_1-MLC" is 33 bytes).
            anchor_lang::solana_program::hash::hash(args.model_id.as_bytes()).as_ref(),
        ],
        bump,
    )]
    pub model: Account<'info, ModelRecord>,
    #[account(mut)]
    pub creator: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateModel<'info> {
    #[account(
        mut,
        seeds = [
            SEED_PREFIX,
            anchor_lang::solana_program::hash::hash(model.model_id.as_bytes()).as_ref(),
        ],
        bump,
        has_one = creator @ ModelRegistryError::NotCreator,
    )]
    pub model: Account<'info, ModelRecord>,
    pub creator: Signer<'info>,
}

// ---------------------------------------------------------------------------
// Account state
// ---------------------------------------------------------------------------

#[account]
pub struct ModelRecord {
    pub creator: Pubkey,
    pub weights_hash: [u8; 32],
    pub model_lib_hash: [u8; 32],
    pub config_hash: [u8; 32],
    pub tokenizer_hash: [u8; 32],
    pub price_micro_usdc: u64,
    pub created_at: i64,
    pub updated_at: i64,
    pub version: u16,
    // Variable-length strings are bounded by the constants above.
    pub model_id: String,
    pub ipfs_cid: String,
    pub license_spdx: String,
}

impl ModelRecord {
    // Anchor account size = fixed fields + 4-byte length prefix for each
    // String + max chars. The 8-byte discriminator is added by Anchor at
    // the call site (space = 8 + ModelRecord::MAX_SIZE).
    pub const MAX_SIZE: usize = 32 // creator
        + 32 // weights_hash
        + 32 // model_lib_hash
        + 32 // config_hash
        + 32 // tokenizer_hash
        + 8  // price_micro_usdc
        + 8  // created_at
        + 8  // updated_at
        + 2  // version
        + 4 + MAX_MODEL_ID_LEN
        + 4 + MAX_IPFS_CID_LEN
        + 4 + MAX_LICENSE_LEN;
}

// ---------------------------------------------------------------------------
// Instruction args
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RegisterModelArgs {
    pub model_id: String,
    pub weights_hash: [u8; 32],
    pub model_lib_hash: [u8; 32],
    pub config_hash: [u8; 32],
    pub tokenizer_hash: [u8; 32],
    pub ipfs_cid: String,
    pub license_spdx: String,
    pub price_micro_usdc: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct UpdateModelArgs {
    pub ipfs_cid: String,
    pub license_spdx: String,
    pub price_micro_usdc: u64,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct ModelRegistered {
    pub model_id: String,
    pub creator: Pubkey,
    pub weights_hash: [u8; 32],
    pub ipfs_cid: String,
}

#[event]
pub struct ModelUpdated {
    pub model_id: String,
    pub version: u16,
    pub price_micro_usdc: u64,
    pub ipfs_cid: String,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum ModelRegistryError {
    #[msg("model_id exceeds maximum length")]
    ModelIdTooLong,
    #[msg("ipfs_cid exceeds maximum length")]
    IpfsCidTooLong,
    #[msg("license_spdx exceeds maximum length")]
    LicenseTooLong,
    #[msg("derived PDA does not match the provided model account")]
    PdaMismatch,
    #[msg("signer is not the creator of this model record")]
    NotCreator,
}
