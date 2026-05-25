/**
 * said-shielded-pool — integration test scaffold.
 *
 * These tests intentionally use a stubbed proof (all-zero bytes). Real
 * proof tests will be wired in once `crates/said-shielded-pool-prover`
 * lands and the verifying key is generated. For now they exercise the
 * account-state transitions of the program with `--features
 * !real-verifier` (default), where `groth16::verify` returns Ok(()).
 *
 * Run from the workspace root:
 *   anchor test --skip-build  (after a separate `cargo build-sbf -p said-shielded-pool`)
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, Keypair } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { assert } from "chai";

// The Anchor IDL type is generated at `target/types/said_shielded_pool`
// once `anchor build` succeeds. We import it loosely typed here so the
// test file compiles even when the IDL hasn't been regenerated.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SaidShieldedPool = any;

const POOL_PROGRAM_ID = new PublicKey(
  "ShLdPooL11111111111111111111111111111111111"
);

function poolConfigPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("pool_config")], programId);
}

function verifierKeyPda(programId: PublicKey, pool: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("verifier_key"), pool.toBuffer()],
    programId
  );
}

function merkleTreePda(
  programId: PublicKey,
  pool: PublicKey,
  mint: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("merkle_tree"), pool.toBuffer(), mint.toBuffer()],
    programId
  );
}

function nullifierPda(
  programId: PublicKey,
  mint: PublicKey,
  nullifier: Buffer
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier"), mint.toBuffer(), nullifier],
    programId
  );
}

describe("said-shielded-pool", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // The generated workspace map exposes the program by snake_case name.
  const program = anchor.workspace.SaidShieldedPool as Program<SaidShieldedPool>;

  // --- placeholder fixtures: real values get filled in once the
  //     prover crate lands. For now the verifier is stubbed Ok(()), so
  //     these zero bytes get accepted by the program and let us exercise
  //     account-state transitions.
  const zeroProofA = Buffer.alloc(64);
  const zeroProofB = Buffer.alloc(128);
  const zeroProofC = Buffer.alloc(64);
  const zeroField = Buffer.alloc(32);
  const dummyVkBytes = Buffer.alloc(256); // arbitrary stub vk blob

  let admin: Keypair;
  let pool: PublicKey;
  let vk: PublicKey;

  before(async () => {
    admin = (provider.wallet as anchor.Wallet).payer;
    [pool] = poolConfigPda(program.programId);
    [vk] = verifierKeyPda(program.programId, pool);
  });

  it("initializes the pool with admin + vk PDA", async () => {
    await program.methods
      .initPool(0, dummyVkBytes)
      .accounts({
        admin: admin.publicKey,
        poolConfig: pool,
        verifierKey: vk,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const cfg = await program.account.poolConfig.fetch(pool);
    assert.strictEqual(cfg.admin.toBase58(), admin.publicKey.toBase58());
    assert.strictEqual(cfg.paused, false);
    assert.strictEqual(cfg.feeBps, 0);
  });

  it("rejects pool re-initialization", async () => {
    let threw = false;
    try {
      await program.methods
        .initPool(0, dummyVkBytes)
        .accounts({
          admin: admin.publicKey,
          poolConfig: pool,
          verifierKey: vk,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } catch (_) {
      threw = true;
    }
    assert.ok(threw, "second init_pool should fail");
  });

  it("admin can pause + unpause", async () => {
    await program.methods
      .setPaused(true)
      .accounts({ admin: admin.publicKey, poolConfig: pool })
      .rpc();
    let cfg = await program.account.poolConfig.fetch(pool);
    assert.strictEqual(cfg.paused, true);

    await program.methods
      .setPaused(false)
      .accounts({ admin: admin.publicKey, poolConfig: pool })
      .rpc();
    cfg = await program.account.poolConfig.fetch(pool);
    assert.strictEqual(cfg.paused, false);
  });

  it("admin can update fee_bps", async () => {
    await program.methods
      .setFeeBps(30)
      .accounts({ admin: admin.publicKey, poolConfig: pool })
      .rpc();
    const cfg = await program.account.poolConfig.fetch(pool);
    assert.strictEqual(cfg.feeBps, 30);
  });

  it("rejects fee_bps > 10000", async () => {
    let threw = false;
    try {
      await program.methods
        .setFeeBps(10_001)
        .accounts({ admin: admin.publicKey, poolConfig: pool })
        .rpc();
    } catch (_) {
      threw = true;
    }
    assert.ok(threw, "fee > 100% should be rejected");
  });

  it("admin can rotate verifier key", async () => {
    const newVk = Buffer.alloc(128, 7);
    await program.methods
      .updateVerifierKey(newVk)
      .accounts({
        admin: admin.publicKey,
        poolConfig: pool,
        verifierKey: vk,
      })
      .rpc();

    const cfg = await program.account.poolConfig.fetch(pool);
    // Hash should now match SHA-256(newVk); we just check it's non-zero.
    assert.notDeepEqual(Array.from(cfg.verifierKeyHash), Array(32).fill(0));
  });

  it("rejects non-admin trying to pause", async () => {
    const stranger = Keypair.generate();
    await provider.connection.requestAirdrop(stranger.publicKey, 1e9);
    let threw = false;
    try {
      await program.methods
        .setPaused(true)
        .accounts({ admin: stranger.publicKey, poolConfig: pool })
        .signers([stranger])
        .rpc();
    } catch (_) {
      threw = true;
    }
    assert.ok(threw, "non-admin pause should fail");
  });

  // The proof-path tests below are scaffolded but require the prover
  // crate + a real verifying key, so they're skipped until Phase 38
  // turns on `--features real-verifier`. They double as documentation
  // of the expected account shape.

  it.skip("rejects malformed proof on transfer", async () => {
    // TODO(phase-38): wire prover and feed an intentionally bogus proof.
  });

  it.skip("rejects double-spend (nullifier collision)", async () => {
    // TODO(phase-38): submit two transfers with the same nullifier and
    // assert the second fails with the system program's "account in use"
    // error.
  });

  it.skip("withdraws to recipient with optional relayer fee", async () => {
    // TODO(phase-39): prove a 1-in/1-out withdrawal, assert escrow
    // balance decreases by `amount` and recipient + relayer balances
    // increase per the split formula.
  });

  it.skip("forester batched root update advances root history", async () => {
    // TODO(phase-40): submit `update_root_via_proof` and assert
    // root_history_idx incremented and previous root recoverable.
  });
});
