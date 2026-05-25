//! Assemble Solana instructions for the said-shielded-pool program.
//!
//! Builds [`RawInstruction`]s without pulling in the heavy `solana-sdk`
//! dep tree. Same pattern as `crates/said-solana/src/instructions.rs` —
//! mirrors Anchor's wire format (8-byte discriminator + Borsh args) but
//! lets the caller (CLI, daemon) sign and ship the resulting bytes
//! however it likes (raw RPC, Turnkey, MWA).
//!
//! ## PDAs
//!
//! ```text
//! pool_config = PDA(["pool"],                 program_id)
//! merkle_tree = PDA(["tree", tree_id_le8],    program_id)
//! nullifier   = PDA(["nullifier", mint, nf_bytes], program_id)
//! escrow      = PDA(["escrow", mint],         program_id)
//! ```
//!
//! ## Public-amount encoding
//!
//! `public_amount` is a *signed* field element. We encode it as
//! `value mod p` where `p` is the BN254 scalar field order:
//!
//! ```text
//! p = 21888242871839275222246405745257275088548364400416034343698204186575808495617
//! ```
//!
//! Single source of truth: the circuit's value-conservation constraint
//! `sum(inputs) === sum(outputs) + publicAmount` (transaction.circom),
//! combined with the physical meaning of each direction:
//!
//! - Deposit (value enters pool):  adds an OUTPUT note, no input, so
//!   `0 = amount + publicAmount` → `publicAmount = -amount = (p − amount) mod p`.
//! - Withdraw (value leaves pool): spends an INPUT note, so
//!   `amount = 0 + publicAmount` → `publicAmount = +amount mod p`.
//! - Pure shielded transfer:       no net flow → `publicAmount = 0`.
//!
//! This matches `build_deposit_input.js` (the working witness generator)
//! and `encode_public_amount` below: deposit NEGATIVE, withdraw POSITIVE.
//! (Earlier docs/comments here had this backwards.) See SPEC.md §11.2/§15.
//!
//! ## `ext_data_hash`
//!
//! `keccak256(borsh(ExtData))`. This is a *binding-only* public signal:
//! the Circom circuit does not recompute it from the witness, it merely
//! constrains the proof to commit to whatever value is supplied as a
//! public input. The on-chain program recomputes the keccak256 from the
//! tx payload and rejects on mismatch. So unlike commitments and
//! nullifiers, this stays keccak (NOT Poseidon) by design.

use borsh::{BorshDeserialize, BorshSerialize};
use sha2::{Digest, Sha256};
use tiny_keccak::{Hasher, Keccak};

use said_shielded_pool_types::{FieldBytes, Nullifier, ProofBundle};

use crate::error::Result;

/// Re-exported account-meta type — same shape as `solana_program::AccountMeta`
/// but without the dep. Compatible with `said-solana::AccountMeta`.
#[derive(Debug, Clone)]
pub struct AccountMeta {
    /// 32-byte Solana public key.
    pub pubkey: [u8; 32],
    /// Whether this account must sign the transaction.
    pub is_signer: bool,
    /// Whether this account is mutated by the instruction.
    pub is_writable: bool,
}

impl AccountMeta {
    /// Writable, optional signer.
    pub fn new(pubkey: [u8; 32], is_signer: bool) -> Self {
        Self {
            pubkey,
            is_signer,
            is_writable: true,
        }
    }
    /// Read-only, optional signer.
    pub fn new_readonly(pubkey: [u8; 32], is_signer: bool) -> Self {
        Self {
            pubkey,
            is_signer,
            is_writable: false,
        }
    }
}

/// Raw Solana instruction (program id + accounts + opaque data).
#[derive(Debug, Clone)]
pub struct RawInstruction {
    /// Target program ID.
    pub program_id: [u8; 32],
    /// Instruction accounts, in the order the program expects.
    pub accounts: Vec<AccountMeta>,
    /// Instruction data — Anchor 8-byte discriminator + Borsh args.
    pub data: Vec<u8>,
}

/// Compute the 8-byte Anchor instruction discriminator for `global:<name>`.
pub fn discriminator(name: &str) -> [u8; 8] {
    let mut hasher = Sha256::new();
    hasher.update(format!("global:{name}").as_bytes());
    let hash = hasher.finalize();
    let mut disc = [0u8; 8];
    disc.copy_from_slice(&hash[..8]);
    disc
}

/// BN254 scalar field order `r` (big-endian).
///
/// `r = 21888242871839275222246405745257275088548364400416034343698204186575808495617`
pub const BN254_SCALAR_FIELD_BE: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

/// Encode a signed `public_amount` as a BN254 field element (big-endian).
///
/// - `value >= 0` → `value` as a 32-byte big-endian unsigned integer.
/// - `value < 0`  → `(r - |value|) mod r`.
///
/// Panics if `|value|` overflows the field (effectively never for
/// `i128` amounts).
pub fn encode_public_amount(value: i128) -> FieldBytes {
    if value >= 0 {
        let mut out = [0u8; 32];
        let bytes = (value as u128).to_be_bytes();
        out[16..].copy_from_slice(&bytes);
        out
    } else {
        // r - |value|, with |value| fitting in 16 bytes.
        let abs = value.unsigned_abs();
        let abs_bytes = abs.to_be_bytes();
        let mut abs32 = [0u8; 32];
        abs32[16..].copy_from_slice(&abs_bytes);
        sub_be(&BN254_SCALAR_FIELD_BE, &abs32)
    }
}

/// Big-endian 32-byte subtraction, no underflow check beyond debug.
fn sub_be(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut borrow: i16 = 0;
    for i in (0..32).rev() {
        let v = a[i] as i16 - b[i] as i16 - borrow;
        if v < 0 {
            out[i] = (v + 256) as u8;
            borrow = 1;
        } else {
            out[i] = v as u8;
            borrow = 0;
        }
    }
    debug_assert_eq!(borrow, 0, "sub_be underflow");
    out
}

/// External data binding the proof to a specific on-chain context.
///
/// Hashed into `ext_data_hash` via `Keccak256(borsh(ExtData))`. This is a
/// binding-only public signal: the Circom circuit doesn't recompute it,
/// only constrains the proof to commit to whatever value is supplied
/// publicly. The on-chain program recomputes the keccak256 over the
/// borsh-serialized tx-side `ExtData` and rejects on mismatch.
#[derive(Debug, Clone, BorshSerialize, BorshDeserialize)]
pub struct ExtData {
    /// Recipient SPL token account (32 bytes). Zero for pure shielded
    /// transfers.
    pub recipient: [u8; 32],
    /// Token-mint pubkey. Used to identify the escrow account.
    pub mint: [u8; 32],
    /// Network fee (paid to the protocol; charged out of the value
    /// being moved).
    pub fee: u64,
    /// Relayer fee (paid to whichever relayer broadcasts the tx).
    pub relayer_fee: u64,
    /// Commitment to encrypted note memos for each output, in order.
    /// Each entry is 32 bytes. Empty for deposits without memos.
    pub memo_commitments: Vec<[u8; 32]>,
}

/// Compute `ext_data_hash` from an [`ExtData`].
///
/// `keccak256(borsh(ExtData))` — binding-only public signal. The circuit
/// does not recompute this; the on-chain program does, and rejects on
/// mismatch. See the module docstring for the full rationale.
pub fn compute_ext_data_hash(ext: &ExtData) -> FieldBytes {
    let bytes = borsh::to_vec(ext).expect("borsh ExtData serialize must not fail");
    let mut hasher = Keccak::v256();
    hasher.update(&bytes);
    let mut out = [0u8; 32];
    hasher.finalize(&mut out);
    // Reduce into BN254 scalar field — top 3 bits cleared.
    out[0] &= 0b0001_1111;
    out
}

/// PDA: `[b"pool"]`. Address-only — bump derivation requires on-curve
/// elimination (handled by `said-solana::pda`).
pub fn pool_config_seeds() -> Vec<Vec<u8>> {
    vec![b"pool".to_vec()]
}

/// PDA: `[b"tree", tree_id.to_le_bytes()]`.
pub fn merkle_tree_seeds(tree_id: u64) -> Vec<Vec<u8>> {
    vec![b"tree".to_vec(), tree_id.to_le_bytes().to_vec()]
}

/// PDA: `[b"nullifier", mint, nullifier_bytes]` — MUST match the on-chain
/// seeds used by deposit/withdraw/transfer (see `state.rs`). The mint scopes
/// the nullifier per-asset; omitting it derives the wrong address.
pub fn nullifier_seeds(mint: &[u8; 32], nf: &Nullifier) -> Vec<Vec<u8>> {
    vec![b"nullifier".to_vec(), mint.to_vec(), nf.0.to_vec()]
}

/// PDA: `[b"escrow", mint.to_bytes()]`.
pub fn escrow_seeds(mint: &[u8; 32]) -> Vec<Vec<u8>> {
    vec![b"escrow".to_vec(), mint.to_vec()]
}

// NOTE: the proof bytes (A 64B / B 128B / C 64B) are embedded directly as
// `proof_a` / `proof_b` / `proof_c` fields of `WithdrawArgs` / `TransferArgs`
// below, matching the on-chain Anchor structs. (The former standalone
// `ProofArg` wire struct is gone — the mirror structs ARE the wire format.)

// =============================================================================
// ON-CHAIN ARG MIRRORS (single source of truth: the program's Anchor structs)
// =============================================================================
//
// Anchor deserializes instruction data as `borsh(ArgsStruct)` in DECLARED
// FIELD ORDER (after the 8-byte discriminator). These structs MUST mirror
// the on-chain definitions field-for-field, in order, or the program will
// misparse / reject the transaction.
//
// SOURCE OF TRUTH:
//   * `programs/said-shielded-pool/src/instructions/withdraw.rs::WithdrawArgs`
//   * `programs/said-shielded-pool/src/instructions/transfer.rs::TransferArgs`
//
// Borsh layout is identical to AnchorSerialize for these plain-data structs
// (fixed arrays serialize as raw bytes; `Vec<[u8;32]>` as u32-LE len + items;
// `u64` as 8-byte LE). The round-trip test `args_round_trip_*` in this file's
// `tests` module is the regression guard against drift.

/// Mirror of on-chain `WithdrawArgs`. Field order is load-bearing.
/// Fields are documented in the source-of-truth program struct
/// (`programs/said-shielded-pool/src/instructions/withdraw.rs`).
#[allow(missing_docs)]
#[derive(Debug, Clone, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct WithdrawArgs {
    pub proof_a: [u8; 64],
    pub proof_b: [u8; 128],
    pub proof_c: [u8; 64],
    pub root: [u8; 32],
    pub nullifier: [u8; 32],
    pub change_commitment: [u8; 32],
    pub amount: u64,
    pub relayer_fee: u64,
    pub public_amount: [u8; 32],
    pub asset_id: [u8; 32],
    pub ext_data_hash: [u8; 32],
    pub padding_commitment: [u8; 32],
    pub input_nullifier_1: [u8; 32],
    pub memo_commitments: Vec<[u8; 32]>,
}

/// Mirror of on-chain `TransferArgs`. Field order is load-bearing.
/// Fields are documented in the source-of-truth program struct
/// (`programs/said-shielded-pool/src/instructions/transfer.rs`).
#[allow(missing_docs)]
#[derive(Debug, Clone, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
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
    pub memo_commitments: Vec<[u8; 32]>,
}

/// Mirror of on-chain `DepositArgs`. Field order is load-bearing.
/// Fields are documented in the source-of-truth program struct
/// (`programs/said-shielded-pool/src/instructions/deposit.rs`).
///
/// **C-NEW-1**: a deposit is now a `transaction.circom` proof (dummy inputs +
/// one real output). `public_amount` is the NEGATIVE deposit-sign encoding of
/// `amount`, and `commitment` MUST equal `output_commitment_0` (the proof's
/// real output) — the on-chain handler rejects on mismatch.
#[allow(missing_docs)]
#[derive(Debug, Clone, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct DepositArgs {
    pub proof_a: [u8; 64],
    pub proof_b: [u8; 128],
    pub proof_c: [u8; 64],
    pub root: [u8; 32],
    pub input_nullifier_0: [u8; 32],
    pub input_nullifier_1: [u8; 32],
    pub output_commitment_0: [u8; 32],
    pub output_commitment_1: [u8; 32],
    pub public_amount: [u8; 32],
    pub asset_id: [u8; 32],
    pub ext_data_hash: [u8; 32],
    pub amount: u64,
    pub commitment: [u8; 32],
    pub memo_commitments: Vec<[u8; 32]>,
}

/// Full accounts layout — supplied by the caller so the SDK doesn't
/// need to know how PDAs are resolved (`said-solana::pda` handles that;
/// CLI/daemon do `find_program_address` then hand the bumps in).
#[derive(Debug, Clone)]
pub struct PoolAccounts {
    /// Caller / fee payer.
    pub payer: [u8; 32],
    /// Pool config PDA.
    pub pool_config: [u8; 32],
    /// Active Merkle tree PDA.
    pub merkle_tree: [u8; 32],
    /// Token mint of the asset being moved.
    pub mint: [u8; 32],
    /// Escrow PDA holding pooled tokens for `mint`.
    pub escrow_ata: [u8; 32],
    /// Source ATA (deposit) or destination ATA (withdraw).
    pub user_ata: [u8; 32],
    /// SPL token program.
    pub token_program: [u8; 32],
    /// System program (for nullifier PDA `init`).
    pub system_program: [u8; 32],
    /// Nullifier PDAs — one per input nullifier in the proof.
    pub nullifiers: Vec<[u8; 32]>,
}

/// Accounts for `deposit`, in the on-chain `Deposit<'info>` order.
/// (Deposit has a different account set than transfer/withdraw — notably
/// the queued `commitment_record` PDA. **C-NEW-2**: it now ALSO carries two
/// nullifier PDAs, exactly like transfer's 2-in shape, so a real input spent
/// on the deposit path is double-spend-protected.)
#[derive(Debug, Clone)]
pub struct DepositAccounts {
    /// Depositor / fee payer (signer).
    pub depositor: [u8; 32],
    /// Pool config PDA.
    pub pool_config: [u8; 32],
    /// VerifierKey PDA (transaction VK). **C-NEW-1**: deposit is now
    /// proof-gated, so the verifier-key account is required (same as
    /// withdraw/transfer).
    pub verifier_key: [u8; 32],
    /// Token mint being deposited.
    pub mint: [u8; 32],
    /// Active Merkle tree PDA for `mint`.
    pub merkle_tree: [u8; 32],
    /// **C-NEW-2**: NullifierAccount PDA for `input_nullifier_0`, seeds
    /// `[b"nullifier", mint, input_nullifier_0]`. `init`-ed by the ix.
    pub nullifier_0: [u8; 32],
    /// **C-NEW-2**: NullifierAccount PDA for `input_nullifier_1`, seeds
    /// `[b"nullifier", mint, input_nullifier_1]`. `init`-ed by the ix.
    pub nullifier_1: [u8; 32],
    /// Depositor's source token account.
    pub depositor_token_account: [u8; 32],
    /// Escrow token account (program-owned) for `mint`.
    pub escrow_ata: [u8; 32],
    /// `CommitmentRecord` PDA at the current `queue_tail` (init'd by the ix).
    pub commitment_record: [u8; 32],
    /// SPL token program.
    pub token_program: [u8; 32],
    /// System program.
    pub system_program: [u8; 32],
}

/// Build `deposit(args: DepositArgs)` — proof-gated shield-in.
///
/// SOURCE OF TRUTH: `programs/said-shielded-pool/src/instructions/deposit.rs`.
///
/// **C-NEW-1 fix.** Deposit is now PROOF-GATED. A deposit is a
/// `transaction.circom` Groth16 proof with 2 DUMMY inputs (amount = 0) and 1
/// REAL output (the deposited note); the on-chain handler binds:
///   - `public_amount == encode_public_amount(-(amount))` — the NEGATIVE
///     deposit sign (deposit adds an output note → `publicAmount = -amount`,
///     the C1 convention; withdraw is `+amount`). DERIVED here from `amount`,
///     so the bundle's own `public_amount` is ignored to avoid drift.
///   - the queued `commitment` == the proof's real `output_commitment_0`, so
///     the note's hidden value is proven to equal the deposited `amount`.
///
/// The `ProofBundle.public_inputs` MUST carry exactly 2 input nullifiers and
/// 2 output commitments (the 2-in/2-out circuit shape); the REAL deposit
/// output is `output_commitments[0]` (see `build_deposit_input.js`). Otherwise
/// this returns an `Encoding` error.
///
/// `memo_commitments` MUST equal exactly the per-output memo commitments the
/// prover folded into `ext_data_hash` (the on-chain handler rebuilds
/// `ExtData { recipient = 0, mint, fee = 0, relayer_fee = 0, memo_commitments }`
/// and rejects a mismatch — same C2 binding as transfer).
///
/// **Ceremony note**: reuses the transaction VK, so it inherits the SAME H1
/// trusted-setup requirement as withdraw/transfer (no NEW ceremony). Deposits
/// are non-functional until the real prover + regenerated keys land.
///
/// Accounts order MUST match `Deposit<'info>`:
///   depositor, pool_config, verifier_key, mint, merkle_tree,
///   nullifier_0, nullifier_1, depositor_token_account, escrow,
///   commitment_record, token_program, system_program.
///   (**C-NEW-2**: nullifier_0 / nullifier_1 added — two `init`-ed
///   NullifierAccount PDAs so a real input spent on the deposit path is
///   double-spend-protected, mirroring transfer's 2-in shape.)
pub fn build_deposit_ix(
    program_id: &[u8; 32],
    accounts: &DepositAccounts,
    proof: &ProofBundle,
    amount: u64,
    memo_commitments: Vec<[u8; 32]>,
) -> Result<RawInstruction> {
    let pi = &proof.public_inputs;
    let input_nullifiers = exactly_two(
        pi.input_nullifiers.iter().map(|n| n.0),
        "deposit input_nullifiers",
    )?;
    let output_commitments = exactly_two(
        pi.output_commitments.iter().map(|c| c.0),
        "deposit output_commitments",
    )?;

    // The REAL deposit output is slot 0; the queued commitment is bound to it
    // on-chain. We surface it as `commitment` too so the wire struct carries
    // both (the program requires `commitment == output_commitment_0`).
    let real_output = output_commitments[0];

    let args = DepositArgs {
        proof_a: proof.proof.a,
        proof_b: proof.proof.b,
        proof_c: proof.proof.c,
        root: pi.root.0,
        input_nullifier_0: input_nullifiers[0],
        input_nullifier_1: input_nullifiers[1],
        output_commitment_0: output_commitments[0],
        output_commitment_1: output_commitments[1],
        // C1 (deposit sign): deposit adds an output note with no real input →
        // `sum(in)=0 === sum(out)=amount + publicAmount` → publicAmount =
        // -amount (NEGATIVE, encoded `r - amount`). Must equal the on-chain
        // `encode_public_amount(-(amount as i128))`.
        public_amount: encode_public_amount(-(amount as i128)),
        asset_id: pi.asset_id.0,
        ext_data_hash: pi.ext_data_hash,
        amount,
        commitment: real_output,
        memo_commitments,
    };

    let mut data = Vec::new();
    data.extend_from_slice(&discriminator("deposit"));
    let serialized = borsh::to_vec(&args).map_err(|e| {
        crate::error::Error::Encoding(format!("borsh DepositArgs serialize: {e}"))
    })?;
    data.extend_from_slice(&serialized);

    let metas = vec![
        AccountMeta::new(accounts.depositor, true),
        AccountMeta::new_readonly(accounts.pool_config, false),
        AccountMeta::new_readonly(accounts.verifier_key, false),
        AccountMeta::new_readonly(accounts.mint, false),
        AccountMeta::new(accounts.merkle_tree, false),
        // **C-NEW-2**: two init'd nullifier PDAs (writable), before the token
        // accounts — matches the on-chain `Deposit<'info>` account order.
        AccountMeta::new(accounts.nullifier_0, false),
        AccountMeta::new(accounts.nullifier_1, false),
        AccountMeta::new(accounts.depositor_token_account, false),
        AccountMeta::new(accounts.escrow_ata, false),
        AccountMeta::new(accounts.commitment_record, false),
        AccountMeta::new_readonly(accounts.token_program, false),
        AccountMeta::new_readonly(accounts.system_program, false),
    ];

    Ok(RawInstruction {
        program_id: *program_id,
        accounts: metas,
        data,
    })
}

/// Build `transfer(args: TransferArgs)` — pure shielded transfer.
///
/// No tokens cross the program boundary; `public_amount` MUST be zero
/// (the on-chain handler enforces this), so this builder hard-codes the
/// 32-zero-byte field element rather than trusting the bundle.
///
/// `memo_commitments` MUST equal exactly the per-output memo commitments
/// the prover folded into `ext_data_hash` (the on-chain handler rebuilds
/// `ExtData { recipient=0, mint, fee=0, relayer_fee=0, memo_commitments }`
/// and rejects a mismatch — see withdraw/transfer C2 binding).
///
/// The `ProofBundle.public_inputs` MUST carry exactly 2 input nullifiers
/// and 2 output commitments (the 2-in/2-out circuit shape); otherwise this
/// returns an `Encoding` error.
pub fn build_transfer_ix(
    program_id: &[u8; 32],
    accounts: &PoolAccounts,
    proof: &ProofBundle,
    memo_commitments: Vec<[u8; 32]>,
) -> Result<RawInstruction> {
    let pi = &proof.public_inputs;
    let input_nullifiers = exactly_two(
        pi.input_nullifiers.iter().map(|n| n.0),
        "transfer input_nullifiers",
    )?;
    let output_commitments = exactly_two(
        pi.output_commitments.iter().map(|c| c.0),
        "transfer output_commitments",
    )?;

    let args = TransferArgs {
        proof_a: proof.proof.a,
        proof_b: proof.proof.b,
        proof_c: proof.proof.c,
        root: pi.root.0,
        input_nullifiers,
        output_commitments,
        // Pure transfer: net flow is zero. The on-chain handler requires
        // `public_amount == [0u8; 32]`, so we emit the canonical zero.
        public_amount: [0u8; 32],
        asset_id: pi.asset_id.0,
        ext_data_hash: pi.ext_data_hash,
        memo_commitments,
    };

    let mut data = Vec::new();
    data.extend_from_slice(&discriminator("transfer"));
    let serialized = borsh::to_vec(&args).map_err(|e| {
        crate::error::Error::Encoding(format!("borsh TransferArgs serialize: {e}"))
    })?;
    data.extend_from_slice(&serialized);

    let mut metas = vec![
        AccountMeta::new(accounts.payer, true),
        AccountMeta::new(accounts.pool_config, false),
        AccountMeta::new(accounts.merkle_tree, false),
        AccountMeta::new_readonly(accounts.system_program, false),
    ];
    for nf in &accounts.nullifiers {
        metas.push(AccountMeta::new(*nf, false));
    }

    Ok(RawInstruction {
        program_id: *program_id,
        accounts: metas,
        data,
    })
}

/// Extra fields a withdraw needs beyond the [`ProofBundle`] — the
/// clear-text settlement parameters and the second-input / padding /
/// memo bindings that the on-chain `WithdrawArgs` carries.
#[derive(Debug, Clone)]
pub struct WithdrawParams {
    /// Gross amount leaving the pool (clear-text u64). The builder derives
    /// `public_amount = encode(+amount)` from this to match the on-chain
    /// C1 recompute exactly (withdraw = POSITIVE public_amount).
    pub amount: u64,
    /// Relayer-fee portion of `amount` (paid to the broadcasting relayer).
    pub relayer_fee: u64,
    /// First (real) input nullifier — gets a `NullifierAccount` PDA.
    pub nullifier: [u8; 32],
    /// Change-note commitment queued back into the tree.
    pub change_commitment: [u8; 32],
    /// Second output slot (padding for the shared 2-out vk shape).
    pub padding_commitment: [u8; 32],
    /// Second input nullifier (real or dummy) — C3: always gets a PDA.
    pub input_nullifier_1: [u8; 32],
    /// Per-output memo commitments folded into `ext_data_hash` (C2).
    pub memo_commitments: Vec<[u8; 32]>,
}

/// Build `withdraw(args: WithdrawArgs)`.
///
/// Releases `params.amount` of `mint` from `escrow_ata` to `user_ata`.
///
/// `public_amount` is DERIVED here as `encode_public_amount(+amount)`,
/// matching the on-chain C1 binding (the program recomputes the same
/// value and rejects a mismatch). Withdraw spends an input note, so by
/// `sum(in) === sum(out) + publicAmount` the public amount is POSITIVE
/// `+amount` (deposit, by contrast, is `r - amount`). `amount` is therefore
/// the sole source of the settlement value — the bundle's `public_amount`
/// is ignored to avoid drift. `asset_id`, `root`, and the proof come from
/// `proof`.
pub fn build_withdraw_ix(
    program_id: &[u8; 32],
    accounts: &PoolAccounts,
    params: &WithdrawParams,
    proof: &ProofBundle,
) -> Result<RawInstruction> {
    let pi = &proof.public_inputs;

    let args = WithdrawArgs {
        proof_a: proof.proof.a,
        proof_b: proof.proof.b,
        proof_c: proof.proof.c,
        root: pi.root.0,
        nullifier: params.nullifier,
        change_commitment: params.change_commitment,
        amount: params.amount,
        relayer_fee: params.relayer_fee,
        // C1: withdraw SPENDS an input note → by the conservation equation
        // `sum(in) === sum(out) + publicAmount`, the public amount is the
        // POSITIVE gross amount. Must equal the on-chain
        // `encode_public_amount(amount as i128)`.
        public_amount: encode_public_amount(params.amount as i128),
        asset_id: pi.asset_id.0,
        ext_data_hash: pi.ext_data_hash,
        padding_commitment: params.padding_commitment,
        input_nullifier_1: params.input_nullifier_1,
        memo_commitments: params.memo_commitments.clone(),
    };

    let mut data = Vec::new();
    data.extend_from_slice(&discriminator("withdraw"));
    let serialized = borsh::to_vec(&args).map_err(|e| {
        crate::error::Error::Encoding(format!("borsh WithdrawArgs serialize: {e}"))
    })?;
    data.extend_from_slice(&serialized);

    let mut metas = vec![
        AccountMeta::new(accounts.payer, true),
        AccountMeta::new(accounts.pool_config, false),
        AccountMeta::new(accounts.merkle_tree, false),
        AccountMeta::new(accounts.escrow_ata, false),
        AccountMeta::new(accounts.user_ata, false),
        AccountMeta::new_readonly(accounts.mint, false),
        AccountMeta::new_readonly(accounts.token_program, false),
        AccountMeta::new_readonly(accounts.system_program, false),
    ];
    for nf in &accounts.nullifiers {
        metas.push(AccountMeta::new(*nf, false));
    }

    Ok(RawInstruction {
        program_id: *program_id,
        accounts: metas,
        data,
    })
}

/// Collect an iterator into exactly `[T; 2]`, erroring if the count is
/// anything other than 2 (the 2-in/2-out circuit shape).
fn exactly_two<T: Copy + Default>(
    iter: impl Iterator<Item = T>,
    what: &str,
) -> Result<[T; 2]> {
    let v: Vec<T> = iter.collect();
    if v.len() != 2 {
        return Err(crate::error::Error::Encoding(format!(
            "{what}: expected exactly 2 entries, got {}",
            v.len()
        )));
    }
    Ok([v[0], v[1]])
}

#[cfg(test)]
mod tests {
    use super::*;
    use said_shielded_pool_types::{AssetId, Commitment, Groth16Proof, MerkleRoot, PublicInputs};

    /// Bundle with the 2-in/2-out shape the transfer/withdraw circuits use.
    fn dummy_bundle() -> ProofBundle {
        ProofBundle {
            proof: Groth16Proof {
                a: [1u8; 64],
                b: [2u8; 128],
                c: [3u8; 64],
            },
            public_inputs: PublicInputs {
                root: MerkleRoot([4u8; 32]),
                input_nullifiers: vec![Nullifier([5u8; 32]), Nullifier([55u8; 32])],
                output_commitments: vec![Commitment([6u8; 32]), Commitment([7u8; 32])],
                public_amount: -500,
                asset_id: AssetId([8u8; 32]),
                ext_data_hash: [9u8; 32],
            },
        }
    }

    fn dummy_accounts() -> PoolAccounts {
        PoolAccounts {
            payer: [10u8; 32],
            pool_config: [11u8; 32],
            merkle_tree: [12u8; 32],
            mint: [13u8; 32],
            escrow_ata: [14u8; 32],
            user_ata: [15u8; 32],
            token_program: [16u8; 32],
            system_program: [0u8; 32],
            nullifiers: vec![[17u8; 32]],
        }
    }

    fn dummy_deposit_accounts() -> DepositAccounts {
        DepositAccounts {
            depositor: [10u8; 32],
            pool_config: [11u8; 32],
            verifier_key: [19u8; 32],
            mint: [13u8; 32],
            merkle_tree: [12u8; 32],
            // **C-NEW-2**: two init'd nullifier PDAs.
            nullifier_0: [20u8; 32],
            nullifier_1: [21u8; 32],
            depositor_token_account: [15u8; 32],
            escrow_ata: [14u8; 32],
            commitment_record: [18u8; 32],
            token_program: [16u8; 32],
            system_program: [0u8; 32],
        }
    }

    /// A deposit-shaped bundle: 2 dummy input nullifiers, real output in slot
    /// 0, dummy output in slot 1, negative (deposit-sign) public_amount.
    /// Mirrors `circuits/tools/build_deposit_input.js`.
    fn dummy_deposit_bundle(real_output: [u8; 32]) -> ProofBundle {
        ProofBundle {
            proof: Groth16Proof {
                a: [1u8; 64],
                b: [2u8; 128],
                c: [3u8; 64],
            },
            public_inputs: PublicInputs {
                // For a pure deposit both inputs are dummies; root is
                // irrelevant in-circuit (membership skipped). Any value.
                root: MerkleRoot([0u8; 32]),
                input_nullifiers: vec![Nullifier([5u8; 32]), Nullifier([55u8; 32])],
                // Slot 0 = REAL deposit output; slot 1 = dummy output.
                output_commitments: vec![Commitment(real_output), Commitment([0u8; 32])],
                // Deposit sign is NEGATIVE (this field is ignored by the
                // builder, which derives it from `amount`).
                public_amount: -1000,
                asset_id: AssetId([8u8; 32]),
                ext_data_hash: [9u8; 32],
            },
        }
    }

    fn dummy_withdraw_params() -> WithdrawParams {
        WithdrawParams {
            amount: 999,
            relayer_fee: 7,
            nullifier: [5u8; 32],
            change_commitment: [6u8; 32],
            padding_commitment: [7u8; 32],
            input_nullifier_1: [55u8; 32],
            memo_commitments: vec![[21u8; 32], [22u8; 32]],
        }
    }

    #[test]
    fn deposit_ix_builds() {
        let pid = [0u8; 32];
        let real_output = [0xCDu8; 32];
        let ix = build_deposit_ix(
            &pid,
            &dummy_deposit_accounts(),
            &dummy_deposit_bundle(real_output),
            1_000,
            vec![],
        )
        .unwrap();
        assert_eq!(&ix.data[..8], &discriminator("deposit"));
        // 12 accounts now: verifier_key (C-NEW-1) + two nullifier PDAs
        // (C-NEW-2) added on top of the original 9.
        assert_eq!(ix.accounts.len(), 12);
        // The 3rd account meta is the verifier_key (proof-gated).
        assert_eq!(ix.accounts[2].pubkey, [19u8; 32]);
        // **C-NEW-2**: the two nullifier PDAs sit right after merkle_tree
        // (index 4), at indices 5 and 6, and are writable (init'd).
        assert_eq!(ix.accounts[5].pubkey, [20u8; 32]);
        assert_eq!(ix.accounts[6].pubkey, [21u8; 32]);
        assert!(ix.accounts[5].is_writable);
        assert!(ix.accounts[6].is_writable);
    }

    /// **C-NEW-1 regression — the queued commitment is bound to the proof's
    /// real output, and the public_amount carries the DEPOSIT (negative)
    /// sign.** Decode the serialized `DepositArgs` and assert both.
    #[test]
    fn deposit_binds_commitment_to_real_output_and_negative_sign() {
        let pid = [0u8; 32];
        let real_output = [0xABu8; 32];
        let ix = build_deposit_ix(
            &pid,
            &dummy_deposit_accounts(),
            &dummy_deposit_bundle(real_output),
            1_000,
            vec![],
        )
        .unwrap();
        let decoded = DepositArgs::try_from_slice(&ix.data[8..]).expect("decode DepositArgs");

        // The queued commitment MUST equal output_commitment_0 (the proof's
        // real output) — this is the load-bearing C-NEW-1 bind. The on-chain
        // handler rejects `commitment != output_commitment_0`.
        assert_eq!(decoded.commitment, real_output);
        assert_eq!(decoded.output_commitment_0, real_output);

        // DEPOSIT sign is NEGATIVE: public_amount == encode_public_amount(-amount).
        assert_eq!(decoded.amount, 1_000);
        assert_eq!(
            decoded.public_amount,
            encode_public_amount(-(1_000i128)),
            "deposit public_amount must be the NEGATIVE (r - amount) encoding"
        );
        // Sanity: it is NOT the positive (withdraw) encoding.
        assert_ne!(decoded.public_amount, encode_public_amount(1_000i128));
    }

    /// The builder always sets `commitment == output_commitment_0`, so a
    /// caller cannot accidentally queue a commitment that differs from the
    /// proven output. (The on-chain handler is the authoritative guard, but
    /// the SDK never even constructs a mismatching bundle.)
    #[test]
    fn deposit_commitment_never_diverges_from_proof_output() {
        let pid = [0u8; 32];
        for real in [[1u8; 32], [0x7fu8; 32], [0xEEu8; 32]] {
            let ix = build_deposit_ix(
                &pid,
                &dummy_deposit_accounts(),
                &dummy_deposit_bundle(real),
                42,
                vec![],
            )
            .unwrap();
            let decoded = DepositArgs::try_from_slice(&ix.data[8..]).unwrap();
            assert_eq!(decoded.commitment, decoded.output_commitment_0);
            assert_eq!(decoded.commitment, real);
        }
    }

    #[test]
    fn deposit_rejects_wrong_output_count() {
        let pid = [0u8; 32];
        let mut bundle = dummy_deposit_bundle([0xCDu8; 32]);
        bundle.public_inputs.output_commitments = vec![Commitment([1u8; 32])]; // only 1
        let err = build_deposit_ix(&pid, &dummy_deposit_accounts(), &bundle, 1_000, vec![])
            .unwrap_err();
        assert!(matches!(err, crate::error::Error::Encoding(_)));
    }

    #[test]
    fn transfer_ix_builds() {
        let pid = [0u8; 32];
        let ix =
            build_transfer_ix(&pid, &dummy_accounts(), &dummy_bundle(), vec![[3u8; 32]]).unwrap();
        assert_eq!(&ix.data[..8], &discriminator("transfer"));
    }

    #[test]
    fn transfer_rejects_wrong_input_count() {
        let pid = [0u8; 32];
        let mut bundle = dummy_bundle();
        bundle.public_inputs.input_nullifiers = vec![Nullifier([5u8; 32])]; // only 1
        let err = build_transfer_ix(&pid, &dummy_accounts(), &bundle, vec![]).unwrap_err();
        assert!(matches!(err, crate::error::Error::Encoding(_)));
    }

    #[test]
    fn withdraw_ix_builds() {
        let pid = [0u8; 32];
        let ix =
            build_withdraw_ix(&pid, &dummy_accounts(), &dummy_withdraw_params(), &dummy_bundle())
                .unwrap();
        assert_eq!(&ix.data[..8], &discriminator("withdraw"));
    }

    // =========================================================================
    // CRITICAL round-trip guards (layout regression detectors).
    //
    // These mirror the EXACT on-chain field order. If `WithdrawArgs` /
    // `TransferArgs` here ever drift from the program's structs, these
    // hand-written byte-offset assertions (or the borsh re-deserialize)
    // will fail. They are the proof that the builders emit bytes the
    // program will parse field-for-field.
    // =========================================================================

    #[test]
    fn withdraw_args_round_trip() {
        let pid = [0u8; 32];
        let params = dummy_withdraw_params();
        let bundle = dummy_bundle();
        let ix = build_withdraw_ix(&pid, &dummy_accounts(), &params, &bundle).unwrap();

        // Strip the 8-byte Anchor discriminator and borsh-deserialize back
        // into the mirror struct.
        let decoded = WithdrawArgs::try_from_slice(&ix.data[8..])
            .expect("WithdrawArgs must borsh-deserialize from the emitted bytes");

        // Every field must round-trip, and the value-bearing ones must
        // equal what we asked for.
        assert_eq!(decoded.proof_a, bundle.proof.a);
        assert_eq!(decoded.proof_b, bundle.proof.b);
        assert_eq!(decoded.proof_c, bundle.proof.c);
        assert_eq!(decoded.root, bundle.public_inputs.root.0);
        assert_eq!(decoded.nullifier, params.nullifier);
        assert_eq!(decoded.change_commitment, params.change_commitment);
        assert_eq!(decoded.amount, params.amount);
        assert_eq!(decoded.relayer_fee, params.relayer_fee);
        // public_amount is the derived POSITIVE encoding of `amount` (C1:
        // withdraw spends an input note → publicAmount = +amount).
        assert_eq!(
            decoded.public_amount,
            encode_public_amount(params.amount as i128)
        );
        assert_eq!(decoded.asset_id, bundle.public_inputs.asset_id.0);
        assert_eq!(decoded.ext_data_hash, bundle.public_inputs.ext_data_hash);
        assert_eq!(decoded.padding_commitment, params.padding_commitment);
        assert_eq!(decoded.input_nullifier_1, params.input_nullifier_1);
        assert_eq!(decoded.memo_commitments, params.memo_commitments);

        // Byte-exact total length: disc(8) + 64+128+64 + 32*5 (root,
        // nullifier, change_commitment) ... compute from the struct.
        let reserialized = borsh::to_vec(&decoded).unwrap();
        assert_eq!(&ix.data[8..], reserialized.as_slice());
    }

    #[test]
    fn withdraw_args_exact_byte_offsets() {
        // Lock the on-chain field ORDER via explicit offsets. This catches
        // a re-ordering even if all fields happen to round-trip.
        let pid = [0u8; 32];
        let params = dummy_withdraw_params();
        let ix = build_withdraw_ix(&pid, &dummy_accounts(), &params, &dummy_bundle()).unwrap();
        let body = &ix.data[8..]; // after discriminator

        let mut off = 0usize;
        assert_eq!(&body[off..off + 64], &[1u8; 64]); // proof_a
        off += 64;
        assert_eq!(&body[off..off + 128], &[2u8; 128]); // proof_b
        off += 128;
        assert_eq!(&body[off..off + 64], &[3u8; 64]); // proof_c
        off += 64;
        assert_eq!(&body[off..off + 32], &[4u8; 32]); // root
        off += 32;
        assert_eq!(&body[off..off + 32], &params.nullifier); // nullifier
        off += 32;
        assert_eq!(&body[off..off + 32], &params.change_commitment); // change_commitment
        off += 32;
        assert_eq!(&body[off..off + 8], &params.amount.to_le_bytes()); // amount
        off += 8;
        assert_eq!(&body[off..off + 8], &params.relayer_fee.to_le_bytes()); // relayer_fee
        off += 8;
        assert_eq!(
            &body[off..off + 32],
            &encode_public_amount(params.amount as i128)
        ); // public_amount (withdraw = POSITIVE +amount)
        off += 32;
        assert_eq!(&body[off..off + 32], &[8u8; 32]); // asset_id
        off += 32;
        assert_eq!(&body[off..off + 32], &[9u8; 32]); // ext_data_hash
        off += 32;
        assert_eq!(&body[off..off + 32], &params.padding_commitment); // _padding_commitment
        off += 32;
        assert_eq!(&body[off..off + 32], &params.input_nullifier_1); // input_nullifier_1
        off += 32;
        // memo_commitments: u32 LE len, then entries
        assert_eq!(
            &body[off..off + 4],
            &(params.memo_commitments.len() as u32).to_le_bytes()
        );
        off += 4;
        for m in &params.memo_commitments {
            assert_eq!(&body[off..off + 32], m);
            off += 32;
        }
        assert_eq!(off, body.len(), "no trailing/garbage bytes");
    }

    #[test]
    fn transfer_args_round_trip() {
        let pid = [0u8; 32];
        let bundle = dummy_bundle();
        let memos = vec![[31u8; 32], [32u8; 32]];
        let ix = build_transfer_ix(&pid, &dummy_accounts(), &bundle, memos.clone()).unwrap();

        let decoded = TransferArgs::try_from_slice(&ix.data[8..])
            .expect("TransferArgs must borsh-deserialize from the emitted bytes");

        assert_eq!(decoded.proof_a, bundle.proof.a);
        assert_eq!(decoded.proof_b, bundle.proof.b);
        assert_eq!(decoded.proof_c, bundle.proof.c);
        assert_eq!(decoded.root, bundle.public_inputs.root.0);
        assert_eq!(
            decoded.input_nullifiers,
            [
                bundle.public_inputs.input_nullifiers[0].0,
                bundle.public_inputs.input_nullifiers[1].0
            ]
        );
        assert_eq!(
            decoded.output_commitments,
            [
                bundle.public_inputs.output_commitments[0].0,
                bundle.public_inputs.output_commitments[1].0
            ]
        );
        // Transfer forces public_amount = 0.
        assert_eq!(decoded.public_amount, [0u8; 32]);
        assert_eq!(decoded.asset_id, bundle.public_inputs.asset_id.0);
        assert_eq!(decoded.ext_data_hash, bundle.public_inputs.ext_data_hash);
        assert_eq!(decoded.memo_commitments, memos);

        let reserialized = borsh::to_vec(&decoded).unwrap();
        assert_eq!(&ix.data[8..], reserialized.as_slice());
    }

    #[test]
    fn deposit_args_round_trip() {
        let pid = [0u8; 32];
        let real_output = [0x5Au8; 32];
        let bundle = dummy_deposit_bundle(real_output);
        let memos = vec![[31u8; 32]];
        let ix = build_deposit_ix(&pid, &dummy_deposit_accounts(), &bundle, 1_000, memos.clone())
            .unwrap();

        let decoded = DepositArgs::try_from_slice(&ix.data[8..])
            .expect("DepositArgs must borsh-deserialize from the emitted bytes");

        assert_eq!(decoded.proof_a, bundle.proof.a);
        assert_eq!(decoded.proof_b, bundle.proof.b);
        assert_eq!(decoded.proof_c, bundle.proof.c);
        assert_eq!(decoded.root, bundle.public_inputs.root.0);
        assert_eq!(decoded.input_nullifier_0, bundle.public_inputs.input_nullifiers[0].0);
        assert_eq!(decoded.input_nullifier_1, bundle.public_inputs.input_nullifiers[1].0);
        assert_eq!(decoded.output_commitment_0, real_output);
        assert_eq!(decoded.output_commitment_1, bundle.public_inputs.output_commitments[1].0);
        // Deposit: public_amount is the NEGATIVE encoding of amount.
        assert_eq!(decoded.public_amount, encode_public_amount(-(1_000i128)));
        assert_eq!(decoded.asset_id, bundle.public_inputs.asset_id.0);
        assert_eq!(decoded.ext_data_hash, bundle.public_inputs.ext_data_hash);
        assert_eq!(decoded.amount, 1_000);
        // Load-bearing: queued commitment == proof's real output.
        assert_eq!(decoded.commitment, real_output);
        assert_eq!(decoded.memo_commitments, memos);

        let reserialized = borsh::to_vec(&decoded).unwrap();
        assert_eq!(&ix.data[8..], reserialized.as_slice());
    }

    #[test]
    fn transfer_args_exact_byte_offsets() {
        let pid = [0u8; 32];
        let memos = vec![[31u8; 32]];
        let ix = build_transfer_ix(&pid, &dummy_accounts(), &dummy_bundle(), memos.clone()).unwrap();
        let body = &ix.data[8..];

        let mut off = 0usize;
        assert_eq!(&body[off..off + 64], &[1u8; 64]); // proof_a
        off += 64;
        assert_eq!(&body[off..off + 128], &[2u8; 128]); // proof_b
        off += 128;
        assert_eq!(&body[off..off + 64], &[3u8; 64]); // proof_c
        off += 64;
        assert_eq!(&body[off..off + 32], &[4u8; 32]); // root
        off += 32;
        assert_eq!(&body[off..off + 32], &[5u8; 32]); // input_nullifiers[0]
        off += 32;
        assert_eq!(&body[off..off + 32], &[55u8; 32]); // input_nullifiers[1]
        off += 32;
        assert_eq!(&body[off..off + 32], &[6u8; 32]); // output_commitments[0]
        off += 32;
        assert_eq!(&body[off..off + 32], &[7u8; 32]); // output_commitments[1]
        off += 32;
        assert_eq!(&body[off..off + 32], &[0u8; 32]); // public_amount (zero)
        off += 32;
        assert_eq!(&body[off..off + 32], &[8u8; 32]); // asset_id
        off += 32;
        assert_eq!(&body[off..off + 32], &[9u8; 32]); // ext_data_hash
        off += 32;
        assert_eq!(&body[off..off + 4], &(memos.len() as u32).to_le_bytes()); // memo len
        off += 4;
        for m in &memos {
            assert_eq!(&body[off..off + 32], m);
            off += 32;
        }
        assert_eq!(off, body.len(), "no trailing/garbage bytes");
    }

    #[test]
    fn encode_public_amount_positive() {
        let v = encode_public_amount(123);
        let mut expected = [0u8; 32];
        expected[30] = 0;
        expected[31] = 123;
        // 123 fits in one byte, top 31 bytes are zero.
        assert_eq!(v[31], 123);
        for b in &v[..31] {
            assert_eq!(*b, 0);
        }
        let _ = expected;
    }

    #[test]
    fn encode_public_amount_negative_wraps_into_field() {
        // -1 should encode as r - 1.
        let v = encode_public_amount(-1);
        let mut expected = BN254_SCALAR_FIELD_BE;
        // subtract 1
        let mut i = 31;
        loop {
            if expected[i] > 0 {
                expected[i] -= 1;
                break;
            }
            expected[i] = 0xff;
            i -= 1;
        }
        assert_eq!(v, expected);
    }

    /// **C1 regression — pins the sign convention to the circuit's value-
    /// conservation equation, NOT to self-consistency of the encoder.**
    ///
    /// This is the test that would have caught the inverted C1 binding.
    /// It decodes the encoded `public_amount` back to a signed i128 (the
    /// inverse of `encode_public_amount`) and checks the conservation law
    /// `sum(inputs) === sum(outputs) + publicAmount` holds for the canonical
    /// deposit and withdraw shapes:
    ///   * DEPOSIT of A: inputs = 0, outputs = A → publicAmount must = -A,
    ///     i.e. `encode_public_amount(-A)`.
    ///   * WITHDRAW of A: inputs = A, outputs = 0 → publicAmount must = +A,
    ///     i.e. `encode_public_amount(+A)`.
    /// If anyone re-inverts the sign, decode() yields the wrong value and the
    /// conservation assertion fails.
    #[test]
    fn public_amount_sign_satisfies_conservation_equation() {
        // Decode a BN254 field element (big-endian) back to a signed i128,
        // treating values in the top half of the field (> r/2) as negative.
        // Mirrors the circuit's signed-amount interpretation.
        fn decode_public_amount(fe: &[u8; 32]) -> i128 {
            // Is fe >= r/2 ? If so it's the field-negation of a positive
            // magnitude (a "negative" public amount). Compute r - fe as the
            // magnitude in that case.
            // r/2 (big-endian): floor(r/2).
            let r = num_bigint_lite_cmp(&BN254_SCALAR_FIELD_BE);
            let x = num_bigint_lite_cmp(fe);
            let half = &r >> 1;
            if x <= half {
                // Positive — fits in i128 for our test magnitudes.
                biguint_to_i128(&x)
            } else {
                // Negative: value = -(r - x).
                let mag = &r - &x;
                -biguint_to_i128(&mag)
            }
        }

        // Minimal big-endian -> u128/i128 helpers (test-only; magnitudes are
        // small). We use the std `u128`/`i128` since all test amounts < 2^64.
        fn num_bigint_lite_cmp(be: &[u8; 32]) -> BigUintLite {
            BigUintLite(be.to_vec())
        }
        fn biguint_to_i128(x: &BigUintLite) -> i128 {
            // Take the low 16 bytes (big-endian) — sufficient for test
            // magnitudes which all fit in u64.
            let bytes = &x.0;
            let mut buf = [0u8; 16];
            let start = bytes.len().saturating_sub(16);
            let tail = &bytes[start..];
            buf[16 - tail.len()..].copy_from_slice(tail);
            u128::from_be_bytes(buf) as i128
        }

        for a in [1u64, 2, 1000, u32::MAX as u64, u64::MAX] {
            let a_i = a as i128;

            // WITHDRAW: inputs = A, outputs = 0.
            let withdraw_pa = encode_public_amount(a_i); // builder's choice
            let decoded_w = decode_public_amount(&withdraw_pa);
            // sum(in) === sum(out) + publicAmount  ->  A === 0 + decoded
            assert_eq!(
                a_i,
                0 + decoded_w,
                "withdraw conservation broken for amount {a}: encode_public_amount(+A) \
                 must decode to +A so that sum(in)=A === sum(out)=0 + publicAmount"
            );

            // DEPOSIT: inputs = 0, outputs = A.
            let deposit_pa = encode_public_amount(-a_i);
            let decoded_d = decode_public_amount(&deposit_pa);
            // sum(in) === sum(out) + publicAmount  ->  0 === A + decoded
            assert_eq!(
                0,
                a_i + decoded_d,
                "deposit conservation broken for amount {a}: encode_public_amount(-A) \
                 must decode to -A so that sum(in)=0 === sum(out)=A + publicAmount"
            );

            // TRANSFER: no net flow.
            let transfer_pa = encode_public_amount(0);
            assert_eq!(decode_public_amount(&transfer_pa), 0);
        }
    }

    /// Test-only big-endian unsigned bignum supporting `>>1` and subtraction
    /// of two equal-length values — just enough for the conservation test's
    /// `r/2` and `r - x` computations without pulling in a bignum dep.
    #[derive(Clone)]
    struct BigUintLite(Vec<u8>);

    impl PartialEq for BigUintLite {
        fn eq(&self, other: &Self) -> bool {
            self.cmp_be(other) == std::cmp::Ordering::Equal
        }
    }
    impl PartialOrd for BigUintLite {
        fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
            Some(self.cmp_be(other))
        }
    }
    impl BigUintLite {
        fn cmp_be(&self, other: &Self) -> std::cmp::Ordering {
            // Both are 32-byte big-endian here.
            self.0.cmp(&other.0)
        }
    }
    impl std::ops::Shr<u32> for &BigUintLite {
        type Output = BigUintLite;
        fn shr(self, n: u32) -> BigUintLite {
            assert_eq!(n, 1, "test helper only supports >>1");
            let mut out = vec![0u8; self.0.len()];
            let mut carry = 0u8;
            for (i, &b) in self.0.iter().enumerate() {
                out[i] = (b >> 1) | (carry << 7);
                carry = b & 1;
            }
            BigUintLite(out)
        }
    }
    impl std::ops::Sub for &BigUintLite {
        type Output = BigUintLite;
        fn sub(self, rhs: &BigUintLite) -> BigUintLite {
            // a - b, big-endian, assume a >= b, equal length.
            let a = &self.0;
            let b = &rhs.0;
            assert_eq!(a.len(), b.len());
            let mut out = vec![0u8; a.len()];
            let mut borrow: i16 = 0;
            for i in (0..a.len()).rev() {
                let v = a[i] as i16 - b[i] as i16 - borrow;
                if v < 0 {
                    out[i] = (v + 256) as u8;
                    borrow = 1;
                } else {
                    out[i] = v as u8;
                    borrow = 0;
                }
            }
            BigUintLite(out)
        }
    }

    #[test]
    fn ext_data_hash_deterministic() {
        let ed = ExtData {
            recipient: [1u8; 32],
            mint: [2u8; 32],
            fee: 100,
            relayer_fee: 50,
            memo_commitments: vec![[3u8; 32]],
        };
        let a = compute_ext_data_hash(&ed);
        let b = compute_ext_data_hash(&ed);
        assert_eq!(a, b);
    }

    #[test]
    fn pda_seeds_have_expected_shapes() {
        assert_eq!(pool_config_seeds(), vec![b"pool".to_vec()]);
        let ts = merkle_tree_seeds(7);
        assert_eq!(ts[0], b"tree");
        assert_eq!(ts[1], 7u64.to_le_bytes().to_vec());
        let ns = nullifier_seeds(&[9u8; 32], &Nullifier([1u8; 32]));
        assert_eq!(ns[0], b"nullifier");
        assert_eq!(ns[1], vec![9u8; 32]);
        assert_eq!(ns[2], vec![1u8; 32]);
        let es = escrow_seeds(&[9u8; 32]);
        assert_eq!(es[0], b"escrow");
        assert_eq!(es[1], vec![9u8; 32]);
    }
}
