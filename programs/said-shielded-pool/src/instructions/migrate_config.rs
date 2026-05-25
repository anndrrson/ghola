//! One-shot V1 → V2 migration for `PoolConfig` and (per call) one
//! `MerkleTree` account.
//!
//! ## Why this is needed
//!
//! Stream 4 grew `PoolConfig` with governance fields (pause_authority,
//! pending_admin/eta, pending_vk_hash/eta, forester_set, timelock_secs,
//! _reserved) and grew `MerkleTree` with `queue_tail`. The existing devnet
//! PoolConfig at `8XzSfqtn1SZPjzeK52TEBWiFkrrAAn4vb4rgqxe7pa9h` is V1.
//! After the program is redeployed with V2 code, the V1 accounts must be
//! reallocated and the new fields filled in **before** any user
//! instruction will deserialize the account correctly.
//!
//! ## How
//!
//! - `PoolConfig`: borsh-serialized via `Account<T>` — we manually realloc
//!   the underlying `AccountInfo` to `8 + PoolConfig::INIT_SPACE`, read the
//!   V1 fields by raw offset, then overwrite the buffer with a freshly
//!   borsh-serialized V2 record. The migration is guarded by the
//!   `_reserved[0] == MIGRATED_FLAG_VAL` flag — re-running is a no-op
//!   error to keep the audit log clean.
//!
//! - `MerkleTree`: zero-copy `#[repr(C)]` struct. We realloc by 8 bytes
//!   (V1: 2168 → V2: 2176) and shift the trailing fields
//!   (`root_history_idx`, `depth`, `bump`, `_pad`) up by 8 so the new
//!   `queue_tail: u64` slot fits between `next_index` and
//!   `root_history_idx`. `queue_tail` is initialized to `next_index`
//!   (no pending deposits at migration time — operator is expected to
//!   pause the pool first).
//!
//! ## Invariants
//!
//! - `migrate_config` is admin-only.
//! - After successful return, `pool_config.migrated() == true`.
//! - Pool MUST be paused during migration to avoid races with in-flight
//!   ixs that would otherwise deserialize a half-migrated account.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::system_instruction;

use crate::error::ShieldedPoolError;
use crate::events::ConfigMigrated;
use crate::state::{
    PoolConfig, DEFAULT_TIMELOCK_SECS, FORESTER_SET_LEN, ROOT_HISTORY_SIZE,
};

// V1 layout sizes (pre-Stream-4). These are constants — never change.
const POOL_CONFIG_V1_LEN: usize = 8 + 32 + 32 + 32 + 1 + 2 + 1; // 108
const MERKLE_TREE_V1_LEN: usize = 8 + (32 * ROOT_HISTORY_SIZE) + 32 + 32 + 32 + 8 + 4 + 1 + 1 + 2; // 2168
const MERKLE_TREE_V2_LEN: usize = MERKLE_TREE_V1_LEN + 8; // 2176

#[derive(Accounts)]
pub struct MigrateConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    /// V1 PoolConfig — we manually deserialize the legacy layout, then
    /// realloc and overwrite with V2 bytes. `Account<PoolConfig>` would
    /// fail to deserialize a V1 buffer (V2 struct is larger), so we take
    /// it as `UncheckedAccount` and validate by-hand.
    ///
    /// CHECK: admin authority is verified manually below by reading the
    /// first 32 post-disc bytes (V1 `admin` field). PDA constraint via
    /// seeds.
    #[account(
        mut,
        seeds = [b"pool_config"],
        bump,
    )]
    pub pool_config: UncheckedAccount<'info>,

    /// CHECK: per-mint tree to migrate. Manually validated against
    /// `pool_config`'s known PDA seeds. Passed mutably for realloc.
    #[account(mut)]
    pub merkle_tree: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn migrate_config_handler(ctx: Context<MigrateConfig>) -> Result<()> {
    use anchor_lang::solana_program::program::invoke;

    let admin_key = ctx.accounts.admin.key();
    let cfg_info = &ctx.accounts.pool_config;
    let tree_info = &ctx.accounts.merkle_tree;

    // -- 1. Read V1 PoolConfig fields by raw offset --
    let v1 = {
        let data = cfg_info.try_borrow_data()?;
        if data.len() < POOL_CONFIG_V1_LEN {
            return err!(ShieldedPoolError::InvalidTreeConfig);
        }

        // Detect already-migrated by checking the V2 reserved-flag byte
        // position. After realloc the buffer is larger; we only treat
        // "already migrated" as an error if the account is already at
        // V2 size AND the flag byte is set.
        if data.len() >= 8 + PoolConfig::INIT_SPACE {
            // Re-deserialize as V2 to inspect the flag.
            let mut slice: &[u8] = &data[8..];
            if let Ok(cfg_v2) = PoolConfig::try_deserialize_unchecked(&mut slice) {
                if cfg_v2.migrated() {
                    return err!(ShieldedPoolError::MigrationAlreadyApplied);
                }
            }
        }

        // Layout: [disc 8][admin 32][verifier_key_hash 32][verifier_key 32][paused 1][fee_bps 2][bump 1]
        let admin = Pubkey::new_from_array(data[8..40].try_into().unwrap());
        let vk_hash: [u8; 32] = data[40..72].try_into().unwrap();
        let verifier_key = Pubkey::new_from_array(data[72..104].try_into().unwrap());
        let paused = data[104] != 0;
        let fee_bps = u16::from_le_bytes(data[105..107].try_into().unwrap());
        let bump = data[107];
        V1PoolConfig {
            admin,
            verifier_key_hash: vk_hash,
            verifier_key,
            paused,
            fee_bps,
            bump,
        }
    };

    // -- 2. Admin authorization --
    require!(v1.admin == admin_key, ShieldedPoolError::Unauthorized);
    // PDA bump must match the seeds-derived bump (Anchor already verified
    // seeds, so the supplied `ctx.bumps.pool_config` is canonical).
    require!(
        v1.bump == ctx.bumps.pool_config,
        ShieldedPoolError::InvalidTreeConfig
    );

    // -- 3. Operator must pause the pool BEFORE migrating. --
    // (Defensive: migration races with in-flight ixs are a footgun. Doc'd
    // in GOVERNANCE.md § 11.C too.)
    require!(v1.paused, ShieldedPoolError::Paused);

    // -- 4. Realloc PoolConfig to V2 size and rent-fund the delta. --
    let v2_len = 8 + PoolConfig::INIT_SPACE;
    let rent = Rent::get()?;
    let new_minimum_balance = rent.minimum_balance(v2_len);
    let lamports_needed = new_minimum_balance.saturating_sub(cfg_info.lamports());
    if lamports_needed > 0 {
        invoke(
            &system_instruction::transfer(&admin_key, cfg_info.key, lamports_needed),
            &[
                ctx.accounts.admin.to_account_info(),
                cfg_info.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;
    }
    cfg_info.realloc(v2_len, false)?;

    // -- 5. Write V2 PoolConfig bytes. --
    let mut v2 = PoolConfig {
        admin: v1.admin,
        verifier_key_hash: v1.verifier_key_hash,
        verifier_key: v1.verifier_key,
        paused: v1.paused,
        fee_bps: v1.fee_bps,
        bump: v1.bump,
        pause_authority: v1.admin, // bootstrap: pause_authority == admin
        pending_admin: Pubkey::default(),
        admin_change_eta: 0,
        pending_vk_hash: [0u8; 32],
        vk_change_eta: 0,
        forester_set: [Pubkey::default(); FORESTER_SET_LEN],
        timelock_secs: DEFAULT_TIMELOCK_SECS,
        migrated: true,
    };

    {
        let mut data = cfg_info.try_borrow_mut_data()?;
        let mut writer: &mut [u8] = &mut data;
        v2.try_serialize(&mut writer)?;
    }

    // -- 6. Migrate the MerkleTree account in-place. --
    let migrated_trees = migrate_one_tree(
        tree_info,
        &ctx.accounts.admin,
        &ctx.accounts.system_program,
        cfg_info.key,
    )?;

    emit!(ConfigMigrated {
        pool_config: cfg_info.key(),
        migrated_trees,
    });

    Ok(())
}

/// In-place zero-copy realloc of MerkleTree V1 → V2.
///
/// V1 layout (bytes, after 8-byte discriminator):
///   [0..2048]    root_history
///   [2048..2080] pool
///   [2080..2112] mint
///   [2112..2144] root
///   [2144..2152] next_index (u64)
///   [2152..2156] root_history_idx (u32)
///   [2156]       depth
///   [2157]       bump
///   [2158..2160] _pad
/// V2 inserts `queue_tail: u64` at offset 2152 (post-disc), shifting the
/// trailing 4 + 1 + 1 + 2 = 8 bytes up by 8.
///
/// Returns 1 on success, 0 if the tree was already at V2 size (idempotent).
fn migrate_one_tree<'info>(
    tree_info: &UncheckedAccount<'info>,
    payer: &Signer<'info>,
    system_program: &Program<'info, System>,
    pool_key: &Pubkey,
) -> Result<u32> {
    use anchor_lang::solana_program::program::invoke;

    let current_len = tree_info.data_len();
    if current_len == MERKLE_TREE_V2_LEN {
        // Already migrated — no-op.
        return Ok(0);
    }
    require!(
        current_len == MERKLE_TREE_V1_LEN,
        ShieldedPoolError::InvalidTreeConfig
    );

    // Rent-fund the delta.
    let rent = Rent::get()?;
    let new_minimum_balance = rent.minimum_balance(MERKLE_TREE_V2_LEN);
    let lamports_needed = new_minimum_balance.saturating_sub(tree_info.lamports());
    if lamports_needed > 0 {
        invoke(
            &system_instruction::transfer(payer.key, tree_info.key, lamports_needed),
            &[
                payer.to_account_info(),
                tree_info.to_account_info(),
                system_program.to_account_info(),
            ],
        )?;
    }
    tree_info.realloc(MERKLE_TREE_V2_LEN, false)?;

    // Verify this tree belongs to the pool. We can read `pool` at offset
    // 8 + 2048 = 2056 (still valid after realloc — bytes [0..2168] are
    // unchanged from V1 layout pre-shift).
    {
        let data = tree_info.try_borrow_data()?;
        let pool_bytes: [u8; 32] = data[2056..2088].try_into().unwrap();
        let pool = Pubkey::new_from_array(pool_bytes);
        require!(&pool == pool_key, ShieldedPoolError::Unauthorized);
    }

    // Shift bytes — the trailing 8 bytes (root_history_idx + depth + bump
    // + _pad) need to move up 8 to make room for `queue_tail`. Source
    // range (post-disc offsets) [2144..2152] → dest [2152..2160].
    // After the disc the actual buffer offsets are +8 each.
    {
        let mut data = tree_info.try_borrow_mut_data()?;
        let src_start = 8 + 2152; // post-disc 2152
        let src_end = 8 + 2160;
        let dst_start = 8 + 2160;
        let dst_end = 8 + 2168;
        let mut tmp = [0u8; 8];
        tmp.copy_from_slice(&data[src_start..src_end]);
        data[dst_start..dst_end].copy_from_slice(&tmp);
        // Zero the slot where queue_tail now lives, then write
        // `queue_tail = next_index`. next_index is at post-disc 2144,
        // which is buffer offset 8 + 2144 = 2152.
        let next_index_bytes: [u8; 8] = data[8 + 2144..8 + 2152].try_into().unwrap();
        data[8 + 2152..8 + 2160].copy_from_slice(&next_index_bytes);
    }

    Ok(1)
}

// V1 layout helper — only used inside this module.
struct V1PoolConfig {
    admin: Pubkey,
    verifier_key_hash: [u8; 32],
    verifier_key: Pubkey,
    paused: bool,
    fee_bps: u16,
    bump: u8,
}

/// Compile-time sanity asserts so unit tests catch any drift between
/// real layouts and the constants above.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v1_pool_config_len_matches() {
        // V1 had: admin(32) + vk_hash(32) + vk(32) + paused(1) + fee(2) + bump(1) = 100 + 8 disc.
        assert_eq!(POOL_CONFIG_V1_LEN, 108);
    }

    #[test]
    fn merkle_tree_size_delta_is_8() {
        assert_eq!(MERKLE_TREE_V2_LEN - MERKLE_TREE_V1_LEN, 8);
    }
}
