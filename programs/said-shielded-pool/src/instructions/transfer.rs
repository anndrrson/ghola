use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

use crate::error::ShieldedPoolError;
use crate::events::{CommitmentQueued, Transferred};
use crate::groth16::{verify, VerifyInputs};
use crate::state::{
    CommitmentRecord, MerkleTree, NullifierAccount, PoolConfig, VerifierKey, NUM_PUBLIC_INPUTS,
};

/// Shielded transfer — two inputs in, two outputs out (2-in / 2-out).
///
/// The proof binds:
///   - inclusion of input commitments under `root`
///   - correct derivation of nullifiers from spending key
///   - `public_amount == 0` (no net value movement)
///   - `asset_id == Poseidon(mint)` (single-asset only)
///   - `ext_data_hash` binds relayer/recipient/fee externals (Sapling-style)
#[derive(Accounts)]
#[instruction(args: TransferArgs)]
pub struct Transfer<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [b"pool_config"],
        bump = pool_config.bump,
        has_one = verifier_key @ ShieldedPoolError::VerifierKeyMismatch,
    )]
    pub pool_config: Box<Account<'info, PoolConfig>>,

    pub verifier_key: AccountLoader<'info, VerifierKey>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        seeds = [b"merkle_tree", pool_config.key().as_ref(), mint.key().as_ref()],
        bump = merkle_tree.load()?.bump,
        constraint = merkle_tree.load()?.mint == mint.key() @ ShieldedPoolError::AssetMismatch,
    )]
    pub merkle_tree: AccountLoader<'info, MerkleTree>,

    /// Nullifier PDA #0 — init-if-needed; if already initialized this
    /// instruction fails with the system program's "already in use" error,
    /// which surfaces as a double-spend.
    ///
    /// Boxed to keep Anchor's generated `try_accounts` off the 4 KiB BPF
    /// stack frame — `Box<Account<T>>` deserializes onto the heap.
    #[account(
        init,
        payer = payer,
        space = 8 + NullifierAccount::INIT_SPACE,
        seeds = [b"nullifier", mint.key().as_ref(), args.input_nullifiers[0].as_ref()],
        bump,
    )]
    pub nullifier_0: Box<Account<'info, NullifierAccount>>,

    #[account(
        init,
        payer = payer,
        space = 8 + NullifierAccount::INIT_SPACE,
        seeds = [b"nullifier", mint.key().as_ref(), args.input_nullifiers[1].as_ref()],
        bump,
    )]
    pub nullifier_1: Box<Account<'info, NullifierAccount>>,

    /// Output commitments queued into the tree.
    /// **V2**: indexed by `queue_tail` (deposit/transfer write-pointer),
    /// not `next_index` (forester write-pointer).
    #[account(
        init,
        payer = payer,
        space = 8 + CommitmentRecord::INIT_SPACE,
        seeds = [
            b"commitment",
            merkle_tree.key().as_ref(),
            &merkle_tree.load()?.queue_tail.to_le_bytes(),
        ],
        bump,
    )]
    pub commitment_0: Box<Account<'info, CommitmentRecord>>,

    #[account(
        init,
        payer = payer,
        space = 8 + CommitmentRecord::INIT_SPACE,
        seeds = [
            b"commitment",
            merkle_tree.key().as_ref(),
            &(merkle_tree.load()?.queue_tail + 1).to_le_bytes(),
        ],
        bump,
    )]
    pub commitment_1: Box<Account<'info, CommitmentRecord>>,

    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct TransferArgs {
    pub proof_a: [u8; 64],
    pub proof_b: [u8; 128],
    pub proof_c: [u8; 64],
    pub root: [u8; 32],
    pub input_nullifiers: [[u8; 32]; 2],
    pub output_commitments: [[u8; 32]; 2],
    pub public_amount: [u8; 32],
    pub asset_id: [u8; 32],
    pub ext_data_hash: [u8; 32],
    /// **C2 binding input.** Per-output encrypted-note-memo commitments, in
    /// order, that the prover folded into `ext_data_hash`. The handler
    /// recomputes `keccak256(borsh(ExtData))` from these (plus the real
    /// mint and the transfer-fixed recipient=0 / fee=0 / relayer_fee=0) and
    /// rejects if it doesn't match `ext_data_hash`. Empty for memo-less
    /// transfers — but it MUST equal exactly what the prover hashed.
    pub memo_commitments: Vec<[u8; 32]>,
}

pub fn transfer_handler(ctx: Context<Transfer>, args: TransferArgs) -> Result<()> {
    require!(!ctx.accounts.pool_config.paused, ShieldedPoolError::Paused);

    // 0. **H2**: every spend-relevant public input must be a CANONICAL
    //    BN254 scalar (< field order). `groth16-solana 0.2.0` does not
    //    enforce this; without it, a value `x` and `x + r` verify
    //    identically but seed DIFFERENT nullifier PDAs → double-spend.
    {
        use crate::crypto::is_canonical_field_element;
        for fe in [
            &args.root,
            &args.input_nullifiers[0],
            &args.input_nullifiers[1],
            &args.output_commitments[0],
            &args.output_commitments[1],
            &args.public_amount,
            &args.asset_id,
            &args.ext_data_hash,
        ] {
            require!(
                is_canonical_field_element(fe),
                ShieldedPoolError::NonCanonicalPublicInput
            );
        }
    }

    // 1. Spend-side: the referenced root must be in the rolling history.
    {
        let tree = ctx.accounts.merkle_tree.load()?;
        require!(
            tree.root_in_history(&args.root),
            ShieldedPoolError::RootNotInHistory
        );
    }

    // 2. Assemble public-input vector. Order MUST match circuit + types crate.
    let public_inputs: [[u8; 32]; NUM_PUBLIC_INPUTS] = [
        args.root,
        args.input_nullifiers[0],
        args.input_nullifiers[1],
        args.output_commitments[0],
        args.output_commitments[1],
        args.public_amount,
        args.asset_id,
        args.ext_data_hash,
    ];

    // 3. Groth16 verify (~200k CU when real-verifier is on).
    {
        let vk = ctx.accounts.verifier_key.load()?;
        let vk_bytes = &vk.bytes[..vk.len as usize];
        verify(VerifyInputs {
            proof_a: &args.proof_a,
            proof_b: &args.proof_b,
            proof_c: &args.proof_c,
            public_inputs: &public_inputs,
            verifier_key: vk_bytes,
        })?;
    }

    // 4. Sanity-check: public_amount must be zero (no net flow on transfer).
    //    The field element is the BN254 canonical encoding of 0 → 32 zero bytes.
    if args.public_amount != [0u8; 32] {
        return err!(ShieldedPoolError::InsufficientValue);
    }

    // 5. **M (asset_id parity)**: bind `args.asset_id == Poseidon(mint)`.
    //    The circuit constrains a single shared `assetId` across all
    //    notes, but nothing inside the circuit ties it to THIS tree's
    //    mint — so we recompute it on-chain via the Poseidon syscall and
    //    reject a mismatch. Prevents an asset-A proof being applied to an
    //    asset-B tree in a multi-asset deployment.
    {
        use anchor_lang::solana_program::poseidon::{hashv, Endianness, Parameters};
        let mint_bytes = ctx.accounts.mint.key().to_bytes();
        let computed = hashv(Parameters::Bn254X5, Endianness::BigEndian, &[&mint_bytes])
            .map_err(|_| error!(ShieldedPoolError::AssetMismatch))?;
        require!(
            computed.to_bytes() == args.asset_id,
            ShieldedPoolError::AssetMismatch
        );
    }

    // 5b. **C2**: recompute `ext_data_hash` and bind it. For a pure
    //     shielded transfer there is no token movement, so the external
    //     data is fixed except for the per-output memo commitments:
    //     recipient = 0, fee = 0, relayer_fee = 0, mint = this tree's mint.
    //     This prevents proof-malleability / replay against a different
    //     external context.
    {
        use crate::crypto::{compute_ext_data_hash, ExtData};
        let ext = ExtData {
            recipient: [0u8; 32],
            mint: ctx.accounts.mint.key().to_bytes(),
            fee: 0,
            relayer_fee: 0,
            memo_commitments: args.memo_commitments.clone(),
        };
        require!(
            compute_ext_data_hash(&ext) == args.ext_data_hash,
            ShieldedPoolError::ExtDataHashMismatch
        );
    }

    // 6. Mark nullifiers spent.
    let clock = Clock::get()?;
    let nf0 = &mut ctx.accounts.nullifier_0;
    nf0.nullifier = args.input_nullifiers[0];
    nf0.mint = ctx.accounts.mint.key();
    nf0.spent_slot = clock.slot;
    nf0.bump = ctx.bumps.nullifier_0;

    let nf1 = &mut ctx.accounts.nullifier_1;
    nf1.nullifier = args.input_nullifiers[1];
    nf1.mint = ctx.accounts.mint.key();
    nf1.spent_slot = clock.slot;
    nf1.bump = ctx.bumps.nullifier_1;

    // 7. Queue output commitments.
    // **V2**: indices come from `queue_tail` (deposit write-pointer);
    // `next_index` only advances on forester batches.
    let tree_key = ctx.accounts.merkle_tree.key();
    let idx_0 = ctx.accounts.merkle_tree.load()?.queue_tail;
    let idx_1 = idx_0.checked_add(1).ok_or(ShieldedPoolError::Overflow)?;

    let c0 = &mut ctx.accounts.commitment_0;
    c0.tree = tree_key;
    c0.queue_index = idx_0;
    c0.commitment = args.output_commitments[0];
    c0.queued_slot = clock.slot;
    c0.inserted = false;
    c0.bump = ctx.bumps.commitment_0;

    let c1 = &mut ctx.accounts.commitment_1;
    c1.tree = tree_key;
    c1.queue_index = idx_1;
    c1.commitment = args.output_commitments[1];
    c1.queued_slot = clock.slot;
    c1.inserted = false;
    c1.bump = ctx.bumps.commitment_1;

    {
        let mut tree = ctx.accounts.merkle_tree.load_mut()?;
        // **V2**: transfer advances `queue_tail` by 2 (one per output).
        // The forester later advances `next_index` to match via batched
        // update proofs.
        tree.queue_tail = idx_1
            .checked_add(1)
            .ok_or(ShieldedPoolError::Overflow)?;
    }

    emit!(CommitmentQueued {
        tree: tree_key,
        queue_index: idx_0,
        commitment: args.output_commitments[0],
        amount: 0,
    });
    emit!(CommitmentQueued {
        tree: tree_key,
        queue_index: idx_1,
        commitment: args.output_commitments[1],
        amount: 0,
    });
    emit!(Transferred {
        tree: tree_key,
        input_nullifiers: args.input_nullifiers,
        output_commitments: args.output_commitments,
        ext_data_hash: args.ext_data_hash,
    });

    Ok(())
}
