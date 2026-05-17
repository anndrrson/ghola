/**
 * Close the default model registry record.
 *
 * Used as the first step of a "correct the placeholder weights_hash"
 * flow. After close_model returns the rent lamports to the creator,
 * run scripts/register-default-model.mjs to re-register with the
 * canonical hashes — the second run will succeed because the PDA is
 * now empty.
 *
 * Requires the deployed program to include the close_model
 * instruction (programs/ghola-model-registry/src/lib.rs added it,
 * but as of this commit it is NOT yet on devnet because the
 * upgrade tx requires ~1.5 SOL and devnet airdrops are rate-limited).
 *
 * Usage:
 *   cd <ghola-repo>/apps/web
 *   node ../../scripts/close-default-model.mjs
 *
 * Run this only when:
 *   1. close_model is live on the deployed program.
 *   2. You are the creator listed on the PDA (the script asserts).
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha256";
import { readFileSync } from "fs";
import { homedir } from "os";

const PROGRAM_ID = new PublicKey(
  "7hZ9oxHyFRpKHtH3jsa8NeH4HYGrPT7ZttDFtUX9naNS",
);
const RPC = "https://api.devnet.solana.com";
const MODEL_ID = "Llama-3.2-1B-Instruct-q4f16_1-MLC";
const SEED_PREFIX = "ghola-model";

// Anchor discriminator: first 8 bytes of sha256("global:close_model").
const DISCRIMINATOR = sha256(
  new TextEncoder().encode("global:close_model"),
).slice(0, 8);

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const keypairBytes = JSON.parse(
    readFileSync(`${homedir()}/.config/solana/id.json`, "utf8"),
  );
  const creator = Keypair.fromSecretKey(Uint8Array.from(keypairBytes));
  console.log("creator:", creator.publicKey.toBase58());

  const modelIdHash = sha256(new TextEncoder().encode(MODEL_ID));
  const [pda] = await PublicKey.findProgramAddress(
    [Buffer.from(SEED_PREFIX, "utf8"), Buffer.from(modelIdHash)],
    PROGRAM_ID,
  );
  console.log("registry PDA:", pda.toBase58());

  const existing = await conn.getAccountInfo(pda);
  if (!existing) {
    console.log("PDA empty — nothing to close.");
    return;
  }

  // ModelRecord layout: 8 discr + 32 creator + 4*32 hashes + 8 price
  // + 8 created + 8 updated + 2 version + variable strings. We only
  // need the creator at offset 8..40 to sanity-check.
  const onChainCreator = new PublicKey(existing.data.slice(8, 40));
  if (!onChainCreator.equals(creator.publicKey)) {
    console.error(
      `ABORT: on-chain creator ${onChainCreator.toBase58()} does not match local keypair ${creator.publicKey.toBase58()}`,
    );
    process.exit(1);
  }

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: creator.publicKey, isSigner: true, isWritable: true },
    ],
    data: Buffer.from(DISCRIMINATOR),
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = creator.publicKey;
  const { blockhash } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.sign(creator);

  console.log("sending close_model tx…");
  const sig = await conn.sendRawTransaction(tx.serialize());
  console.log("tx:", sig);
  console.log(
    `explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`,
  );
  await conn.confirmTransaction(sig, "confirmed");
  console.log("closed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
