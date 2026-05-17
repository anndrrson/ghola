use anchor_lang::prelude::*;

declare_id!("EwPWEHv9KVGt9KAGGaqVm3B9c6dLGSGzKZwtc5vFVJja");

#[program]
pub mod said_receipts {
    use super::*;

    /// Publish a Merkle root that anchors a batch of receipts produced
    /// between `period_start_unix` and `period_end_unix`. The off-chain
    /// receipts service computes the root and calls this hourly.
    ///
    /// The PDA at seeds `[b"root", period_start_unix.to_le_bytes()]`
    /// makes the batch addressable by start timestamp, so the web
    /// client can do "get the batch covering my receipt's issued_at"
    /// without scanning logs.
    pub fn publish_root(
        ctx: Context<PublishRoot>,
        root: [u8; 32],
        count: u32,
        period_start_unix: i64,
        period_end_unix: i64,
    ) -> Result<()> {
        require!(period_end_unix > period_start_unix, ReceiptsError::InvalidPeriod);
        require!(count > 0, ReceiptsError::EmptyBatch);

        let batch = &mut ctx.accounts.batch;
        batch.root = root;
        batch.count = count;
        batch.period_start_unix = period_start_unix;
        batch.period_end_unix = period_end_unix;
        batch.publisher = ctx.accounts.publisher.key();
        batch.published_at_unix = Clock::get()?.unix_timestamp;

        emit!(RootPublished {
            root,
            count,
            period_start_unix,
            period_end_unix,
            publisher: ctx.accounts.publisher.key(),
        });
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(root: [u8; 32], count: u32, period_start_unix: i64)]
pub struct PublishRoot<'info> {
    #[account(
        init,
        payer = publisher,
        space = 8 + ReceiptBatch::LEN,
        seeds = [b"root".as_ref(), period_start_unix.to_le_bytes().as_ref()],
        bump,
    )]
    pub batch: Account<'info, ReceiptBatch>,
    #[account(mut)]
    pub publisher: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct ReceiptBatch {
    pub root: [u8; 32],
    pub count: u32,
    pub period_start_unix: i64,
    pub period_end_unix: i64,
    pub publisher: Pubkey,
    pub published_at_unix: i64,
}

impl ReceiptBatch {
    pub const LEN: usize = 32 + 4 + 8 + 8 + 32 + 8;
}

#[event]
pub struct RootPublished {
    pub root: [u8; 32],
    pub count: u32,
    pub period_start_unix: i64,
    pub period_end_unix: i64,
    pub publisher: Pubkey,
}

#[error_code]
pub enum ReceiptsError {
    #[msg("period_end must be > period_start")]
    InvalidPeriod,
    #[msg("batch count must be > 0")]
    EmptyBatch,
}
