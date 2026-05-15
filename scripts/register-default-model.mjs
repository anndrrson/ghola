/**
 * Register the default Llama-3.2-1B-Instruct-q4f16_1-MLC model in the
 * ghola-model-registry program. One-shot script — run with the
 * funded creator keypair to seed the registry with the model the
 * web client SRI-pins by default.
 *
 * Usage:
 *   cd <ghola-repo>
 *   node scripts/register-default-model.mjs
 *
 * Requires:
 *   - ~/.config/solana/id.json funded on devnet
 *   - apps/web/node_modules/@solana/web3.js + @noble/hashes resolvable
 *
 * SRI hashes (base64) are converted to raw [u8; 32] for on-chain
 * storage and must match what webgpu-inference.ts ships pinned.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
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

// Base64-decoded SRI hashes from webgpu-inference.ts.
function b64ToBytes(b64) {
  return Buffer.from(b64, "base64");
}
const CONFIG_HASH = b64ToBytes("DsUTtUtBmtRxAGQwaGvc/6rnECtB97Akb7/N4lF6zH8=");
const MODEL_LIB_HASH = b64ToBytes(
  "posvg0hde0xvfRoAgAG8g81/Kw+u/osTgfwT1C+3jEo=",
);
const TOKENIZER_HASH = b64ToBytes(
  "eePlImNfMXEwCRO7QhRkqH3mIiGCoFcLmyzLoqlksrQ=",
);

// Weights hash is a placeholder until we compute the canonical
// MLC param shard manifest hash. The web client's
// computeLoadedWeightFingerprint produces a SHA-256 over the cached
// artifacts; the on-chain value should match what the registry
// commits to. For the first deploy we anchor a zero hash with a
// follow-up update_model planned.
const WEIGHTS_HASH = Buffer.alloc(32, 0);

const IPFS_CID = "bafy-llama-3-2-1b-instruct-q4f16-placeholder";
const LICENSE_SPDX = "Llama-3.2-Community";
const PRICE_MICRO_USDC = 100n; // $0.0001 per inference

// Anchor instruction discriminator: first 8 bytes of
// sha256("global:register_model").
const DISCRIMINATOR = sha256(
  new TextEncoder().encode("global:register_model"),
).slice(0, 8);

const SEED_PREFIX = "ghola-model";

function borshU64Le(value) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value), 0);
  return buf;
}

function borshString(s) {
  const bytes = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([len, bytes]);
}

function borshFixed32(b) {
  if (b.length !== 32) throw new Error(`expected 32 bytes, got ${b.length}`);
  return Buffer.from(b);
}

async function main() {
  const conn = new Connection(RPC, "confirmed");

  const keypairBytes = JSON.parse(
    readFileSync(`${homedir()}/.config/solana/id.json`, "utf8"),
  );
  const creator = Keypair.fromSecretKey(Uint8Array.from(keypairBytes));
  console.log("creator:", creator.publicKey.toBase58());

  const modelIdHash = sha256(new TextEncoder().encode(MODEL_ID));
  const [pda, bump] = await PublicKey.findProgramAddress(
    [Buffer.from(SEED_PREFIX, "utf8"), Buffer.from(modelIdHash)],
    PROGRAM_ID,
  );
  console.log("registry PDA:", pda.toBase58(), "bump", bump);

  const existing = await conn.getAccountInfo(pda);
  if (existing) {
    console.log("PDA already registered — exiting without re-registering.");
    return;
  }

  // Build the register_model instruction data.
  // Layout: 8 bytes discriminator
  //   + [u8; 32] model_id_hash
  //   + String model_id
  //   + [u8; 32] weights_hash
  //   + [u8; 32] model_lib_hash
  //   + [u8; 32] config_hash
  //   + [u8; 32] tokenizer_hash
  //   + String ipfs_cid
  //   + String license_spdx
  //   + u64 price_micro_usdc
  const data = Buffer.concat([
    Buffer.from(DISCRIMINATOR),
    borshFixed32(modelIdHash),
    borshString(MODEL_ID),
    borshFixed32(WEIGHTS_HASH),
    borshFixed32(MODEL_LIB_HASH),
    borshFixed32(CONFIG_HASH),
    borshFixed32(TOKENIZER_HASH),
    borshString(IPFS_CID),
    borshString(LICENSE_SPDX),
    borshU64Le(PRICE_MICRO_USDC),
  ]);

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: creator.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = creator.publicKey;
  const { blockhash } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.sign(creator);

  console.log("sending register_model tx…");
  const sig = await conn.sendRawTransaction(tx.serialize());
  console.log("tx:", sig);
  console.log(
    `explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`,
  );
  await conn.confirmTransaction(sig, "confirmed");
  console.log("confirmed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
