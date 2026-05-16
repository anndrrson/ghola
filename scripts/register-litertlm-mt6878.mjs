/**
 * Register the MT6878 (Solana Seeker) Gemma-3-1B `.litertlm` bundle
 * in the ghola-model-registry program. Adapted from
 * register-default-model.mjs — same instruction shape, different
 * artifact + different per-variant fields.
 *
 * STAGING NOTE — do NOT run yet. This script is staged for the
 * moment the compile pipeline in `tools/litertlm-compile/` produces
 * a usable bundle. Two upstream blockers (LiteRT #6462 = 153x perf
 * hit from missing MDLA flags, litert-torch #984 = undocumented
 * packager) gate ship per docs/perf/aot-compile-mt6878.md §9.
 *
 * To unblock, fill in the `TODO(staged)` lines below with the values
 * emitted by `tools/litertlm-compile/compile-gemma3-1b-mt6878.sh`
 * into out/sha256.txt, then run:
 *
 *   cd <ghola-repo>
 *   node scripts/register-litertlm-mt6878.mjs
 *
 * Requires (same as register-default-model.mjs):
 *   - ~/.config/solana/id.json funded on devnet
 *   - apps/web/node_modules/@solana/web3.js + @noble/hashes
 *
 * Two-hash strategy (docs/security/native-models.md §2):
 * `weights_hash` here is the COMPILED `.litertlm` SHA-256 (the
 * canonical on-device pin). The upstream `.tflite` source hash is
 * also anchored on-chain via the dedicated `source_input_hash` field
 * — see TODO below for the value, which comes from the same
 * sha256.txt that the compile script emits.
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

// Stable across all SoC variants — the model is the same; only the
// AOT-compiled bytecode differs per SoC. The variant suffix lives in
// the filename, not the model_id, so all variants share registry
// state aside from the per-variant hashes.
const MODEL_ID = "Gemma3-1B-IT-mt6878";

// ── Hashes (filled in once tools/litertlm-compile/ produces output)
//
// Both values come from the `out/sha256.txt` produced by
// `compile-gemma3-1b-mt6878.sh`. Two-hash strategy:
//   WEIGHTS_HASH        = SHA-256 of the compiled .litertlm bundle
//                         (this is what IntegrityVerifier enforces
//                          on-device; also what
//                          PinnedModelHashes.GEMMA_3_1B_LITERTLM_MT6878_SHA256
//                          gets flipped to)
//   SOURCE_INPUT_HASH   = SHA-256 of the upstream `.tflite` we
//                         compiled from (Google's published artifact;
//                         the upstream-supply-chain anchor)

// TODO(staged): replace placeholder with OUTPUT_LITERTLM_SHA256 from
// tools/litertlm-compile output. Buffer.from will throw if the string
// is the wrong length, so the placeholder failing fast is the desired
// behaviour until a real hash lands.
const WEIGHTS_HASH = Buffer.from(
  // 64-char hex placeholder — replace with the real compiled hash.
  "0000000000000000000000000000000000000000000000000000000000000000",
  "hex",
);

// TODO(staged): replace placeholder with INPUT_TFLITE_SHA256 from
// tools/litertlm-compile output. Should match Google's published
// gemma3-1b-it-int4.tflite hash exactly.
const SOURCE_INPUT_HASH = Buffer.from(
  "0000000000000000000000000000000000000000000000000000000000000000",
  "hex",
);

// These three hashes don't apply to LiteRT-LM bundles the way they
// do to MLC WebLLM bundles (no separate config / model-lib / tokenizer
// files — they're packed inside the .litertlm container). We pass
// 32-byte zero arrays so the on-chain account layout stays uniform
// across WebLLM and LiteRT-LM entries.
const ZERO32 = Buffer.alloc(32);
const CONFIG_HASH = ZERO32;
const MODEL_LIB_HASH = ZERO32;
const TOKENIZER_HASH = ZERO32;

// TODO(staged): replace with the actual IPFS CID emitted by
// `ipfs add Gemma3-1B-IT_q4_ekv1280_mt6878.litertlm`. Until then the
// placeholder anchors *some* CID so the field is non-empty.
const IPFS_CID = "bafy-gemma3-1b-it-mt6878-placeholder";

// Gemma 3 community license — matches what `google/gemma-3-1b-it`
// ships under on HuggingFace.
const LICENSE_SPDX = "Gemma";

// Native inference doesn't bill per-request the way the web WebLLM
// path does — the device is the compute. Anchor zero so the registry
// row exists for audit + multi-source verification but no payment
// flow is implied.
const PRICE_MICRO_USDC = 0n;

// Anchor instruction discriminator: first 8 bytes of
// sha256("global:register_model"). Same as register-default-model.mjs.
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

function assertNotPlaceholder(b, name) {
  if (b.equals(ZERO32)) {
    throw new Error(
      `${name} is still the all-zero placeholder. Fill in from ` +
        `tools/litertlm-compile/out/sha256.txt before running this script. ` +
        `See script header for context.`,
    );
  }
}

async function main() {
  // Refuse to run with placeholders — better to fail loudly than to
  // anchor a zero-hash on devnet.
  assertNotPlaceholder(WEIGHTS_HASH, "WEIGHTS_HASH");
  assertNotPlaceholder(SOURCE_INPUT_HASH, "SOURCE_INPUT_HASH");
  if (IPFS_CID.includes("placeholder")) {
    throw new Error(
      `IPFS_CID is still the placeholder. Fill in from \`ipfs add\` output ` +
        `before running this script.`,
    );
  }

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

  // Build register_model instruction data. Layout matches the
  // Anchor program in programs/ghola-model-registry/src/lib.rs —
  // see register-default-model.mjs for the field-by-field comment.
  //
  // NOTE: if/when the program adds the explicit `source_input_hash`
  // field promised in docs/perf/aot-compile-mt6878.md §7, append it
  // here. Until then the source hash is captured off-chain in the
  // sha256.txt artifact that ships alongside the bundle.
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
  console.log("");
  console.log("Next:");
  console.log(
    "  1. Flip GEMMA_3_1B_LITERTLM_MT6878_SHA256 in PinnedModelHashes.kt",
  );
  console.log("  2. Upload bundle per tools/litertlm-compile/HOSTING.md");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
