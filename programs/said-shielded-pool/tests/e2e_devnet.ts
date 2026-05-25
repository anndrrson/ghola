/**
 * End-to-end devnet test for said-shielded-pool.
 *
 * Drives the deployed program at 5bmCDeaQceBpWgK8aADB4Tz4JzqZ9hkCi3qedC6oZR8A
 * through init_pool → init_tree → transfer, using the real snarkjs proof
 * artifacts under crates/said-shielded-pool-circuits/artifacts/.
 *
 * Run:
 *   cd programs/said-shielded-pool
 *   npx ts-node tests/e2e_devnet.ts
 */

// --- BEGIN monkey-patch: anchor 0.30's BorshInstructionCoder hard-codes a
// 1000-byte scratch buffer when encoding an instruction (see
// node_modules/@coral-xyz/anchor/dist/cjs/coder/borsh/instruction.js). Our
// init_pool ix carries a ~1 KiB `verifier_key_bytes: bytes` arg which blows
// past that limit. Replace the offending module's encode method with a
// 16 KiB scratch buffer BEFORE the rest of anchor pulls it in.
{
  const instructionMod = require("@coral-xyz/anchor/dist/cjs/coder/borsh/instruction.js");
  instructionMod.BorshInstructionCoder.prototype.encode = function (
    ixName: string,
    ix: any
  ) {
    const encoder = this.ixLayouts.get(ixName);
    if (!encoder) {
      throw new Error(`Unknown method: ${ixName}`);
    }
    const buf = Buffer.alloc(16 * 1024);
    const len = encoder.layout.encode(ix, buf);
    const data = buf.slice(0, len);
    return Buffer.concat([Buffer.from(encoder.discriminator), data]);
  };
}
// --- END monkey-patch

import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  createAccount,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const PROGRAM_ID = new PublicKey("5bmCDeaQceBpWgK8aADB4Tz4JzqZ9hkCi3qedC6oZR8A");
const IDL_PATH = path.resolve(
  __dirname,
  "../../../target/idl/said_shielded_pool.json"
);
const ARTIFACTS_DIR = path.resolve(
  __dirname,
  "../../../crates/said-shielded-pool-circuits/artifacts"
);

// BN254 base-field modulus q (Fq).
const FQ = BigInt(
  "21888242871839275222246405745257275088696311157297823662689037894645226208583"
);

// ----------------- conversion helpers (mirror gen_vk_rs.rs + groth16_solana_verify.rs) ----

function bigintToBE32(n: bigint): Buffer {
  if (n < 0n) n = ((n % FQ) + FQ) % FQ;
  const hex = n.toString(16).padStart(64, "0");
  return Buffer.from(hex, "hex");
}

function fqNeg(y: bigint): bigint {
  return (FQ - (y % FQ)) % FQ;
}

/** snarkjs G1 [x, y, "1"] → 64-byte [x_BE32 || y_BE32]. */
function g1ToBE64(arr: any[]): Buffer {
  const x = BigInt(arr[0]);
  const y = BigInt(arr[1]);
  return Buffer.concat([bigintToBE32(x), bigintToBE32(y)]);
}

/** snarkjs G1 negated (for proof_a). */
function g1NegToBE64(arr: any[]): Buffer {
  const x = BigInt(arr[0]);
  const y = fqNeg(BigInt(arr[1]));
  return Buffer.concat([bigintToBE32(x), bigintToBE32(y)]);
}

/**
 * snarkjs G2 [[x0,x1],[y0,y1],[1,0]] → 128-byte uncompressed in groth16-solana
 * convention (each Fq2 as c1||c0).
 */
function g2ToBE128(arr: any[]): Buffer {
  const x0 = BigInt(arr[0][0]);
  const x1 = BigInt(arr[0][1]);
  const y0 = BigInt(arr[1][0]);
  const y1 = BigInt(arr[1][1]);
  return Buffer.concat([
    bigintToBE32(x1),
    bigintToBE32(x0),
    bigintToBE32(y1),
    bigintToBE32(y0),
  ]);
}

/** Build the encoded VK byte blob exactly as the Rust gen_vk_rs.rs does (alpha||beta||gamma||delta||IC_concat). */
function encodeVkBytes(vkJson: any): Buffer {
  const alpha = g1ToBE64(vkJson.vk_alpha_1);
  const beta = g2ToBE128(vkJson.vk_beta_2);
  const gamma = g2ToBE128(vkJson.vk_gamma_2);
  const delta = g2ToBE128(vkJson.vk_delta_2);
  const ic: Buffer[] = vkJson.IC.map((pt: any) => g1ToBE64(pt));
  return Buffer.concat([alpha, beta, gamma, delta, ...ic]);
}

// ----------------- PDA helpers ----

function poolConfigPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool_config")],
    PROGRAM_ID
  );
}
function verifierKeyPda(pool: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("verifier_key"), pool.toBuffer()],
    PROGRAM_ID
  );
}
function merkleTreePda(pool: PublicKey, mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("merkle_tree"), pool.toBuffer(), mint.toBuffer()],
    PROGRAM_ID
  );
}
function nullifierPda(mint: PublicKey, nf: Buffer): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier"), mint.toBuffer(), nf],
    PROGRAM_ID
  );
}
function commitmentPda(tree: PublicKey, idx: bigint): [PublicKey, number] {
  const idxBuf = Buffer.alloc(8);
  idxBuf.writeBigUInt64LE(idx, 0);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("commitment"), tree.toBuffer(), idxBuf],
    PROGRAM_ID
  );
}

// ----------------- main ----

function loadPayer(): Keypair {
  const raw = JSON.parse(
    fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8")
  );
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main() {
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const payer = loadPayer();
  const wallet = new anchor.Wallet(payer);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);

  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
  const program = new anchor.Program(idl as anchor.Idl, provider);

  console.log("=== Ghola shielded-pool devnet E2E ===");
  console.log("Program ID :", PROGRAM_ID.toBase58());
  console.log("Payer      :", payer.publicKey.toBase58());
  const initialBalance = await connection.getBalance(payer.publicKey);
  console.log("Balance    :", (initialBalance / 1e9).toFixed(4), "SOL");

  // 1) Load artifacts.
  const vkJson = JSON.parse(
    fs.readFileSync(path.join(ARTIFACTS_DIR, "verification_key.json"), "utf8")
  );
  const proofJson = JSON.parse(
    fs.readFileSync(path.join(ARTIFACTS_DIR, "proof_deposit.json"), "utf8")
  );
  const publicJson = JSON.parse(
    fs.readFileSync(path.join(ARTIFACTS_DIR, "public_deposit.json"), "utf8")
  );

  const fullVkBytes = encodeVkBytes(vkJson);
  console.log("Full encoded vk bytes len:", fullVkBytes.length);
  // NOTE: the on-chain `verify()` IGNORES the bytes stored in the VerifierKey
  // PDA (see programs/said-shielded-pool/src/groth16.rs: "we don't deserialize
  // from it"). The active vk is compiled into the program. The PDA bytes are
  // only used for `len <= VERIFIER_KEY_MAX_LEN` and as a SHA-256 hash for
  // light-client transparency. Solana's 1232-byte legacy-tx ceiling rejects a
  // 1024-byte arg, so we ship a compact 32-byte sentinel here. This does NOT
  // affect the verifier path we're trying to exercise.
  const vkBytes = Buffer.alloc(32, 0);
  console.log("vk bytes passed in init_pool (sentinel):", vkBytes.length);

  // 2) Check / init_pool.
  const [pool, poolBump] = poolConfigPda();
  const [vk, vkBump] = verifierKeyPda(pool);
  console.log("pool_config :", pool.toBase58());
  console.log("verifier_key:", vk.toBase58());

  const existingPool = await connection.getAccountInfo(pool);
  if (!existingPool) {
    console.log("→ init_pool …");
    const sig = await program.methods
      .initPool(0, vkBytes)
      .accounts({
        admin: payer.publicKey,
        poolConfig: pool,
        verifierKey: vk,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("  init_pool sig:", sig);
  } else {
    console.log("  pool_config already exists — skipping init_pool");
  }

  // 3) Create fresh SPL mint (decimals=6, mint authority = payer).
  console.log("→ creating fresh SPL mint …");
  const mint = await createMint(
    connection,
    payer,
    payer.publicKey,
    null,
    6,
    undefined,
    { commitment: "confirmed" },
    TOKEN_PROGRAM_ID
  );
  console.log("  mint:", mint.toBase58());

  // 4) Mint 10_000 tokens to a payer-owned ATA.
  const payerAta = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mint,
    payer.publicKey,
    false,
    "confirmed",
    undefined,
    TOKEN_PROGRAM_ID
  );
  await mintTo(
    connection,
    payer,
    mint,
    payerAta.address,
    payer,
    10_000n * 1_000_000n,
    [],
    { commitment: "confirmed" },
    TOKEN_PROGRAM_ID
  );
  console.log("  payer ATA :", payerAta.address.toBase58(), "(minted 10_000)");

  // 5) Create the escrow token account: owner = pool_config PDA, mint = test mint.
  //    The program's init_tree expects `token::authority = pool_config`. The
  //    address itself is not seed-derived in the IDL — we just create a regular
  //    SPL token account with the pool as authority and pass its pubkey in.
  console.log("→ creating escrow token account (owner = pool_config) …");
  const escrowKp = Keypair.generate();
  const escrowAddr = await createAccount(
    connection,
    payer,
    mint,
    pool,
    escrowKp,
    { commitment: "confirmed" },
    TOKEN_PROGRAM_ID
  );
  console.log("  escrow:", escrowAddr.toBase58());

  // 6) init_tree with initial_root = [0u8;32] so that root=0 in the deposit
  //    public inputs is accepted by `root_in_history` and the verifier path
  //    actually runs.
  const [tree, treeBump] = merkleTreePda(pool, mint);
  console.log("  merkle_tree:", tree.toBase58());
  console.log("→ init_tree …");
  {
    const initialRoot = Array.from(Buffer.alloc(32));
    const sig = await program.methods
      .initTree(initialRoot)
      .accounts({
        admin: payer.publicKey,
        poolConfig: pool,
        mint,
        merkleTree: tree,
        escrow: escrowAddr,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("  init_tree sig:", sig);
  }

  // 7) Build the transfer args from the real artifacts.
  //    Public input layout: [root, in_nf_0, in_nf_1, out_cm_0, out_cm_1, public_amount, asset_id, ext_data_hash]
  const pubs: bigint[] = (publicJson as string[]).map((s) => BigInt(s));
  if (pubs.length !== 8) throw new Error(`expected 8 public inputs, got ${pubs.length}`);

  const root = bigintToBE32(pubs[0]);
  const nf0 = bigintToBE32(pubs[1]);
  const nf1 = bigintToBE32(pubs[2]);
  const cm0 = bigintToBE32(pubs[3]);
  const cm1 = bigintToBE32(pubs[4]);
  const publicAmount = bigintToBE32(pubs[5]);
  const assetId = bigintToBE32(pubs[6]);
  const extDataHash = bigintToBE32(pubs[7]);

  const proofA = g1NegToBE64(proofJson.pi_a);
  const proofB = g2ToBE128(proofJson.pi_b);
  const proofC = g1ToBE64(proofJson.pi_c);

  console.log("Public-input summary:");
  console.log("  root         :", root.toString("hex"));
  console.log("  in_nf_0      :", nf0.toString("hex"));
  console.log("  in_nf_1      :", nf1.toString("hex"));
  console.log("  out_cm_0     :", cm0.toString("hex"));
  console.log("  out_cm_1     :", cm1.toString("hex"));
  console.log("  public_amount:", publicAmount.toString("hex"));
  console.log("  asset_id     :", assetId.toString("hex"));
  console.log("  ext_data_hash:", extDataHash.toString("hex"));

  const [nullifier0Pda] = nullifierPda(mint, nf0);
  const [nullifier1Pda] = nullifierPda(mint, nf1);
  const [commitment0Pda] = commitmentPda(tree, 0n);
  const [commitment1Pda] = commitmentPda(tree, 1n);

  console.log("→ transfer (real-verifier path) …");
  const args = {
    proofA: Array.from(proofA),
    proofB: Array.from(proofB),
    proofC: Array.from(proofC),
    root: Array.from(root),
    inputNullifiers: [Array.from(nf0), Array.from(nf1)],
    outputCommitments: [Array.from(cm0), Array.from(cm1)],
    publicAmount: Array.from(publicAmount),
    assetId: Array.from(assetId),
    extDataHash: Array.from(extDataHash),
  };

  let transferResult: {
    sig?: string;
    error?: any;
    rawLogs?: string[];
  } = {};

  try {
    const sig = await program.methods
      .transfer(args as any)
      .accounts({
        payer: payer.publicKey,
        poolConfig: pool,
        verifierKey: vk,
        mint,
        merkleTree: tree,
        nullifier0: nullifier0Pda,
        nullifier1: nullifier1Pda,
        commitment0: commitment0Pda,
        commitment1: commitment1Pda,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed", skipPreflight: false });
    transferResult.sig = sig;
    console.log("  transfer sig:", sig, "(unexpectedly succeeded!)");
  } catch (e: any) {
    transferResult.error = e;
    // Try to pull out logs.
    if (e?.logs) {
      transferResult.rawLogs = e.logs;
    } else if (e?.transactionLogs) {
      transferResult.rawLogs = e.transactionLogs;
    } else if (e?.simulationResponse?.logs) {
      transferResult.rawLogs = e.simulationResponse.logs;
    }
    console.log("  transfer FAILED:", e?.message || String(e));
    if (transferResult.rawLogs) {
      console.log("  --- program logs ---");
      for (const l of transferResult.rawLogs) console.log("    ", l);
      console.log("  --------------------");
    }
  }

  // 8) Classify the result.
  const logs = transferResult.rawLogs?.join("\n") || "";
  const errMsg = String(transferResult.error?.message || "");
  let headline: string;
  if (transferResult.sig) {
    headline = "VERIFIER ACCEPTED — full transfer succeeded (unexpected, public_amount != 0)";
  } else if (/InvalidProof|6000|Groth16 proof verification failed/.test(logs + errMsg)) {
    headline = "VERIFIER REJECTED — on-chain Groth16 returned InvalidProof";
  } else if (
    /InsufficientValue|6004|Public amount.*inconsistent|RootNotInHistory|6002/.test(
      logs + errMsg
    )
  ) {
    headline =
      "VERIFIER ACCEPTED — tx died downstream (domain check failed, e.g. InsufficientValue/RootNotInHistory)";
  } else {
    headline = "INDETERMINATE — see logs above";
  }
  console.log("\n=== HEADLINE: " + headline + " ===");

  const finalBalance = await connection.getBalance(payer.publicKey);
  console.log(
    "Final balance:",
    (finalBalance / 1e9).toFixed(4),
    "SOL  (Δ =",
    ((finalBalance - initialBalance) / 1e9).toFixed(4),
    "SOL)"
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
