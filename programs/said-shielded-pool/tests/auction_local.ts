/**
 * Local auction lifecycle fixture for the default no-real-verifier build.
 *
 * Run under a local validator after deploying `said_shielded_pool`.
 * This isolates Anchor account-state failures from the web/API smoke path.
 */

import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, Keypair } from "@solana/web3.js";
import { createMint } from "@solana/spl-token";
import assert from "node:assert/strict";

declare function describe(name: string, fn: () => void): void;
declare function it(name: string, fn: () => Promise<void>): void;

function pda(seeds: Buffer[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

function field(fill: number): number[] {
  const out = Buffer.alloc(32, fill);
  out[0] &= 0x1f;
  return Array.from(out);
}

async function waitForSlot(provider: anchor.AnchorProvider, slot: number) {
  for (;;) {
    const current = await provider.connection.getSlot("confirmed");
    if (current >= slot) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

describe("said-shielded-pool auction local lifecycle", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SaidShieldedPool as any;
  const admin = (provider.wallet as anchor.Wallet).payer as Keypair;
  const poolConfig = pda([Buffer.from("pool_config")], program.programId);
  const verifierKey = pda([Buffer.from("verifier_key"), poolConfig.toBuffer()], program.programId);

  it("opens, commits, clears, and settles an auction epoch", async () => {
    const existingPool = await provider.connection.getAccountInfo(poolConfig, "confirmed");
    if (!existingPool) {
      await program.methods
        .initPool(0, Buffer.alloc(32))
        .accounts({
          admin: admin.publicKey,
          poolConfig,
          verifierKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc({ commitment: "confirmed" });
    }

    const mint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6,
    );
    const marketCommitment = field(1);
    const auctionMarket = pda(
      [
        Buffer.from("auction_market"),
        poolConfig.toBuffer(),
        mint.toBuffer(),
        Buffer.from(marketCommitment),
      ],
      program.programId,
    );
    await program.methods
      .initAuctionMarket({
        marketCommitment,
        assetId: field(2),
        auctionVerifierKeyHash: field(3),
        batchSize: 64,
      })
      .accounts({
        admin: admin.publicKey,
        poolConfig,
        mint,
        auctionMarket,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    const currentSlot = await provider.connection.getSlot("confirmed");
    const epochId = new anchor.BN(currentSlot + 1);
    const closesSlot = currentSlot + 6;
    const auctionEpoch = pda(
      [
        Buffer.from("auction_epoch"),
        auctionMarket.toBuffer(),
        epochId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId,
    );
    await program.methods
      .openAuctionEpoch({
        epochId,
        closesSlot: new anchor.BN(closesSlot),
      })
      .accounts({
        authority: admin.publicKey,
        poolConfig,
        auctionMarket,
        auctionEpoch,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    const orderCommitment = field(4);
    const orderNullifier = field(5);
    const auctionOrder = pda(
      [
        Buffer.from("auction_order"),
        auctionEpoch.toBuffer(),
        Buffer.from(orderCommitment),
      ],
      program.programId,
    );
    const orderNullifierPda = pda(
      [
        Buffer.from("auction_order_nullifier"),
        auctionMarket.toBuffer(),
        Buffer.from(orderNullifier),
      ],
      program.programId,
    );
    await program.methods
      .commitAuctionOrder({
        orderCommitment,
        orderNullifier,
        priceBucketCommitment: field(6),
        institutionPolicyCommitment: field(7),
        side: 0,
        amountBucket: 25,
      })
      .accounts({
        owner: admin.publicKey,
        poolConfig,
        auctionMarket,
        auctionEpoch,
        auctionOrder,
        orderNullifier: orderNullifierPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    await waitForSlot(provider, closesSlot);
    const epochBeforeClose = await program.account.auctionEpoch.fetch(auctionEpoch);
    const auctionClearing = pda(
      [Buffer.from("auction_clearing"), auctionEpoch.toBuffer()],
      program.programId,
    );
    const settlementCommitment = field(11);
    await program.methods
      .closeAuctionEpoch({
        proofA: Array.from(Buffer.alloc(64)),
        proofB: Array.from(Buffer.alloc(128)),
        proofC: Array.from(Buffer.alloc(64)),
        auctionOrderRoot: Array.from(epochBeforeClose.orderRoot),
        clearingCommitment: field(8),
        clearingPriceCommitment: field(9),
        matchedRoot: field(10),
        rolledRoot: field(12),
        matchedCount: 1,
        rolledCount: 0,
        settlementCommitment,
        proofCommitment: field(13),
      })
      .accounts({
        authority: admin.publicKey,
        poolConfig,
        auctionMarket,
        auctionEpoch,
        auctionClearing,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    const cleared = await program.account.auctionClearing.fetch(auctionClearing);
    assert.equal(cleared.status, 2);
    assert.equal(cleared.matchedCount, 1);

    await program.methods
      .settleAuctionClearing({ settlementCommitment })
      .accounts({
        authority: admin.publicKey,
        poolConfig,
        auctionMarket,
        auctionEpoch,
        auctionClearing,
      })
      .rpc({ commitment: "confirmed" });

    const settled = await program.account.auctionClearing.fetch(auctionClearing);
    assert.equal(settled.status, 3);
  });
});
