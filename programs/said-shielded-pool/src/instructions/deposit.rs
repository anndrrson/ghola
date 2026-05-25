use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::error::ShieldedPoolError;
use crate::events::CommitmentQueued;
use crate::state::{CommitmentRecord, MerkleTree, PoolConfig};

#[derive(Accounts)]
#[instruction(amount: u64, commitment: [u8; 32])]
pub struct Deposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(
        seeds = [b"pool_config"],
        bump = pool_config.bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [b"merkle_tree", pool_config.key().as_ref(), mint.key().as_ref()],
        bump = merkle_tree.load()?.bump,
        constraint = merkle_tree.load()?.mint == mint.key() @ ShieldedPoolError::AssetMismatch,
    )]
    pub merkle_tree: AccountLoader<'info, MerkleTree>,

    #[account(
        mut,
        token::mint = mint,
        token::token_program = token_program,
    )]
    pub depositor_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = mint,
        token::authority = pool_config,
        token::token_program = token_program,
    )]
    pub escrow: InterfaceAccount<'info, TokenAccount>,

    /// One commitment record per deposit, queued for the forester.
    ///
    /// **V2**: PDA seed sources from `tree.queue_tail` (the deposit
    /// write-pointer), NOT `tree.next_index` (the forester write-pointer).
    /// This decouples in-flight deposit count from forester cadence so
    /// multiple deposits can sit in the queue between batched updates
    /// without colliding on the CommitmentRecord PDA address.
    #[account(
        init,
        payer = depositor,
        space = 8 + CommitmentRecord::INIT_SPACE,
        seeds = [
            b"commitment",
            merkle_tree.key().as_ref(),
            &merkle_tree.load()?.queue_tail.to_le_bytes(),
        ],
        bump,
    )]
    pub commitment_record: Account<'info, CommitmentRecord>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn deposit_handler(
    ctx: Context<Deposit>,
    amount: u64,
    commitment: [u8; 32],
) -> Result<()> {
    require!(!ctx.accounts.pool_config.paused, ShieldedPoolError::Paused);
    require!(amount > 0, ShieldedPoolError::InsufficientValue);

    // CPI: transfer SPL/Token-2022 from depositor → escrow. Uses
    // `transfer_checked` so it works for both Token and Token-2022 mints
    // (including extension fee-on-transfer mints, where the on-chain
    // commitment must reflect post-fee amount — depositor's responsibility
    // off-chain).
    let cpi_accounts = TransferChecked {
        from: ctx.accounts.depositor_token_account.to_account_info(),
        to: ctx.accounts.escrow.to_account_info(),
        authority: ctx.accounts.depositor.to_account_info(),
        mint: ctx.accounts.mint.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
    transfer_checked(cpi_ctx, amount, ctx.accounts.mint.decimals)?;

    // Append commitment to the per-tree queue. The forester will fold
    // batches of these into the tree off-chain and submit a root-update
    // proof via `update_root_via_proof`.
    let tree_key = ctx.accounts.merkle_tree.key();
    let clock = Clock::get()?;

    // **V2 state change** (Stream 4): deposit advances `tree.queue_tail`,
    // NOT `tree.next_index`. `next_index` is reserved for the forester
    // and advances on `update_root_via_proof`. This allows multiple
    // deposits to be queued simultaneously between forester batches
    // without colliding on the CommitmentRecord PDA seed (which is
    // derived from `queue_tail` at deposit time). Invariant maintained
    // elsewhere: `next_index <= queue_tail`.
    let queue_index = {
        let mut tree = ctx.accounts.merkle_tree.load_mut()?;
        let qi = tree.queue_tail;
        tree.queue_tail = tree
            .queue_tail
            .checked_add(1)
            .ok_or(ShieldedPoolError::Overflow)?;
        qi
    };

    let record = &mut ctx.accounts.commitment_record;
    record.tree = tree_key;
    record.queue_index = queue_index;
    record.commitment = commitment;
    record.queued_slot = clock.slot;
    record.inserted = false;
    record.bump = ctx.bumps.commitment_record;

    emit!(CommitmentQueued {
        tree: tree_key,
        queue_index,
        commitment,
        amount,
    });

    Ok(())
}
