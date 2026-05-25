use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::error::ShieldedPoolError;
use crate::events::Withdrawn;
use crate::groth16::{verify, VerifyInputs};
use crate::state::{
    CommitmentRecord, MerkleTree, NullifierAccount, PoolConfig, VerifierKey, NUM_PUBLIC_INPUTS,
};

/// Withdraw shielded value out of the pool to a clear-text token account.
///
/// 1-in / 1-out shape: one nullifier consumed, one change-commitment queued.
/// `public_amount` encodes the value leaving the pool. Optional relayer
/// fee is split off the gross amount and sent to `relayer_token_account`.
#[derive(Accounts)]
#[instruction(args: WithdrawArgs)]
pub struct Withdraw<'info> {
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

    #[account(
        init,
        payer = payer,
        space = 8 + NullifierAccount::INIT_SPACE,
        seeds = [b"nullifier", mint.key().as_ref(), args.nullifier.as_ref()],
        bump,
    )]
    pub nullifier: Box<Account<'info, NullifierAccount>>,

    /// **C3 fix.** Second-input nullifier PDA. The withdraw circuit is a
    /// 2-in/2-out shape (shared vk with transfer); it does NOT force the
    /// second input to be a dummy (amount==0). Previously we wrote no PDA
    /// for `args.input_nullifier_1`, so a caller could spend TWO real
    /// notes in one withdraw and only burn one nullifier → double-spend
    /// the second note. We now `init` a PDA for it exactly like
    /// `transfer.rs`: a real second input is double-spend-protected, and a
    /// dummy second input just consumes a (unique) marker PDA harmlessly.
    /// `init` (not `init_if_needed`) means a repeated nullifier fails with
    /// "already in use" — the on-chain double-spend guard.
    #[account(
        init,
        payer = payer,
        space = 8 + NullifierAccount::INIT_SPACE,
        seeds = [b"nullifier", mint.key().as_ref(), args.input_nullifier_1.as_ref()],
        bump,
    )]
    pub nullifier_1: Box<Account<'info, NullifierAccount>>,

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
    pub change_commitment: Box<Account<'info, CommitmentRecord>>,

    #[account(
        mut,
        token::mint = mint,
        token::authority = pool_config,
        token::token_program = token_program,
    )]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = mint,
        token::token_program = token_program,
    )]
    pub recipient_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Optional relayer payout account. If `args.relayer_fee == 0`, this
    /// can be the same as `recipient_token_account`. Always passed.
    #[account(
        mut,
        token::mint = mint,
        token::token_program = token_program,
    )]
    pub relayer_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct WithdrawArgs {
    pub proof_a: [u8; 64],
    pub proof_b: [u8; 128],
    pub proof_c: [u8; 64],
    pub root: [u8; 32],
    pub nullifier: [u8; 32],
    pub change_commitment: [u8; 32],
    /// Gross amount leaving the shielded pool (clear-text u64).
    pub amount: u64,
    /// Relayer-fee portion of `amount`. Net to recipient = amount - relayer_fee.
    pub relayer_fee: u64,
    /// `public_amount` field element committed inside the proof.
    ///
    /// **C1**: for a WITHDRAW this MUST encode `+(amount)` (positive) modulo
    /// the BN254 scalar field — withdraw spends an input note, so the
    /// conservation equation `sum(in) === sum(out) + publicAmount` gives
    /// `publicAmount = +amount`. (Deposit, by contrast, encodes `r - amount`.)
    /// The handler now RECOMPUTES the expected encoding from `amount` and
    /// rejects on mismatch — it is no longer trusted as supplied. (Kept as
    /// an explicit arg so the on-chain public-input vector matches what
    /// the prover signed byte-for-byte.)
    pub public_amount: [u8; 32],
    pub asset_id: [u8; 32],
    pub ext_data_hash: [u8; 32],
    /// Second output commitment slot — withdraws use a 2-in/2-out circuit
    /// shape to share the same vk as transfer; for a 1-in/1-out shape we
    /// pass a dummy nullifier (already spent) and zero commitment. To keep
    /// the account-set fixed we collapse to 1 commitment here and use a
    /// padding output inside the proof.
    pub _padding_commitment: [u8; 32],
    /// Second-input nullifier from the proof's public-input vector. The
    /// withdraw circuit binds `inputNullifier[1]`.
    ///
    /// **C3**: a `NullifierAccount` PDA is now ALWAYS written for this
    /// value (see `nullifier_1` in the accounts struct). The circuit does
    /// not force the second input to be a dummy, so we must double-spend-
    /// protect it on-chain regardless. A genuine dummy (zero-amount) input
    /// simply burns a unique marker PDA, which is harmless.
    pub input_nullifier_1: [u8; 32],
    /// **C2 binding input.** Per-output memo commitments the prover folded
    /// into `ext_data_hash`. The handler reconstructs
    /// `ExtData { recipient, mint, fee, relayer_fee, memo_commitments }`
    /// from the ACTUAL recipient token account / fees and recomputes
    /// `keccak256(borsh(ExtData))`, rejecting on mismatch.
    pub memo_commitments: Vec<[u8; 32]>,
}

pub fn withdraw_handler(ctx: Context<Withdraw>, args: WithdrawArgs) -> Result<()> {
    require!(!ctx.accounts.pool_config.paused, ShieldedPoolError::Paused);
    require!(
        args.relayer_fee <= args.amount,
        ShieldedPoolError::InsufficientValue
    );

    // 0. **H2**: every spend-relevant public input must be a CANONICAL
    //    BN254 scalar (< field order). `groth16-solana 0.2.0` does not
    //    enforce this; without it, a value `x` and `x + r` verify
    //    identically but seed DIFFERENT nullifier PDAs → double-spend.
    {
        use crate::crypto::is_canonical_field_element;
        for fe in [
            &args.root,
            &args.nullifier,
            &args.input_nullifier_1,
            &args.change_commitment,
            &args._padding_commitment,
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

    // 1. Root window check.
    {
        let tree = ctx.accounts.merkle_tree.load()?;
        require!(
            tree.root_in_history(&args.root),
            ShieldedPoolError::RootNotInHistory
        );
    }

    // 2. Asset must match the mint.
    require!(
        args.asset_id != [0u8; 32],
        ShieldedPoolError::AssetMismatch
    );
    // **Stream 4 (Phase 41 done)**: Poseidon(mint) == args.asset_id
    // syscall check. Requires solana-program >= 1.16 (we run on 1.18).
    {
        use anchor_lang::solana_program::poseidon::{hashv, Endianness, Parameters};
        let mint_bytes = ctx.accounts.mint.key().to_bytes();
        let computed = hashv(
            Parameters::Bn254X5,
            Endianness::BigEndian,
            &[&mint_bytes],
        )
        .map_err(|_| error!(ShieldedPoolError::AssetMismatch))?;
        require!(
            computed.to_bytes() == args.asset_id,
            ShieldedPoolError::AssetMismatch
        );
    }

    // 2b. **C1**: bind the clear-text `amount` to the proof's
    //     `public_amount`.
    //
    //     SIGN CONVENTION (single source of truth: the circuit's value-
    //     conservation constraint `sum(inputs) === sum(outputs) +
    //     publicAmount`, transaction.circom):
    //       * WITHDRAW spends an INPUT note and produces (at most) a smaller
    //         change output, so `sum(in) - sum(out) = amount > 0` and
    //         therefore `publicAmount = +amount` (POSITIVE).
    //       * DEPOSIT adds an OUTPUT note with no input, so
    //         `publicAmount = -amount = r - amount` (NEGATIVE) — see
    //         build_deposit_input.js (the working witness generator).
    //       * TRANSFER has no net flow → `publicAmount = 0`.
    //
    //     We recompute `encode_public_amount(+amount)` from `args.amount`
    //     and require it to equal the proof's committed `public_amount` —
    //     `amount` is therefore no longer an independent, attacker-controlled
    //     input. Without this, a valid proof for a 1-unit note could be
    //     submitted with `amount = <entire escrow>` and drain the pool.
    //
    //     NOTE: a PRIOR version bound the NEGATIVE (deposit) encoding here.
    //     That was INVERTED relative to the circuit: it reverted every honest
    //     withdraw AND let an attacker satisfy the conservation equation with
    //     all-dummy inputs (sum(in)=0, change output = amount, publicAmount =
    //     r-amount), minting a fresh change note while paying out clear
    //     tokens from escrow — a full drain. The positive binding below is
    //     the corrected, load-bearing fix.
    {
        use crate::crypto::encode_public_amount;
        let expected = encode_public_amount(args.amount as i128);
        require!(
            expected == args.public_amount,
            ShieldedPoolError::PublicAmountMismatch
        );
    }

    // 3. Public inputs in canonical order. The second input nullifier
    //    comes from args — it's the dummy input's computed nullifier
    //    (Poseidon3(sk_dummy, commitment_dummy, leaf_index_dummy)),
    //    which is NOT zero. The circuit binds `inputNullifier[1]` so the
    //    on-chain vector must include the prover's value.
    let public_inputs: [[u8; 32]; NUM_PUBLIC_INPUTS] = [
        args.root,
        args.nullifier,
        args.input_nullifier_1,
        args.change_commitment,
        args._padding_commitment,
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

    // 4. Compute the protocol fee.
    let fee_bps = ctx.accounts.pool_config.fee_bps as u64;
    let protocol_fee = args
        .amount
        .checked_mul(fee_bps)
        .ok_or(ShieldedPoolError::Overflow)?
        / 10_000;
    let payout_to_recipient = args
        .amount
        .checked_sub(args.relayer_fee)
        .ok_or(ShieldedPoolError::Overflow)?
        .checked_sub(protocol_fee)
        .ok_or(ShieldedPoolError::Overflow)?;

    // 4b. **C2**: bind `ext_data_hash` to the ACTUAL on-chain context.
    //     Reconstruct the prover's `ExtData` from the real recipient
    //     token account, this tree's mint, the on-chain-derived protocol
    //     fee, the declared relayer fee, and the supplied memo
    //     commitments; recompute `keccak256(borsh(ExtData))` and reject
    //     on mismatch. Without this, a captured/forged proof could be
    //     redirected to an attacker-controlled recipient or have its
    //     relayer fee rewritten — the proof itself only commits to the
    //     opaque hash.
    //
    //     **INTEGRATION REQUIREMENT (C2 fee binding).** `fee` binds to the
    //     ON-CHAIN-DERIVED `protocol_fee = amount * fee_bps / 10_000` using
    //     EXACTLY this rounding (integer division, truncating toward zero).
    //     The off-chain prover/client MUST:
    //       (1) fetch the LIVE `pool_config.fee_bps` (do NOT hard-code it —
    //           governance can change it via `migrate_config`/admin), and
    //       (2) fold `protocol_fee` computed with the identical formula and
    //           rounding into the `ExtData` it hashes for `ext_data_hash`.
    //     A stale or mismatched `fee_bps` produces a different keccak here
    //     and the withdraw reverts with `ExtDataHashMismatch` — i.e. a
    //     fee-config drift surfaces as a CLEAR, attributable error, not a
    //     silent fund loss. See `said-shielded-pool-client::tx_builder`.
    {
        use crate::crypto::{compute_ext_data_hash, ExtData};
        let ext = ExtData {
            recipient: ctx.accounts.recipient_token_account.key().to_bytes(),
            mint: ctx.accounts.mint.key().to_bytes(),
            fee: protocol_fee,
            relayer_fee: args.relayer_fee,
            memo_commitments: args.memo_commitments.clone(),
        };
        require!(
            compute_ext_data_hash(&ext) == args.ext_data_hash,
            ShieldedPoolError::ExtDataHashMismatch
        );
    }

    // 5. Transfer escrow → recipient (+ relayer + protocol-fee sink) via
    //    signer-PDA CPI. Protocol fee stays in escrow as accrued revenue
    //    (admin can sweep via `admin::sweep_fees` — TODO Phase 39).
    let pool_seeds: &[&[u8]] = &[b"pool_config", &[ctx.accounts.pool_config.bump]];
    let signer_seeds = &[pool_seeds];
    let decimals = ctx.accounts.mint.decimals;

    if payout_to_recipient > 0 {
        let cpi_accounts = TransferChecked {
            from: ctx.accounts.escrow.to_account_info(),
            to: ctx.accounts.recipient_token_account.to_account_info(),
            authority: ctx.accounts.pool_config.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        transfer_checked(cpi_ctx, payout_to_recipient, decimals)?;
    }

    if args.relayer_fee > 0 {
        let cpi_accounts = TransferChecked {
            from: ctx.accounts.escrow.to_account_info(),
            to: ctx.accounts.relayer_token_account.to_account_info(),
            authority: ctx.accounts.pool_config.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        transfer_checked(cpi_ctx, args.relayer_fee, decimals)?;
    }

    // 6. Record both input nullifiers + queue change commitment.
    let clock = Clock::get()?;
    let mint_key = ctx.accounts.mint.key();
    let nf = &mut ctx.accounts.nullifier;
    nf.nullifier = args.nullifier;
    nf.mint = mint_key;
    nf.spent_slot = clock.slot;
    nf.bump = ctx.bumps.nullifier;

    // **C3**: persist the second-input nullifier too. The `init` on
    // `nullifier_1` already guaranteed it was unused; recording it makes
    // it permanently spent so a real second input cannot be double-spent.
    let nf1 = &mut ctx.accounts.nullifier_1;
    nf1.nullifier = args.input_nullifier_1;
    nf1.mint = mint_key;
    nf1.spent_slot = clock.slot;
    nf1.bump = ctx.bumps.nullifier_1;

    let tree_key = ctx.accounts.merkle_tree.key();
    // **V2**: withdraw advances `queue_tail` (deposit/withdraw write-pointer),
    // NOT `next_index`. The forester is responsible for advancing
    // `next_index` to match via batched update proofs.
    let queue_index = {
        let mut tree = ctx.accounts.merkle_tree.load_mut()?;
        let queue_index = tree.queue_tail;
        tree.queue_tail = tree
            .queue_tail
            .checked_add(1)
            .ok_or(ShieldedPoolError::Overflow)?;
        queue_index
    };
    let cm = &mut ctx.accounts.change_commitment;
    cm.tree = tree_key;
    cm.queue_index = queue_index;
    cm.commitment = args.change_commitment;
    cm.queued_slot = clock.slot;
    cm.inserted = false;
    cm.bump = ctx.bumps.change_commitment;

    emit!(Withdrawn {
        tree: tree_key,
        nullifier: args.nullifier,
        recipient: ctx.accounts.recipient_token_account.key(),
        amount: payout_to_recipient,
        relayer_fee: args.relayer_fee,
    });

    Ok(())
}
