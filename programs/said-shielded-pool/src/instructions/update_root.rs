//! `update_root_via_proof` — forester-only batched tree update.
//!
//! Off-chain, the forester (see `crates/said-shielded-pool-indexer`) folds
//! a fixed-size batch of pending `CommitmentRecord` entries into the
//! incremental Merkle tree and produces a Groth16 proof against the
//! batched-update circuit (`circuits/batchedUpdate.circom`). The proof says:
//!
//!   given a depth-26 tree with root `old_root` and next-free index
//!   `start_index`, inserting `commitment[0..BATCH_SIZE]` at consecutive
//!   positions yields a tree with root `new_root`.
//!
//! The on-chain handler verifies that proof and rotates `root` into
//! `root_history`, advancing the active root pointer.
//!
//! Public input layout (forester / batched-update circuit):
//!   [0] old_root
//!   [1] new_root
//!   [2] start_index            (u64 → 32-byte BE field element)
//!   [3] commitment[0]
//!   [4] commitment[1]
//!   [5] commitment[2]
//!   [6] commitment[3]
//!   [7] _pad                   (binding-only zero — circuit enforces == 0)
//!
//! Padded to NUM_PUBLIC_INPUTS = 8 so the verify wrapper shares one
//! `VerifyInputs` shape with the transfer circuit. The vk dispatched into
//! is `crate::forester_verifying_key::VERIFYING_KEY` (see `groth16.rs`).

use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

use crate::error::ShieldedPoolError;
use crate::events::RootUpdated;
use crate::groth16::{verify_forester, VerifyInputs};
use crate::state::{CommitmentRecord, MerkleTree, PoolConfig, VerifierKey, NUM_PUBLIC_INPUTS};

/// Fixed batch size of the forester circuit. Bumping this requires
/// recompiling the circuit + redoing the trusted-setup ceremony.
pub const FORESTER_BATCH_SIZE: usize = 4;

#[derive(Accounts)]
#[instruction(args: UpdateRootArgs)]
pub struct UpdateRoot<'info> {
    pub forester: Signer<'info>,

    #[account(
        seeds = [b"pool_config"],
        bump = pool_config.bump,
        has_one = verifier_key @ ShieldedPoolError::VerifierKeyMismatch,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    pub verifier_key: AccountLoader<'info, VerifierKey>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [b"merkle_tree", pool_config.key().as_ref(), mint.key().as_ref()],
        bump = merkle_tree.load()?.bump,
        constraint = merkle_tree.load()?.mint == mint.key() @ ShieldedPoolError::AssetMismatch,
    )]
    pub merkle_tree: AccountLoader<'info, MerkleTree>,

    // **C4**: the queued `CommitmentRecord` PDAs for the leaf positions
    // this batch folds in — `queue_index = start_index + i`. Passing them
    // as required accounts (PDA-seed-derived, so the runtime resolves the
    // canonical address) lets the handler verify each batch commitment
    // equals a REAL queued commitment and mark it inserted. Without this,
    // a forester signer could fold arbitrary attacker-chosen commitments
    // (e.g. a never-deposited 1,000,000-USDC note) and mint value.
    #[account(
        mut,
        seeds = [
            b"commitment",
            merkle_tree.key().as_ref(),
            &args.start_index.to_le_bytes(),
        ],
        bump = commitment_0.bump,
        constraint = commitment_0.tree == merkle_tree.key() @ ShieldedPoolError::CommitmentMismatch,
    )]
    pub commitment_0: Box<Account<'info, CommitmentRecord>>,

    #[account(
        mut,
        seeds = [
            b"commitment",
            merkle_tree.key().as_ref(),
            &(args.start_index + 1).to_le_bytes(),
        ],
        bump = commitment_1.bump,
        constraint = commitment_1.tree == merkle_tree.key() @ ShieldedPoolError::CommitmentMismatch,
    )]
    pub commitment_1: Box<Account<'info, CommitmentRecord>>,

    #[account(
        mut,
        seeds = [
            b"commitment",
            merkle_tree.key().as_ref(),
            &(args.start_index + 2).to_le_bytes(),
        ],
        bump = commitment_2.bump,
        constraint = commitment_2.tree == merkle_tree.key() @ ShieldedPoolError::CommitmentMismatch,
    )]
    pub commitment_2: Box<Account<'info, CommitmentRecord>>,

    #[account(
        mut,
        seeds = [
            b"commitment",
            merkle_tree.key().as_ref(),
            &(args.start_index + 3).to_le_bytes(),
        ],
        bump = commitment_3.bump,
        constraint = commitment_3.tree == merkle_tree.key() @ ShieldedPoolError::CommitmentMismatch,
    )]
    pub commitment_3: Box<Account<'info, CommitmentRecord>>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct UpdateRootArgs {
    pub proof_a: [u8; 64],
    pub proof_b: [u8; 128],
    pub proof_c: [u8; 64],
    pub old_root: [u8; 32],
    pub new_root: [u8; 32],
    pub start_index: u64,
    /// Exactly `FORESTER_BATCH_SIZE` commitments. Fixed-size array on the
    /// wire so the public-input layout is deterministic and matches the
    /// circuit's `nPublic == 8` declaration.
    pub commitments: [[u8; 32]; FORESTER_BATCH_SIZE],
}

pub fn update_root_handler(ctx: Context<UpdateRoot>, args: UpdateRootArgs) -> Result<()> {
    require!(!ctx.accounts.pool_config.paused, ShieldedPoolError::Paused);

    // **V2 forester authorization** (Stream 4):
    // - If `pool_config.forester_set` has at least one live entry, the
    //   signer must be a member.
    // - If the set is all-default (bootstrap / fresh init), fall back to
    //   admin-signed.
    {
        let cfg = &ctx.accounts.pool_config;
        let signer = ctx.accounts.forester.key();
        if cfg.forester_set_is_empty() {
            require!(signer == cfg.admin, ShieldedPoolError::ForesterNotAuthorized);
        } else {
            require!(
                cfg.is_authorized_forester(&signer),
                ShieldedPoolError::ForesterNotAuthorized
            );
        }
    }

    let end_index = args
        .start_index
        .checked_add(FORESTER_BATCH_SIZE as u64)
        .ok_or(error!(ShieldedPoolError::Overflow))?;

    {
        let tree = ctx.accounts.merkle_tree.load()?;
        // The supplied old_root must be the current active root.
        require!(
            tree.root == args.old_root,
            ShieldedPoolError::RootNotInHistory
        );
        // start_index must match the tree's current next-free leaf so we
        // only fill into empty positions.
        require!(
            args.start_index == tree.next_index,
            ShieldedPoolError::InvalidTreeConfig
        );
        // **V2 invariant**: forester must not fold past what was queued.
        // Slack of FORESTER_BATCH_SIZE is implicit — the batch consumes
        // exactly that many slots from queue_tail. If queue_tail hasn't
        // been advanced that far yet (deposits behind forester), reject.
        // Choice: strict `end_index <= queue_tail` over slack-based
        // tolerance — privacy guarantee is stronger when the forester
        // never folds positions before deposits commit to them.
        require!(
            end_index <= tree.queue_tail,
            ShieldedPoolError::InvalidTreeConfig
        );
        // Tree must not overflow its depth.
        let max_leaves: u64 = 1u64 << tree.depth;
        require!(
            end_index <= max_leaves,
            ShieldedPoolError::InvalidTreeConfig
        );
    }

    // **C4**: bind each batch commitment to a REAL queued
    // `CommitmentRecord`. The forester is a trusted signer, but the
    // batched-update circuit only proves "inserting commitment[i] into an
    // empty slot yields new_root" — it does NOT prove those commitments
    // were ever queued by a deposit/transfer/withdraw. So we verify, for
    // each position, that the PDA at `queue_index = start_index + i` holds
    // exactly `args.commitments[i]` and has not already been folded, then
    // mark it inserted (idempotency + prevents re-folding).
    {
        let records: [&mut Box<Account<CommitmentRecord>>; FORESTER_BATCH_SIZE] = [
            &mut ctx.accounts.commitment_0,
            &mut ctx.accounts.commitment_1,
            &mut ctx.accounts.commitment_2,
            &mut ctx.accounts.commitment_3,
        ];
        for (i, rec) in records.into_iter().enumerate() {
            require!(
                rec.queue_index == args.start_index + i as u64,
                ShieldedPoolError::CommitmentMismatch
            );
            require!(
                rec.commitment == args.commitments[i],
                ShieldedPoolError::CommitmentMismatch
            );
            require!(
                !rec.inserted,
                ShieldedPoolError::CommitmentAlreadyInserted
            );
            rec.inserted = true;
        }
    }

    let mut start_be = [0u8; 32];
    start_be[24..].copy_from_slice(&args.start_index.to_be_bytes());

    // Public-input layout MUST match circuits/batchedUpdate.circom.
    let public_inputs: [[u8; 32]; NUM_PUBLIC_INPUTS] = [
        args.old_root,
        args.new_root,
        start_be,
        args.commitments[0],
        args.commitments[1],
        args.commitments[2],
        args.commitments[3],
        // Padding — circuit constrains `pad === 0`.
        [0u8; 32],
    ];

    {
        let vk = ctx.accounts.verifier_key.load()?;
        let vk_bytes = &vk.bytes[..vk.len as usize];
        verify_forester(VerifyInputs {
            proof_a: &args.proof_a,
            proof_b: &args.proof_b,
            proof_c: &args.proof_c,
            public_inputs: &public_inputs,
            verifier_key: vk_bytes,
        })?;
    }

    let tree_key = ctx.accounts.merkle_tree.key();
    {
        let mut tree = ctx.accounts.merkle_tree.load_mut()?;
        tree.push_root(args.new_root);
        tree.next_index = end_index;
    }

    emit!(RootUpdated {
        tree: tree_key,
        new_root: args.new_root,
        batch_size: FORESTER_BATCH_SIZE as u32,
    });

    Ok(())
}
