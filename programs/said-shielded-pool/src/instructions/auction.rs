use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

use crate::error::ShieldedPoolError;
use crate::events::{
    AuctionClearingSettled, AuctionEpochCleared, AuctionEpochOpened, AuctionMarketInitialized,
    AuctionOrderCancelled, AuctionOrderCommitted,
};
use crate::groth16::{verify_auction_clearing, VerifyInputs};
use crate::state::{
    AuctionClearing, AuctionEpoch, AuctionMarket, AuctionOrderCommitment,
    AuctionOrderNullifier, PoolConfig, AUCTION_BATCH_SIZE, AUCTION_STATUS_CANCELLED,
    AUCTION_STATUS_CLEARED, AUCTION_STATUS_EXPIRED, AUCTION_STATUS_OPEN,
    AUCTION_STATUS_SETTLED, NUM_PUBLIC_INPUTS,
};

#[derive(Accounts)]
#[instruction(args: InitAuctionMarketArgs)]
pub struct InitAuctionMarket<'info> {
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
        space = 8 + AuctionMarket::INIT_SPACE,
        seeds = [
            b"auction_market",
            pool_config.key().as_ref(),
            mint.key().as_ref(),
            args.market_commitment.as_ref(),
        ],
        bump,
    )]
    pub auction_market: Account<'info, AuctionMarket>,

    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InitAuctionMarketArgs {
    pub market_commitment: [u8; 32],
    pub asset_id: [u8; 32],
    pub auction_verifier_key_hash: [u8; 32],
    pub batch_size: u16,
}

pub fn init_auction_market_handler(
    ctx: Context<InitAuctionMarket>,
    args: InitAuctionMarketArgs,
) -> Result<()> {
    require!(!ctx.accounts.pool_config.paused, ShieldedPoolError::Paused);
    let batch_size = args.batch_size.clamp(1, AUCTION_BATCH_SIZE);
    let market = &mut ctx.accounts.auction_market;
    market.pool_config = ctx.accounts.pool_config.key();
    market.mint = ctx.accounts.mint.key();
    market.authority = ctx.accounts.admin.key();
    market.market_commitment = args.market_commitment;
    market.asset_id = args.asset_id;
    market.auction_verifier_key_hash = args.auction_verifier_key_hash;
    market.batch_size = batch_size;
    market.status = AUCTION_STATUS_OPEN;
    market.bump = ctx.bumps.auction_market;

    emit!(AuctionMarketInitialized {
        auction_market: market.key(),
        market_commitment: market.market_commitment,
        mint: market.mint,
        batch_size,
    });

    Ok(())
}

#[derive(Accounts)]
#[instruction(args: OpenAuctionEpochArgs)]
pub struct OpenAuctionEpoch<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [b"pool_config"],
        bump = pool_config.bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    #[account(
        has_one = pool_config @ ShieldedPoolError::Unauthorized,
        has_one = authority @ ShieldedPoolError::Unauthorized,
    )]
    pub auction_market: Account<'info, AuctionMarket>,

    #[account(
        init,
        payer = authority,
        space = 8 + AuctionEpoch::INIT_SPACE,
        seeds = [
            b"auction_epoch",
            auction_market.key().as_ref(),
            &args.epoch_id.to_le_bytes(),
        ],
        bump,
    )]
    pub auction_epoch: Account<'info, AuctionEpoch>,

    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct OpenAuctionEpochArgs {
    pub epoch_id: u64,
    pub closes_slot: u64,
}

pub fn open_auction_epoch_handler(
    ctx: Context<OpenAuctionEpoch>,
    args: OpenAuctionEpochArgs,
) -> Result<()> {
    require!(!ctx.accounts.pool_config.paused, ShieldedPoolError::Paused);
    require!(
        ctx.accounts.auction_market.status == AUCTION_STATUS_OPEN,
        ShieldedPoolError::AuctionNotOpen
    );
    let clock = Clock::get()?;
    require!(args.closes_slot > clock.slot, ShieldedPoolError::AuctionAlreadyClosed);

    let epoch = &mut ctx.accounts.auction_epoch;
    epoch.auction_market = ctx.accounts.auction_market.key();
    epoch.epoch_id = args.epoch_id;
    epoch.order_root = [0u8; 32];
    epoch.opened_slot = clock.slot;
    epoch.closes_slot = args.closes_slot;
    epoch.order_count = 0;
    epoch.matched_count = 0;
    epoch.rolled_count = 0;
    epoch.status = AUCTION_STATUS_OPEN;
    epoch.clearing_commitment = [0u8; 32];
    epoch.clearing_price_commitment = [0u8; 32];
    epoch.proof_commitment = [0u8; 32];
    epoch.settlement_commitment = [0u8; 32];
    epoch.bump = ctx.bumps.auction_epoch;

    emit!(AuctionEpochOpened {
        auction_epoch: epoch.key(),
        auction_market: epoch.auction_market,
        epoch_id: epoch.epoch_id,
        closes_slot: epoch.closes_slot,
    });

    Ok(())
}

#[derive(Accounts)]
#[instruction(args: CommitAuctionOrderArgs)]
pub struct CommitAuctionOrder<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [b"pool_config"],
        bump = pool_config.bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    #[account(has_one = pool_config @ ShieldedPoolError::Unauthorized)]
    pub auction_market: Account<'info, AuctionMarket>,

    #[account(
        mut,
        has_one = auction_market @ ShieldedPoolError::Unauthorized,
    )]
    pub auction_epoch: Account<'info, AuctionEpoch>,

    #[account(
        init,
        payer = owner,
        space = 8 + AuctionOrderCommitment::INIT_SPACE,
        seeds = [
            b"auction_order",
            auction_epoch.key().as_ref(),
            args.order_commitment.as_ref(),
        ],
        bump,
    )]
    pub auction_order: Account<'info, AuctionOrderCommitment>,

    #[account(
        init,
        payer = owner,
        space = 8 + AuctionOrderNullifier::INIT_SPACE,
        seeds = [
            b"auction_order_nullifier",
            auction_market.key().as_ref(),
            args.order_nullifier.as_ref(),
        ],
        bump,
    )]
    pub order_nullifier: Account<'info, AuctionOrderNullifier>,

    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CommitAuctionOrderArgs {
    pub order_commitment: [u8; 32],
    pub order_nullifier: [u8; 32],
    pub price_bucket_commitment: [u8; 32],
    pub institution_policy_commitment: [u8; 32],
    pub side: u8,
    pub amount_bucket: u16,
}

pub fn commit_auction_order_handler(
    ctx: Context<CommitAuctionOrder>,
    args: CommitAuctionOrderArgs,
) -> Result<()> {
    require!(!ctx.accounts.pool_config.paused, ShieldedPoolError::Paused);
    let clock = Clock::get()?;
    let epoch = &mut ctx.accounts.auction_epoch;
    require!(epoch.status == AUCTION_STATUS_OPEN, ShieldedPoolError::AuctionNotOpen);
    require!(clock.slot <= epoch.closes_slot, ShieldedPoolError::AuctionAlreadyClosed);
    require!(
        epoch.order_count < ctx.accounts.auction_market.batch_size,
        ShieldedPoolError::AuctionBatchFull
    );
    require_canonical(&[
        args.order_commitment,
        args.order_nullifier,
        args.price_bucket_commitment,
        args.institution_policy_commitment,
    ])?;

    let order = &mut ctx.accounts.auction_order;
    order.auction_epoch = epoch.key();
    order.owner = ctx.accounts.owner.key();
    order.order_commitment = args.order_commitment;
    order.order_nullifier = args.order_nullifier;
    order.price_bucket_commitment = args.price_bucket_commitment;
    order.institution_policy_commitment = args.institution_policy_commitment;
    order.side = args.side;
    order.amount_bucket = args.amount_bucket;
    order.status = AUCTION_STATUS_OPEN;
    order.created_slot = clock.slot;
    order.bump = ctx.bumps.auction_order;

    let nullifier = &mut ctx.accounts.order_nullifier;
    nullifier.auction_market = ctx.accounts.auction_market.key();
    nullifier.order_nullifier = args.order_nullifier;
    nullifier.consumed_slot = clock.slot;
    nullifier.bump = ctx.bumps.order_nullifier;

    epoch.order_root = poseidon_pair(epoch.order_root, args.order_commitment)?;
    epoch.order_count = epoch
        .order_count
        .checked_add(1)
        .ok_or(ShieldedPoolError::Overflow)?;

    emit!(AuctionOrderCommitted {
        auction_epoch: epoch.key(),
        order_commitment: args.order_commitment,
        side: args.side,
        amount_bucket: args.amount_bucket,
    });

    Ok(())
}

#[derive(Accounts)]
#[instruction(args: CloseAuctionEpochArgs)]
pub struct CloseAuctionEpoch<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [b"pool_config"],
        bump = pool_config.bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    #[account(
        has_one = pool_config @ ShieldedPoolError::Unauthorized,
        has_one = authority @ ShieldedPoolError::Unauthorized,
    )]
    pub auction_market: Account<'info, AuctionMarket>,

    #[account(
        mut,
        has_one = auction_market @ ShieldedPoolError::Unauthorized,
    )]
    pub auction_epoch: Account<'info, AuctionEpoch>,

    #[account(
        init,
        payer = authority,
        space = 8 + AuctionClearing::INIT_SPACE,
        seeds = [b"auction_clearing", auction_epoch.key().as_ref()],
        bump,
    )]
    pub auction_clearing: Account<'info, AuctionClearing>,

    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CloseAuctionEpochArgs {
    pub proof_a: [u8; 64],
    pub proof_b: [u8; 128],
    pub proof_c: [u8; 64],
    pub auction_order_root: [u8; 32],
    pub clearing_commitment: [u8; 32],
    pub clearing_price_commitment: [u8; 32],
    pub matched_root: [u8; 32],
    pub rolled_root: [u8; 32],
    pub matched_count: u16,
    pub rolled_count: u16,
    pub settlement_commitment: [u8; 32],
    pub proof_commitment: [u8; 32],
}

pub fn close_auction_epoch_handler(
    ctx: Context<CloseAuctionEpoch>,
    args: CloseAuctionEpochArgs,
) -> Result<()> {
    require!(!ctx.accounts.pool_config.paused, ShieldedPoolError::Paused);
    let clock = Clock::get()?;
    let epoch = &mut ctx.accounts.auction_epoch;
    require!(epoch.status == AUCTION_STATUS_OPEN, ShieldedPoolError::AuctionNotOpen);
    require!(clock.slot >= epoch.closes_slot, ShieldedPoolError::AuctionCloseNotReached);
    let cleared_total = args
        .matched_count
        .checked_add(args.rolled_count)
        .ok_or(ShieldedPoolError::Overflow)?;
    require!(
        cleared_total == epoch.order_count,
        ShieldedPoolError::AuctionClearingCountsInvalid
    );
    require!(
        args.auction_order_root == epoch.order_root,
        ShieldedPoolError::AuctionProofPublicInputMismatch
    );
    require_canonical(&[
        args.auction_order_root,
        args.clearing_commitment,
        args.clearing_price_commitment,
        args.matched_root,
        args.rolled_root,
        args.settlement_commitment,
        args.proof_commitment,
    ])?;

    let public_inputs: [[u8; 32]; NUM_PUBLIC_INPUTS] = [
        args.auction_order_root,
        args.clearing_price_commitment,
        args.matched_root,
        args.rolled_root,
        u16_field(args.matched_count),
        u16_field(args.rolled_count),
        args.settlement_commitment,
        args.clearing_commitment,
    ];
    verify_auction_clearing(VerifyInputs {
        proof_a: &args.proof_a,
        proof_b: &args.proof_b,
        proof_c: &args.proof_c,
        public_inputs: &public_inputs,
        verifier_key: &[],
    })?;

    epoch.status = AUCTION_STATUS_CLEARED;
    epoch.matched_count = args.matched_count;
    epoch.rolled_count = args.rolled_count;
    epoch.clearing_commitment = args.clearing_commitment;
    epoch.clearing_price_commitment = args.clearing_price_commitment;
    epoch.proof_commitment = args.proof_commitment;
    epoch.settlement_commitment = args.settlement_commitment;

    let clearing = &mut ctx.accounts.auction_clearing;
    clearing.auction_epoch = epoch.key();
    clearing.clearing_commitment = args.clearing_commitment;
    clearing.clearing_price_commitment = args.clearing_price_commitment;
    clearing.matched_root = args.matched_root;
    clearing.rolled_root = args.rolled_root;
    clearing.proof_commitment = args.proof_commitment;
    clearing.settlement_commitment = args.settlement_commitment;
    clearing.matched_count = args.matched_count;
    clearing.rolled_count = args.rolled_count;
    clearing.status = AUCTION_STATUS_CLEARED;
    clearing.bump = ctx.bumps.auction_clearing;

    emit!(AuctionEpochCleared {
        auction_epoch: epoch.key(),
        clearing_commitment: args.clearing_commitment,
        matched_count: args.matched_count,
        rolled_count: args.rolled_count,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct SettleAuctionClearing<'info> {
    pub authority: Signer<'info>,

    #[account(
        seeds = [b"pool_config"],
        bump = pool_config.bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    #[account(
        has_one = pool_config @ ShieldedPoolError::Unauthorized,
        has_one = authority @ ShieldedPoolError::Unauthorized,
    )]
    pub auction_market: Account<'info, AuctionMarket>,

    #[account(
        mut,
        has_one = auction_market @ ShieldedPoolError::Unauthorized,
    )]
    pub auction_epoch: Account<'info, AuctionEpoch>,

    #[account(
        mut,
        has_one = auction_epoch @ ShieldedPoolError::Unauthorized,
    )]
    pub auction_clearing: Account<'info, AuctionClearing>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct SettleAuctionClearingArgs {
    pub settlement_commitment: [u8; 32],
}

pub fn settle_auction_clearing_handler(
    ctx: Context<SettleAuctionClearing>,
    args: SettleAuctionClearingArgs,
) -> Result<()> {
    require!(!ctx.accounts.pool_config.paused, ShieldedPoolError::Paused);
    require!(
        ctx.accounts.auction_epoch.status == AUCTION_STATUS_CLEARED &&
            ctx.accounts.auction_clearing.status == AUCTION_STATUS_CLEARED,
        ShieldedPoolError::AuctionClearingNotReady
    );
    require!(
        ctx.accounts.auction_clearing.settlement_commitment == args.settlement_commitment,
        ShieldedPoolError::AuctionProofPublicInputMismatch
    );

    ctx.accounts.auction_epoch.status = AUCTION_STATUS_SETTLED;
    ctx.accounts.auction_epoch.settlement_commitment = args.settlement_commitment;
    ctx.accounts.auction_clearing.status = AUCTION_STATUS_SETTLED;
    ctx.accounts.auction_clearing.settlement_commitment = args.settlement_commitment;

    emit!(AuctionClearingSettled {
        auction_epoch: ctx.accounts.auction_epoch.key(),
        clearing_commitment: ctx.accounts.auction_clearing.clearing_commitment,
        settlement_commitment: args.settlement_commitment,
    });

    Ok(())
}

fn require_canonical(values: &[[u8; 32]]) -> Result<()> {
    for value in values {
        require!(
            crate::crypto::is_canonical_field_element(value),
            ShieldedPoolError::NonCanonicalPublicInput
        );
    }
    Ok(())
}

fn u16_field(value: u16) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[30..].copy_from_slice(&value.to_be_bytes());
    out
}

fn poseidon_pair(left: [u8; 32], right: [u8; 32]) -> Result<[u8; 32]> {
    use anchor_lang::solana_program::poseidon::{hashv, Endianness, Parameters};
    let hash = hashv(Parameters::Bn254X5, Endianness::BigEndian, &[&left, &right])
        .map_err(|_| error!(ShieldedPoolError::InvalidProof))?;
    Ok(hash.to_bytes())
}

#[derive(Accounts)]
pub struct CancelExpiredAuctionOrder<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ ShieldedPoolError::AuctionOrderOwnerMismatch,
        has_one = auction_epoch @ ShieldedPoolError::Unauthorized,
    )]
    pub auction_order: Account<'info, AuctionOrderCommitment>,

    pub auction_epoch: Account<'info, AuctionEpoch>,
}

pub fn cancel_expired_auction_order_handler(
    ctx: Context<CancelExpiredAuctionOrder>,
) -> Result<()> {
    let clock = Clock::get()?;
    require!(
        clock.slot > ctx.accounts.auction_epoch.closes_slot,
        ShieldedPoolError::AuctionOrderNotExpired
    );
    require!(
        ctx.accounts.auction_order.status == AUCTION_STATUS_OPEN,
        ShieldedPoolError::AuctionAlreadyClosed
    );
    ctx.accounts.auction_order.status = AUCTION_STATUS_CANCELLED;
    if ctx.accounts.auction_epoch.status == AUCTION_STATUS_OPEN {
        ctx.accounts.auction_order.status = AUCTION_STATUS_EXPIRED;
    }

    emit!(AuctionOrderCancelled {
        auction_epoch: ctx.accounts.auction_epoch.key(),
        order_commitment: ctx.accounts.auction_order.order_commitment,
    });

    Ok(())
}
