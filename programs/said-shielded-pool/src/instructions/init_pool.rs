use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::error::ShieldedPoolError;
use crate::events::{PoolInitialized, TreeInitialized};
use crate::groth16::hash_verifier_key;
use crate::state::{
    MerkleTree, PoolConfig, VerifierKey, DEFAULT_TIMELOCK_SECS, FORESTER_SET_LEN, MAX_FEE_BPS,
    TREE_DEPTH, VERIFIER_KEY_MAX_LEN,
};

#[derive(Accounts)]
pub struct InitPool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + PoolConfig::INIT_SPACE,
        seeds = [b"pool_config"],
        bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    #[account(
        init,
        payer = admin,
        space = VerifierKey::LEN,
        seeds = [b"verifier_key", pool_config.key().as_ref()],
        bump,
    )]
    pub verifier_key: AccountLoader<'info, VerifierKey>,

    pub system_program: Program<'info, System>,
}

pub fn init_pool_handler(
    ctx: Context<InitPool>,
    fee_bps: u16,
    verifier_key_bytes: Vec<u8>,
) -> Result<()> {
    require!(fee_bps <= MAX_FEE_BPS, ShieldedPoolError::FeeOutOfRange);
    require!(
        verifier_key_bytes.len() <= VERIFIER_KEY_MAX_LEN,
        ShieldedPoolError::VerifierKeyMismatch
    );

    let vk_hash = hash_verifier_key(&verifier_key_bytes);

    {
        let mut vk = ctx.accounts.verifier_key.load_init()?;
        vk.bump = ctx.bumps.verifier_key;
        vk._pad = [0u8; 1];
        vk.len = verifier_key_bytes.len() as u16;
        vk.bytes = [0u8; VERIFIER_KEY_MAX_LEN];
        vk.bytes[..verifier_key_bytes.len()].copy_from_slice(&verifier_key_bytes);
    }

    let cfg = &mut ctx.accounts.pool_config;
    let admin_key = ctx.accounts.admin.key();
    cfg.admin = admin_key;
    cfg.verifier_key_hash = vk_hash;
    cfg.verifier_key = ctx.accounts.verifier_key.key();
    cfg.paused = false;
    cfg.fee_bps = fee_bps;
    cfg.bump = ctx.bumps.pool_config;

    // V2 governance fields — fresh init sets sensible defaults.
    // pause_authority defaults to admin until set_pause_authority is called.
    cfg.pause_authority = admin_key;
    cfg.pending_admin = Pubkey::default();
    cfg.admin_change_eta = 0;
    cfg.pending_vk_hash = [0u8; 32];
    cfg.vk_change_eta = 0;
    cfg.forester_set = [Pubkey::default(); FORESTER_SET_LEN];
    cfg.timelock_secs = DEFAULT_TIMELOCK_SECS;
    cfg.migrated = true;

    emit!(PoolInitialized {
        admin: cfg.admin,
        verifier_key_hash: vk_hash,
        fee_bps,
    });

    Ok(())
}

/// Initialize a per-mint Merkle tree under an existing pool. The escrow
/// token account itself is initialized by the caller using the standard
/// `anchor-spl` token-interface CPI; we only own its address via PDA.
#[derive(Accounts)]
pub struct InitTree<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"pool_config"],
        bump = pool_config.bump,
        has_one = admin @ ShieldedPoolError::Unauthorized,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = admin,
        space = 8 + std::mem::size_of::<MerkleTree>(),
        seeds = [b"merkle_tree", pool_config.key().as_ref(), mint.key().as_ref()],
        bump,
    )]
    pub merkle_tree: AccountLoader<'info, MerkleTree>,

    /// Program-owned escrow token account. Caller pre-creates this with
    /// owner = `pool_config` and address derived from the documented
    /// escrow seeds.
    ///
    /// VERIFIED (security review, escrow-authority item): the
    /// `token::authority = pool_config` constraint is sufficient — a caller
    /// CANNOT pre-create an escrow with a different authority and have it
    /// pass. This account is NOT `init`d here; Anchor deserializes the
    /// existing SPL token account and asserts its on-chain `owner`
    /// (authority) field equals `pool_config.key()`, failing with
    /// `ConstraintTokenOwner` otherwise. Combined with `token::mint = mint`
    /// (and the per-instruction `escrow` PDA address used in deposit/
    /// withdraw via the documented `escrow_seeds`), the program's signer-PDA
    /// CPI authority always matches the escrow it moves funds from. No extra
    /// `require!` is needed.
    #[account(
        token::mint = mint,
        token::authority = pool_config,
        token::token_program = token_program,
    )]
    pub escrow: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn init_tree_handler(ctx: Context<InitTree>, initial_root: [u8; 32]) -> Result<()> {
    let pool_key = ctx.accounts.pool_config.key();
    let mint_key = ctx.accounts.mint.key();
    let bump = ctx.bumps.merkle_tree;

    let (pool, mint, depth) = {
        let mut tree = ctx.accounts.merkle_tree.load_init()?;
        tree.pool = pool_key;
        tree.mint = mint_key;
        tree.depth = TREE_DEPTH;
        tree.next_index = 0;
        tree.queue_tail = 0;
        tree.root = initial_root;
        // `load_init` zeroes the underlying account data, so root_history
        // is already all-zeroes — no need to assign the (large) array.
        tree.root_history_idx = 0;
        tree.bump = bump;
        tree._pad = [0u8; 2];
        (tree.pool, tree.mint, tree.depth)
    };

    emit!(TreeInitialized {
        pool,
        mint,
        depth,
        initial_root,
    });

    Ok(())
}
