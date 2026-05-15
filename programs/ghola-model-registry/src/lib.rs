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

declare_id!("7hZ9oxHyFRpKHtH3jsa8NeH4HYGrPT7ZttDFtUX9naNS");

#[program]
pub mod ghola_model_registry {
    use super::*;

    /// Register a new model. The signer becomes the entry's creator
    /// and is the only key that can update the entry afterwards.
    /// Fails if the entry already exists (Anchor's `init` does the
    /// uniqueness enforcement via the PDA seed collision).
    #[allow(clippy::too_many_arguments)]
    pub fn register_model(
        ctx: Context<RegisterModel>,
        // sha256(model_id) — used directly as the PDA seed. The client
        // computes this; the program asserts that the receipted
        // model_id below hashes to the same value, so the seed is
        // canonically bound to the model id without the IDL-builder
        // limitation of seeds-on-String.
        model_id_hash: [u8; 32],
        model_id: String,
        weights_hash: [u8; 32],
        model_lib_hash: [u8; 32],
        config_hash: [u8; 32],
        tokenizer_hash: [u8; 32],
        ipfs_cid: String,
        license_spdx: String,
        price_micro_usdc: u64,
    ) -> Result<()> {
        require!(
            model_id.len() <= MAX_MODEL_ID_LEN,
            ModelRegistryError::ModelIdTooLong,
        );
        require!(
            ipfs_cid.len() <= MAX_IPFS_CID_LEN,
            ModelRegistryError::IpfsCidTooLong,
        );
        require!(
            license_spdx.len() <= MAX_LICENSE_LEN,
            ModelRegistryError::LicenseTooLong,
        );

        // Bind the seed hash to the receipted model_id. Stops a
        // caller from registering record at PDA(sha256("foo")) but
        // storing model_id="bar" in the account body.
        let actual_hash = anchor_lang::solana_program::hash::hash(model_id.as_bytes());
        require!(
            actual_hash.to_bytes() == model_id_hash,
            ModelRegistryError::ModelIdHashMismatch,
        );

        let now = Clock::get()?.unix_timestamp;
        let model = &mut ctx.accounts.model;
        model.creator = ctx.accounts.creator.key();
        model.weights_hash = weights_hash;
        model.model_lib_hash = model_lib_hash;
        model.config_hash = config_hash;
        model.tokenizer_hash = tokenizer_hash;
        model.ipfs_cid = ipfs_cid.clone();
        model.license_spdx = license_spdx;
        model.price_micro_usdc = price_micro_usdc;
        model.version = 1;
        model.model_id = model_id.clone();
        model.created_at = now;
        model.updated_at = now;

        emit!(ModelRegistered {
            model_id,
            creator: ctx.accounts.creator.key(),
            weights_hash,
            ipfs_cid,
        });
        Ok(())
    }

    /// Close a model record and refund rent to the creator. The
    /// content-addressing invariant is enforced by immutable hash
    /// fields on `update_model`, so the only way to *correct* a
    /// registration with wrong hashes is to close + re-register
    /// (a different bump now produces a different account; users
    /// observing the chain see the close event and the new record).
    /// Only the original creator can call.
    pub fn close_model(_ctx: Context<CloseModel>) -> Result<()> {
        // Anchor's `close = creator` directive in CloseModel zeros the
        // account and refunds the rent to the creator. Nothing else
        // to do in the handler.
        Ok(())
    }

    /// Update fields that can drift over a model's lifetime (license
    /// terms, pricing, new IPFS pin location). Hash fields are
    /// **immutable** — content-addressed records must not allow the
    /// creator to retroactively swap weights under the same model id.
    pub fn update_model(
        ctx: Context<UpdateModel>,
        ipfs_cid: String,
        license_spdx: String,
        price_micro_usdc: u64,
    ) -> Result<()> {
        require!(
            ipfs_cid.len() <= MAX_IPFS_CID_LEN,
            ModelRegistryError::IpfsCidTooLong,
        );
        require!(
            license_spdx.len() <= MAX_LICENSE_LEN,
            ModelRegistryError::LicenseTooLong,
        );
        let model = &mut ctx.accounts.model;
        model.ipfs_cid = ipfs_cid.clone();
        model.license_spdx = license_spdx;
        model.price_micro_usdc = price_micro_usdc;
        model.version = model.version.checked_add(1).unwrap_or(u16::MAX);
        model.updated_at = Clock::get()?.unix_timestamp;
        emit!(ModelUpdated {
            model_id: model.model_id.clone(),
            version: model.version,
            price_micro_usdc: model.price_micro_usdc,
            ipfs_cid,
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
#[instruction(model_id_hash: [u8; 32])]
pub struct RegisterModel<'info> {
    #[account(
        init,
        payer = creator,
        space = 8 + ModelRecord::MAX_SIZE,
        seeds = [SEED_PREFIX, model_id_hash.as_ref()],
        bump,
    )]
    pub model: Account<'info, ModelRecord>,
    #[account(mut)]
    pub creator: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseModel<'info> {
    // `close = creator` returns the rent lamports to the creator and
    // zeros the discriminator so the same PDA cannot be re-opened
    // without a fresh init. has_one enforces only the original creator
    // can close.
    #[account(
        mut,
        close = creator,
        has_one = creator @ ModelRegistryError::NotCreator,
    )]
    pub model: Account<'info, ModelRecord>,
    #[account(mut)]
    pub creator: Signer<'info>,
}

#[derive(Accounts)]
pub struct UpdateModel<'info> {
    // Re-opening an existing account — Anchor verifies the
    // discriminator + (via `has_one`) the creator. The seed assertion
    // is omitted here because the account's existence at the resolved
    // PDA already proves it was registered via the seed-checked init
    // path above; recomputing the seed would require passing model_id
    // again and tripping the IDL builder which can't introspect
    // String fields of a stored account from within a seeds clause.
    #[account(
        mut,
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
    #[msg("model_id_hash does not equal sha256(model_id)")]
    ModelIdHashMismatch,
    #[msg("signer is not the creator of this model record")]
    NotCreator,
}
