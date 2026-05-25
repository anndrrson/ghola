use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::error::ShieldedPoolError;
use crate::events::CommitmentQueued;
use crate::groth16::{verify, VerifyInputs};
use crate::state::{CommitmentRecord, MerkleTree, PoolConfig, VerifierKey, NUM_PUBLIC_INPUTS};

/// Deposit (shield-in) shielded value INTO the pool from a clear-text token
/// account.
///
/// **C-NEW-1 fix (mint-from-nothing).** A deposit is now PROOF-GATED, exactly
/// like withdraw/transfer. Previously this instruction took an opaque
/// `commitment` and an `amount` with NO on-chain proof that the commitment's
/// hidden value equalled the deposited amount — a depositor could transfer 1
/// token and queue a commitment for a note worth 1,000,000, then withdraw the
/// difference, draining escrow. We now require the SAME `transaction.circom`
/// Groth16 proof (and the SAME verifying key) the spend paths use:
///
///   - A deposit is a transaction proof with 2 DUMMY inputs (amount = 0, so the
///     circuit skips their Merkle membership) and 1 REAL output whose value is
///     constrained, in-circuit, to back `publicAmount`. See
///     `circuits/tools/build_deposit_input.js` — the working witness generator.
///   - Conservation `sum(in) === sum(out) + publicAmount` with `sum(in) = 0`
///     and `sum(out) = amount` forces `publicAmount = -amount` (the NEGATIVE /
///     deposit sign — the C1 convention; withdraw is +amount).
///   - The queued `commitment` is bound to the proof's REAL output commitment
///     public input (`out_commitment_0`), so it is now PROVEN to be
///     `Poseidon(amount, asset_id, owner, blinding)` for THIS `amount`.
///
/// **CEREMONY NOTE.** This reuses the transaction verifying key
/// (`CircuitKind::Transfer`) — it inherits the SAME H1 trusted-setup / key
/// regeneration requirement as withdraw/transfer, and NO new ceremony. As with
/// those paths, deposits are (correctly) non-functional until the real prover +
/// regenerated keys land: with `--features real-verifier` off, `verify` is a
/// stub, and a binary built without it must NEVER be deployed to a live network.
#[derive(Accounts)]
#[instruction(args: DepositArgs)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

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

    #[account(
        mut,
        token::mint = mint,
        token::token_program = token_program,
    )]
    pub depositor_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = mint,
        token::authority = pool_config,
        token::token_program = token_program,
    )]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,

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
    pub commitment_record: Box<Account<'info, CommitmentRecord>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct DepositArgs {
    pub proof_a: [u8; 64],
    pub proof_b: [u8; 128],
    pub proof_c: [u8; 64],
    /// Tree root the proof references. For a pure deposit BOTH inputs are
    /// dummies (amount == 0), so the circuit skips their Merkle-membership
    /// check and `root` is semantically irrelevant — it is still part of the
    /// public-input vector (so the on-chain vector matches what the prover
    /// signed) and is canonical-checked, but it is NOT required to be in the
    /// root-history window (a fresh deposit references no real input note).
    pub root: [u8; 32],
    /// First dummy-input nullifier from the proof's public-input vector. The
    /// circuit binds `inputNullifier[0]`. No NullifierAccount PDA is written
    /// for a deposit: both inputs are dummies (amount == 0) and spend nothing,
    /// so there is no note to double-spend-protect.
    pub input_nullifier_0: [u8; 32],
    /// Second dummy-input nullifier (`inputNullifier[1]`).
    pub input_nullifier_1: [u8; 32],
    /// **Load-bearing bind.** The proof's REAL output commitment
    /// (`out_commitment_0`). The handler requires the queued `commitment`
    /// (below) to equal this value, so the opaque commitment is PROVEN
    /// in-circuit to be `Poseidon(amount, asset_id, owner, blinding)` for the
    /// declared `amount` — the fix for C-NEW-1.
    pub output_commitment_0: [u8; 32],
    /// Second output commitment (`out_commitment_1`) — the dummy output
    /// (amount == 0) for the 2-out circuit shape.
    pub output_commitment_1: [u8; 32],
    /// `public_amount` field element committed inside the proof.
    ///
    /// **C1 (deposit sign).** For a DEPOSIT this MUST encode `-(amount)`
    /// (NEGATIVE, i.e. `r - amount`) modulo the BN254 scalar field — a deposit
    /// adds an output note with no real input, so the conservation equation
    /// `sum(in) === sum(out) + publicAmount` gives `publicAmount = -amount`.
    /// (Withdraw, by contrast, encodes `+amount`.) The handler RECOMPUTES the
    /// expected encoding from `amount` and rejects on mismatch.
    pub public_amount: [u8; 32],
    pub asset_id: [u8; 32],
    pub ext_data_hash: [u8; 32],
    /// Gross amount entering the shielded pool (clear-text u64). Transferred
    /// from `depositor_token_account` into `escrow`. Bound to the proof via
    /// `public_amount` and to the note via `output_commitment_0`.
    pub amount: u64,
    /// The Poseidon commitment to queue for the forester. MUST equal
    /// `output_commitment_0` (the proof's real output) — bound below.
    pub commitment: [u8; 32],
    /// **C2 binding input.** Per-output memo commitments the prover folded
    /// into `ext_data_hash`. The handler reconstructs
    /// `ExtData { recipient = 0, mint, fee = 0, relayer_fee = 0,
    /// memo_commitments }` and recomputes `keccak256(borsh(ExtData))`,
    /// rejecting on mismatch. (A deposit moves no tokens OUT of escrow, so
    /// recipient/fee/relayer_fee are all zero — same shape as transfer.)
    pub memo_commitments: Vec<[u8; 32]>,
}

pub fn deposit_handler(ctx: Context<Deposit>, args: DepositArgs) -> Result<()> {
    require!(!ctx.accounts.pool_config.paused, ShieldedPoolError::Paused);
    require!(args.amount > 0, ShieldedPoolError::InsufficientValue);

    // 0. **H2**: every spend-relevant public input must be a CANONICAL
    //    BN254 scalar (< field order). `groth16-solana 0.2.0` does not
    //    enforce this; without it, a value `x` and `x + r` verify
    //    identically but seed DIFFERENT PDA addresses / smuggle an
    //    out-of-range `public_amount`.
    {
        use crate::crypto::is_canonical_field_element;
        for fe in [
            &args.root,
            &args.input_nullifier_0,
            &args.input_nullifier_1,
            &args.output_commitment_0,
            &args.output_commitment_1,
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

    // 1. NO root-history check. A pure deposit has two DUMMY inputs
    //    (amount == 0); the circuit skips their Merkle-membership constraint
    //    (`(1 - isZero) * (computed_root - root) === 0`), so `root` does not
    //    have to be a real, recent root. (Contrast withdraw/transfer, which
    //    spend real inputs and MUST reference a root in the window.)

    // 2. Asset must match the mint.
    require!(args.asset_id != [0u8; 32], ShieldedPoolError::AssetMismatch);
    // Poseidon(mint) == args.asset_id — same syscall binding as withdraw.
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

    // 2b. **C1 (deposit sign)**: bind the clear-text `amount` to the proof's
    //     `public_amount`. A DEPOSIT adds an OUTPUT note with no real input,
    //     so by `sum(in) === sum(out) + publicAmount` (transaction.circom)
    //     with `sum(in) = 0`, `publicAmount = -amount` (NEGATIVE, encoded as
    //     `r - amount`). We recompute `encode_public_amount(-(amount))` and
    //     require it to equal the proof's committed `public_amount` — so
    //     `amount` is not an independent, attacker-controlled input. (Withdraw
    //     binds the POSITIVE encoding; transfer binds zero.)
    {
        use crate::crypto::encode_public_amount;
        let expected = encode_public_amount(-(args.amount as i128));
        require!(
            expected == args.public_amount,
            ShieldedPoolError::PublicAmountMismatch
        );
    }

    // 2c. **C-NEW-1 load-bearing bind**: the queued `commitment` MUST equal
    //     the proof's REAL output commitment (`out_commitment_0`). The
    //     transaction circuit constrains `out_commitment_0 ==
    //     Poseidon(outAmount_0, assetId, ownerPubkey_0, blinding_0)` AND folds
    //     `outAmount_0` into the value-conservation sum that `public_amount`
    //     (bound above to `-amount`) balances. Tying the queued commitment to
    //     this proven output therefore PROVES the queued note's hidden value
    //     equals the deposited `amount`. Without this, the commitment was an
    //     opaque blob and a depositor could queue a note worth far more than
    //     they deposited (mint-from-nothing → escrow drain).
    require!(
        args.commitment == args.output_commitment_0,
        ShieldedPoolError::CommitmentMismatch
    );

    // 3. Public inputs in canonical order — MUST match
    //    `circuits/transaction.circom` and `groth16::PUBLIC_INPUT_LAYOUT`:
    //    [root, in_nf_0, in_nf_1, out_cm_0, out_cm_1, public_amount,
    //     asset_id, ext_data_hash].
    let public_inputs: [[u8; 32]; NUM_PUBLIC_INPUTS] = [
        args.root,
        args.input_nullifier_0,
        args.input_nullifier_1,
        args.output_commitment_0,
        args.output_commitment_1,
        args.public_amount,
        args.asset_id,
        args.ext_data_hash,
    ];

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

    // 3b. **C2**: bind `ext_data_hash` to the on-chain context. A deposit
    //     moves NO tokens out of escrow, so (like a pure transfer)
    //     recipient = 0, fee = 0, relayer_fee = 0; only the per-output memo
    //     commitments vary. Recompute `keccak256(borsh(ExtData))` and reject
    //     on mismatch (prevents proof-malleability / replay against a
    //     different external context).
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

    // 4. CPI: transfer SPL/Token-2022 from depositor → escrow. Uses
    //    `transfer_checked` so it works for both Token and Token-2022 mints
    //    (including extension fee-on-transfer mints, where the on-chain
    //    commitment must reflect post-fee amount — depositor's responsibility
    //    off-chain). Done AFTER all binds so a rejected deposit moves no funds.
    let cpi_accounts = TransferChecked {
        from: ctx.accounts.depositor_token_account.to_account_info(),
        to: ctx.accounts.escrow.to_account_info(),
        authority: ctx.accounts.depositor.to_account_info(),
        mint: ctx.accounts.mint.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
    transfer_checked(cpi_ctx, args.amount, ctx.accounts.mint.decimals)?;

    // 5. Append commitment to the per-tree queue. The forester will fold
    //    batches of these into the tree off-chain and submit a root-update
    //    proof via `update_root_via_proof`.
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
    record.commitment = args.commitment;
    record.queued_slot = clock.slot;
    record.inserted = false;
    record.bump = ctx.bumps.commitment_record;

    emit!(CommitmentQueued {
        tree: tree_key,
        queue_index,
        commitment: args.commitment,
        amount: args.amount,
    });

    Ok(())
}
