# SAID Shielded Pool — Governance Model

Stream 4 of the Phase 45 production-hardening pass. Documents the
authority hierarchy, timelock semantics, vk-rotation flow, multisig
integration plan, and forester-set rotation procedure.

---

## 1. Authority hierarchy

```
                      ┌───────────────────────────────┐
                      │  PROGRAM upgrade authority    │
                      │  (BPF Loader Upgradeable)     │
                      │  → Squads multisig (planned)  │
                      └───────────────┬───────────────┘
                                      │ owns binary
                                      ▼
       ┌──────────────────────────────────────────────────────┐
       │  PoolConfig (PDA, seeds=[b"pool_config"])             │
       │                                                       │
       │   admin            ← all timelocked proposals          │
       │   pause_authority  ← incident-response pause           │
       │   forester_set[4]  ← signers for update_root_via_proof │
       │   pending_admin / pending_vk_hash + ETAs               │
       └──────────────────────────────────────────────────────┘
```

### `admin`
- Proposes admin-change, vk-rotation.
- Executes immediate ops: `set_fee_bps`, `set_forester_set`,
  `set_pause_authority`, `cancel_proposal`, `migrate_config`,
  `attest_evidence`.
- Can also flip `paused`.

### `pause_authority`
- **Only** rights: `set_paused(true/false)`.
- Designed to be a hot key (e.g. on a paging server) for incident
  response. If compromised, attacker can pause the pool — denial-of-
  service, but no value theft.
- Defaults to `admin` on `init_pool`. Rotate via `set_pause_authority`
  (immediate, admin-signed).

### `forester_set: [Pubkey; 4]`
- Up to 4 authorized signers for `update_root_via_proof`.
- Slots set to `Pubkey::default()` are unused.
- If **all** slots are default (fresh init / bootstrap), the program
  falls back to admin-signed for `update_root_via_proof`. This lets
  operators bring up the pool before the forester infra is online.
- Rotated immediately by admin via `set_forester_set`.

---

## 2. Timelock semantics

**Default**: `timelock_secs = 48 * 60 * 60 = 172800` (48h). Configurable
at `init_pool`; not currently mutable post-init (TODO if needed: add
`set_timelock_secs` admin ix).

### Two-phase pattern

Every "sensitive" change goes through `propose` → wait `timelock_secs`
→ `accept`:

| Change           | propose ix                  | accept ix                |
|------------------|-----------------------------|--------------------------|
| Admin rotation   | `propose_admin_change`      | `accept_admin_change`    |
| VK rotation      | `propose_vk_rotation`       | `accept_vk_rotation`     |

Proposal storage lives inside `PoolConfig`:

- `pending_admin: Pubkey` (default == no proposal)
- `admin_change_eta: i64` (unix_timestamp)
- `pending_vk_hash: [u8;32]` (all zeros == no proposal)
- `vk_change_eta: i64`

Only one admin proposal and one vk proposal can be in flight at a time.
Re-proposing while one is pending requires explicit `cancel_proposal`
first (clean audit log).

### Why hash-commit then bytes for VK?

- `propose_vk_rotation(new_vk_hash: [u8;32])` commits SHA-256 only.
- `accept_vk_rotation(new_vk_bytes)` validates
  `sha256(new_vk_bytes) == pending_vk_hash` and writes the bytes.

This prevents:
1. **Eleventh-hour swap**: admin can't substitute different vk bytes
   between propose and accept.
2. **Mempool griefing**: an observer who sees the hash on-chain can't
   front-run with different bytes (proof of pre-image required).

### Cancellation
`cancel_proposal(ProposalKind::AdminChange | ::VkRotation)` is admin-
signed and immediate. Clears the pending fields.

---

## 3. Pause flow (incident response)

```
[INCIDENT DETECTED]
        │
        ▼
pause_authority signs set_paused(true)
        │
        ▼
PoolConfig.paused = true
        │
        ▼ rejects deposit/transfer/withdraw/decoy_withdraw/update_root_via_proof
        │
        ▼ (investigation, maybe migrate_config or program upgrade)
        │
        ▼
admin OR pause_authority signs set_paused(false)
```

`set_paused` is **not** timelocked — by design, since the threat model
includes "active exploit in progress" where every minute matters.
Mitigation against a malicious pause_authority is the limited blast
radius: it can only DoS, never steal.

---

## 4. VK rotation flow

```
T = 0:    admin: propose_vk_rotation(sha256(new_vk_bytes))
              ↓ emits VkRotationProposed { pending_vk_hash, eta = T + 48h }
              ↓
T = 0..48h: external auditors verify new_vk_bytes off-chain against the
            commit. Light clients warn users a rotation is pending.
              ↓
T = 48h+:  admin: accept_vk_rotation(new_vk_bytes)
              ↓ program: assert sha256(new_vk_bytes) == pending_vk_hash
              ↓ writes new bytes to VerifierKey PDA
              ↓ updates pool_config.verifier_key_hash
              ↓ clears pending_vk_hash, vk_change_eta
              ↓ emits VkRotated { old_hash, new_hash }
```

If something is wrong before T=48h: `cancel_proposal(VkRotation)`.

If a vk update is **emergency-critical** (e.g. soundness bug in the
circuit): pause the pool, then do a program upgrade with the new vk
hard-coded into the binary. The vk-rotation timelock is for routine
key migration, not 0-day response.

---

## 5. Admin rotation flow

```
T = 0:    current_admin: propose_admin_change(new_admin_pubkey)
              ↓ emits AdminChangeProposed { current_admin, pending_admin, eta }
              ↓
T = 0..48h: community can fork-monitor, light clients warn
              ↓
T = 48h+:  new_admin (NOT current!) signs accept_admin_change()
              ↓ program: assert signer == pending_admin
              ↓ admin = signer, clears pending
              ↓ emits AdminChanged
```

The new_admin must sign accept (not the old) so the old admin can't
push a key the new key-holder didn't authorize.

---

## 6. Multisig integration (Squads stub)

The program treats `admin` as a single Pubkey. To use a Squads multisig
as the admin, set `admin` to the multisig's Vault PDA. The multisig
software wraps the program ix in a Squads proposal; the multisig
threshold signs; on execution, the Vault PDA signs the program ix.

Recommended setup for production:

```
                           ┌─────────────────────────────┐
                           │ Squads multisig (3-of-5)    │
                           │   members: cofounders,      │
                           │   security advisor, custody │
                           └─────────────┬───────────────┘
                                         │
                                         │ Vault PDA
                                         ▼
              ┌────────────────────────────────────────────┐
              │ PoolConfig.admin = <Squads Vault PDA>      │
              │ PoolConfig.pause_authority = <hot key>     │
              │ PoolConfig.forester_set = <forester keys>  │
              └────────────────────────────────────────────┘
```

Squads-wrapped admin ix flow:
1. Member submits a Squads proposal containing the
   `propose_admin_change` (or any admin) ix.
2. Other members approve. On threshold reach, Squads transitions to
   executable.
3. Anyone calls `squads.execute_transaction()`; Squads CPIs the
   shielded-pool ix with the Vault PDA as the `admin` signer.

Stream 4 doesn't ship code for the Squads wrapping (no Anchor-side
glue is needed — the program just sees the Vault PDA as a normal
signer Pubkey). Operator runbook in § 11 (Runbooks) below.

---

## 7. Forester rotation

`set_forester_set([Pubkey; 4])` is admin-signed and immediate. No
timelock because:
- The forester only proves correct Merkle insertion; it can't steal
  funds or grief proofs (the circuit is the proof, not the forester).
- A bad forester just fails to fold or folds wrong; the on-chain
  verifier rejects malformed proofs.
- Slow forester rotation would delay deposits behind the queue.

Operational policy: rotate every 90 days, or immediately if a forester
key is suspected compromised. Set unused slots to `Pubkey::default()`.

Update flow:
```
set_forester_set([new_k1, new_k2, new_k3, Pubkey::default()])
   ↓ emits ForesterSetUpdated { new_set: [k1, k2, k3, 0] }
```

---

## 8. Migration ix (`migrate_config`)

Used once after the V1 → V2 redeploy. Reallocates `PoolConfig` and one
`MerkleTree` at a time, zero-initializes V2 fields, and sets the
`_reserved[0]` migrated flag.

Operator MUST pause the pool before calling — see § 11.C (Runbooks)
below.

---

## 9. Evidence attestation (`attest_evidence`)

Admin-only ring buffer of off-chain audit-evidence hashes
(`EvidenceLog` PDA, capacity 16). Used by Stream 10 to commit
proof-bundle / indexer-state hashes on-chain so external auditors can
retroactively verify which artifact was the canonical one at slot X.

Not on the critical-path of any user ix — purely audit/transparency
infrastructure.

---

## 10. Field reference

```rust
pub struct PoolConfig {
    pub admin: Pubkey,                       // V1 + V2
    pub verifier_key_hash: [u8; 32],         // V1 + V2
    pub verifier_key: Pubkey,                // V1 + V2
    pub paused: bool,                        // V1 + V2
    pub fee_bps: u16,                        // V1 + V2
    pub bump: u8,                            // V1 + V2

    // V2 governance fields
    pub pause_authority: Pubkey,
    pub pending_admin: Pubkey,               // default == none
    pub admin_change_eta: i64,
    pub pending_vk_hash: [u8; 32],           // [0; 32] == none
    pub vk_change_eta: i64,
    pub forester_set: [Pubkey; 4],
    pub timelock_secs: u32,                  // default 172800
    pub _reserved: [u8; 64],                 // _reserved[0] = migration flag
}
```

---

## 11. Runbooks

> Folded from `UPGRADE_RUNBOOK.md` 2026-05-24; canonical home is this section.

Operator procedures for: (A) VK rotation, (B) program binary upgrade,
(C) V1 → V2 state migration, (D) rollback, (E) incident response,
(F) Squads multisig hand-off, (G) ix-to-signer quick reference.

**Target program**: `5bmCDeaQceBpWgK8aADB4Tz4JzqZ9hkCi3qedC6oZR8A`
(devnet & mainnet).

### 11.A — VK rotation

Timelocked, two-step. Used when the prover/circuit changes but the
on-chain verifier-program binary does NOT (i.e. nPublic + groth16
shape unchanged, only the trusted-setup output is new).

#### Pre-flight
- [ ] New `verifier_key_bytes` artifact in hand, hash-pinned.
- [ ] Light-client release ready with the new hash baked in (so users
      can pin the rotation in their UI before T=48h).
- [ ] Run `sha256(new_vk_bytes)` locally and record the hex digest.

#### T = 0: propose
```bash
ts-node tooling/governance/propose-vk-rotation.ts \
  --hash <sha256-hex> \
  --keypair ~/.config/solana/admin.json
```
Observes: `VkRotationProposed { pending_vk_hash, eta }` event in tx logs.

#### T = 0..48h: monitor
- Verify `PoolConfig.pending_vk_hash == sha256(new_vk_bytes)` via RPC.
- Audit team verifies new_vk_bytes off-chain (toxic-waste check,
  ceremony attestation, etc.).
- Light clients warn end-users that a rotation is pending.

#### T = 48h+: accept
```bash
ts-node tooling/governance/accept-vk-rotation.ts \
  --bytes path/to/new_vk.bin \
  --keypair ~/.config/solana/admin.json
```
On-chain: `assert sha256(bytes) == pending_vk_hash` → writes vk →
clears pending → emits `VkRotated`.

#### Cancellation (any time before accept)
```bash
ts-node tooling/governance/cancel-proposal.ts --kind vk
```

### 11.B — Program binary upgrade

For circuit-shape changes (nPublic count, new ix), bug fixes, etc.
Requires the BPF Loader Upgradeable program-upgrade authority. Production
target: a Squads multisig owns the upgrade authority.

#### Pre-flight
- [ ] `cargo check -p said-shielded-pool --features real-verifier` clean.
- [ ] `anchor build -p said_shielded_pool` succeeds.
- [ ] Record new .so size and SHA-256 — needed for Stream 10 evidence
      gate.
- [ ] If state layout changes: write a migration ix BEFORE you redeploy
      (see § 11.C).
- [ ] If layout changes: pause the pool first.

#### Pause the pool (only if state-changing upgrade)
```bash
ts-node tooling/governance/set-paused.ts --paused true \
  --keypair ~/.config/solana/pause_authority.json
```

#### Redeploy
```bash
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd /Users/andersonobrien/Downloads/ghola
anchor build -p said_shielded_pool

# Stream 4 baseline (.so size 506_328 bytes). Verify size delta is sane.
ls -la programs/said-shielded-pool/target/deploy/said_shielded_pool.so

# Devnet:
solana program deploy programs/said-shielded-pool/target/deploy/said_shielded_pool.so \
  --program-id 5bmCDeaQceBpWgK8aADB4Tz4JzqZ9hkCi3qedC6oZR8A \
  --upgrade-authority ~/.config/solana/upgrade_authority.json \
  --keypair ~/.config/solana/id.json

# Mainnet: same but via Squads-wrapped tx.
```

#### Migrate state (if layout changed)
See § 11.C.

#### Unpause
```bash
ts-node tooling/governance/set-paused.ts --paused false \
  --keypair ~/.config/solana/pause_authority.json
```

#### Verify
- [ ] First instruction call decodes correctly (try a no-op like
      `set_fee_bps(current_value)`).
- [ ] If a migration was applied, `PoolConfig._reserved[0] ==
      MIGRATED_FLAG_VAL` (1).

### 11.C — State migration (V1 → V2)

After redeploying the V2 binary, ALL existing V1 PDAs must be
migrated before users can transact. Stream 4 V2 grows `PoolConfig`
from 108 → ~280 bytes and `MerkleTree` from 2168 → 2176 bytes.

#### Pre-flight
- [ ] Pool MUST be paused (`migrate_config` requires it).
- [ ] Admin keypair available.
- [ ] List all `MerkleTree` PDAs to migrate (one per mint).

#### Migrate
```bash
# 1. Pool config + first tree:
ts-node tooling/governance/migrate-config.ts \
  --tree <merkle_tree_pubkey_for_mint_A> \
  --keypair ~/.config/solana/admin.json

# 2. Repeat per additional tree (each call carries the pool migration
#    too — the pool-flag check makes subsequent invocations a no-op
#    for the pool, only the tree gets migrated):
ts-node tooling/governance/migrate-config.ts \
  --tree <merkle_tree_pubkey_for_mint_B> \
  --keypair ~/.config/solana/admin.json
```

Effects:
- `PoolConfig` reallocated to 8 + `INIT_SPACE` bytes; V2 fields zero-
  initialized; `pause_authority = admin`; `timelock_secs = 172800`;
  `_reserved[0] = 1`.
- `MerkleTree` reallocated by 8 bytes; trailing `root_history_idx +
  depth + bump + _pad` shifted up; `queue_tail` initialized to
  `next_index` (no pending deposits assumed at migration time —
  hence the paused requirement).

#### Post-migration sanity
- [ ] `PoolConfig.bump` unchanged.
- [ ] `PoolConfig.fee_bps` unchanged.
- [ ] `MerkleTree.next_index` unchanged.
- [ ] `MerkleTree.queue_tail == next_index`.
- [ ] `MerkleTree.depth == 26`.
- [ ] Unpause and run a smoke test (`tests/governance.ts`).

#### Idempotency
`migrate_config` rejects with `MigrationAlreadyApplied` if the
`PoolConfig._reserved[0]` flag is already set. Per-tree migration is
idempotent on size (no-op if already V2).

### 11.D — Rollback path

Solana program upgrades are atomic; there is no in-place "undo".
Rollback options:

#### Option D1 — Redeploy previous binary
- Keep the previous .so artifact and its SHA-256 logged.
- If V2 has a bug, redeploy V1 binary via the upgrade authority.
- **Caveat**: any state migrations done under V2 (e.g. enlarged
  PoolConfig) are NOT undone. V1 binary will fail to deserialize the
  larger PoolConfig.
- **Workaround**: V1 binary's `PoolConfig` deserializer reads only the
  first 108 bytes — Anchor's borsh deser ignores trailing bytes IFF
  the V1 struct didn't use a fixed-len trailing field. **Verify this
  before rolling back**: V1's last field was `bump: u8` with no
  trailing — borsh deser of `Account<V1>` from a V2-shaped buffer
  reads 108 bytes and ignores the rest. Confirmed safe.

#### Option D2 — Pause + freeze
- If a bug surfaces but isn't actively-exploited: pause, wait,
  develop a patched V2.1.
- pause_authority can pause instantly — no timelock.

#### Option D3 — Drain via admin-only ix (NOT YET BUILT)
- TODO Phase 46: `emergency_drain(recipient)` admin ix to sweep escrow
  to a multisig if the pool is irrecoverable. Should be timelocked
  (long — 14d). Not in Stream 4 scope.

### 11.E — Incident response

#### Triage flowchart

```
[anomaly detected — bad proof accepted, double-spend, escrow drained]
        │
        ▼
 [PAUSE THE POOL] — pause_authority signs set_paused(true)
        │
        ▼
 [GATHER EVIDENCE] — pull recent tx history, decode events, hash to
                     EvidenceLog via attest_evidence
        │
        ▼
 [DECIDE]
   ├─ Bug in circuit/vk?       → VK rotation (timelocked) or program upgrade
   ├─ Bug in instruction?      → Program upgrade
   ├─ Compromised admin key?   → propose_admin_change (timelocked)
   ├─ Compromised forester?    → set_forester_set (immediate)
   ├─ Compromised pause key?   → set_pause_authority (immediate, admin)
   └─ Indeterminate?           → Stay paused, audit, then drain (D3) if needed
        │
        ▼
 [UNPAUSE] only after root cause + fix verified
```

#### Communication
- Public status page update within 30min of pause.
- Disclosure timeline target: 14d for circuit/proof bugs, immediate
  for active-exploit reports.

### 11.F — Squads multisig (production hand-off)

Once the program is mainnet-ready:
1. Transfer BPF upgrade authority to a Squads Vault PDA (3-of-5).
2. Transfer `PoolConfig.admin` to the same or a different Squads Vault.
3. Keep `pause_authority` as a single hot key on a 24/7 monitored
   server (lowest privilege, fastest response).
4. `forester_set` populated with 1-4 forester worker keys.

All admin operations now require Squads proposal → threshold approval
→ execute. Timelocks compound on top: a vk-rotation goes Squads
proposal (instant) → on-chain `propose_vk_rotation` → 48h wait →
Squads proposal for `accept_vk_rotation` → execute.

### 11.G — Quick reference — ix → required signer

| Instruction              | Signer                              | Timelock |
|--------------------------|-------------------------------------|----------|
| `init_pool`              | admin (one-time)                    | none     |
| `init_tree`              | admin                               | none     |
| `deposit`                | depositor                           | none     |
| `transfer`               | payer (any)                         | none     |
| `withdraw`               | payer (any)                         | none     |
| `decoy_withdraw`         | payer (any)                         | none     |
| `update_root_via_proof`  | member of forester_set OR admin     | none     |
| `set_paused`             | admin OR pause_authority            | none     |
| `set_fee_bps`            | admin                               | none     |
| `propose_admin_change`   | admin                               | starts   |
| `accept_admin_change`    | pending_admin                       | 48h ✓    |
| `propose_vk_rotation`    | admin                               | starts   |
| `accept_vk_rotation`     | admin                               | 48h ✓    |
| `cancel_proposal`        | admin                               | none     |
| `set_forester_set`       | admin                               | none     |
| `set_pause_authority`    | admin                               | none     |
| `migrate_config`         | admin                               | none     |
| `attest_evidence`        | admin                               | none     |
