/**
 * Full devnet integration loop for said-shielded-pool.
 *
 * Drives the deployed program at 5bmCDeaQceBpWgK8aADB4Tz4JzqZ9hkCi3qedC6oZR8A
 * through: fresh-mint → init_tree → REAL deposit → forester batched-update
 * with the REAL commitment → withdraw to a fresh recipient ATA.
 *
 * After the deposit→fold→withdraw cycle, the recipient ATA should hold
 * 1_000_000_000 (1000 tokens at 6 decimals) and the escrow ATA should
 * return to 0.
 *
 * Run:
 *   cd programs/said-shielded-pool
 *   npx ts-node tests/full_loop_devnet.ts
 */

// --- Anchor 1000-byte ix-encode scratch buffer monkey-patch ---
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

import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  createAccount,
} from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

const PROGRAM_ID = new PublicKey("5bmCDeaQceBpWgK8aADB4Tz4JzqZ9hkCi3qedC6oZR8A");
const IDL_PATH = path.resolve(
  __dirname,
  "../../../target/idl/said_shielded_pool.json"
);
const CIRCUITS_DIR = path.resolve(
  __dirname,
  "../../../crates/said-shielded-pool-circuits"
);
const ARTIFACTS_DIR = path.join(CIRCUITS_DIR, "artifacts");
const CEREMONY_DIR = path.join(CIRCUITS_DIR, "ceremony");
const CIRCUITS_NODE_MODULES = path.join(CIRCUITS_DIR, "circuits", "node_modules");

// circomlibjs + snarkjs live in the circuits sub-package's node_modules
const circomlibjs = require(path.join(CIRCUITS_NODE_MODULES, "circomlibjs"));
const snarkjs = require(path.join(CIRCUITS_NODE_MODULES, "snarkjs"));

// BN254 base-field modulus q (Fq) — for proof point negation.
const FQ = BigInt(
  "21888242871839275222246405745257275088696311157297823662689037894645226208583"
);
// BN254 scalar-field modulus p — for negative public_amount encoding.
const FR = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617"
);

const TREE_DEPTH = 26;
const FORESTER_BATCH = 4;
const DEPOSIT_AMOUNT = 1_000_000_000n; // 1000 tokens at 6 decimals
const DEPOSIT_AMOUNT_CIRCUIT = 1_000_000_000n; // circuit treats amount as field element

// Empty depth-26 root Z[26].
const Z26_DEC =
  "8163447297445169709687354538480474434591144168767135863541048304198280615192";

// ----------------- conversion helpers ----

function bigintToBE32(n: bigint): Buffer {
  if (n < 0n) n = ((n % FQ) + FQ) % FQ;
  const hex = n.toString(16).padStart(64, "0");
  return Buffer.from(hex, "hex");
}
function fqNeg(y: bigint): bigint {
  return (FQ - (y % FQ)) % FQ;
}
function g1ToBE64(arr: any[]): Buffer {
  const x = BigInt(arr[0]);
  const y = BigInt(arr[1]);
  return Buffer.concat([bigintToBE32(x), bigintToBE32(y)]);
}
function g1NegToBE64(arr: any[]): Buffer {
  const x = BigInt(arr[0]);
  const y = fqNeg(BigInt(arr[1]));
  return Buffer.concat([bigintToBE32(x), bigintToBE32(y)]);
}
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
function commitmentPda(tree: PublicKey, idx: bigint): [PublicKey, number] {
  const idxBuf = Buffer.alloc(8);
  idxBuf.writeBigUInt64LE(idx, 0);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("commitment"), tree.toBuffer(), idxBuf],
    PROGRAM_ID
  );
}
function nullifierPda(mint: PublicKey, nf: Buffer): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier"), mint.toBuffer(), nf],
    PROGRAM_ID
  );
}

function loadPayer(): Keypair {
  const raw = JSON.parse(
    fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8")
  );
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function extractCU(logs: string[] | undefined): string {
  if (!logs) return "?";
  // Prefer the outermost program's CU line (matches our PROGRAM_ID).
  const pid = PROGRAM_ID.toBase58();
  for (const l of logs) {
    const m = l.match(new RegExp(`Program ${pid} consumed (\\d+) of \\d+ compute units`));
    if (m) return m[1];
  }
  // Fallback: last "consumed X of Y" line (outermost prints last).
  let last = "?";
  for (const l of logs) {
    const m = l.match(/consumed (\d+) of \d+ compute units/);
    if (m) last = m[1];
  }
  return last;
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(url: string, body: any): Promise<any> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let json: any = {};
  if (text.trim()) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }
  if (!resp.ok) {
    throw new Error(`POST ${url} failed ${resp.status}: ${text}`);
  }
  return json;
}

async function getJson(url: string): Promise<any> {
  const resp = await fetch(url);
  const text = await resp.text();
  const json = text.trim() ? JSON.parse(text) : {};
  if (!resp.ok) {
    throw new Error(`GET ${url} failed ${resp.status}: ${text}`);
  }
  return json;
}

function relayBaseUrl(): string | null {
  const raw =
    process.env.GHOLA_SHIELDED_POOL_RELAYER_URL ??
    process.env.SOLANA_SHIELDED_POOL_RELAYER_URL ??
    process.env.RELAYER_URL ??
    "";
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : null;
}

async function relayWithdraw(
  relayerUrl: string,
  ix: any,
  args: {
    recipient: PublicKey;
    fee: bigint;
    relayerFee: bigint;
    proofA: Buffer;
    proofB: Buffer;
    proofC: Buffer;
    root: Buffer;
    nullifier0: Buffer;
    nullifier1: Buffer;
    changeCommitment: Buffer;
    paddingCommitment: Buffer;
    publicAmount: Buffer;
    assetId: Buffer;
    extDataHash: Buffer;
  }
): Promise<string> {
  const body = {
    proof_bundle: {
      a: args.proofA.toString("hex"),
      b: args.proofB.toString("hex"),
      c: args.proofC.toString("hex"),
      root: args.root.toString("hex"),
      input_nullifiers: [
        args.nullifier0.toString("hex"),
        args.nullifier1.toString("hex"),
      ],
      output_commitments: [
        args.changeCommitment.toString("hex"),
        args.paddingCommitment.toString("hex"),
      ],
      public_amount: Number(DEPOSIT_AMOUNT),
      asset_id: args.assetId.toString("hex"),
      ext_data_hash: args.extDataHash.toString("hex"),
    },
    recipient: args.recipient.toBase58(),
    fee: Number(args.fee),
    relayer_fee: Number(args.relayerFee),
    instruction_data_hex: Buffer.from(ix.data).toString("hex"),
    accounts: ix.keys.map((k: any) => ({
      pubkey: k.pubkey.toBase58(),
      is_signer: k.isSigner,
      is_writable: k.isWritable,
    })),
  };

  const accepted = await postJson(`${relayerUrl}/relay`, body);
  const id = accepted.id;
  if (!id) throw new Error("relayer response missing id");
  console.log("  relayer id:", id);
  console.log("  relayer eta_seconds:", accepted.eta_seconds ?? "unknown");

  const deadline = Date.now() + 120_000;
  let lastStatus = "unknown";
  while (Date.now() < deadline) {
    const status = await getJson(`${relayerUrl}/status/${id}`);
    lastStatus = status.status ?? "unknown";
    console.log("  relayer status:", lastStatus);
    if (lastStatus === "confirmed" || lastStatus === "unknown") return id;
    if (lastStatus === "failed") {
      throw new Error(`relayer marked withdrawal failed for id ${id}`);
    }
    await sleep(1_500);
  }
  throw new Error(`relayer confirmation timed out; last status=${lastStatus}`);
}

interface StepResult {
  label: string;
  sig?: string;
  cu?: string;
  error?: string;
  logs?: string[];
}

const results: StepResult[] = [];

// ============================================================
//  Poseidon helpers (circomlibjs) — bit-for-bit identical to
//  on-circuit Poseidon (Circom-compatible).
// ============================================================
let _poseidon: any;
async function poseidon() {
  if (!_poseidon) _poseidon = await circomlibjs.buildPoseidon();
  return _poseidon;
}

/** Poseidon(elems[]) → bigint string. */
async function H(elems: (bigint | string)[]): Promise<string> {
  const p = await poseidon();
  const arr = elems.map((x) => p.F.e(typeof x === "bigint" ? x.toString() : x));
  return p.F.toString(p(arr));
}

/** Compute Z[0..TREE_DEPTH] zero-hashes. */
async function zeroHashes(): Promise<string[]> {
  const p = await poseidon();
  const Z: any[] = [p.F.e(0)];
  for (let d = 1; d <= TREE_DEPTH; d++) {
    Z.push(p([Z[d - 1], Z[d - 1]]));
  }
  return Z.map((x) => p.F.toString(x));
}

// ----------------- main ----

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

  console.log("=========================================");
  console.log("Ghola shielded-pool — FULL LOOP devnet");
  console.log("=========================================");
  console.log("Program ID :", PROGRAM_ID.toBase58());
  console.log("Payer      :", payer.publicKey.toBase58());
  const initialBalance = await connection.getBalance(payer.publicKey);
  console.log("Balance    :", (initialBalance / 1e9).toFixed(4), "SOL");

  // -------- 1. pool_config + verifier_key already initialized.
  const [pool] = poolConfigPda();
  const [vk] = verifierKeyPda(pool);
  console.log("pool_config :", pool.toBase58());
  console.log("verifier_key:", vk.toBase58());
  if (!(await connection.getAccountInfo(pool))) {
    throw new Error("pool_config PDA missing — re-run init_pool first");
  }

  // -------- 2. Fresh SPL mint.
  console.log("\n[2/6] fresh SPL mint");
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

  // -------- 3. Mint 10_000 tokens to payer ATA.
  console.log("\n[3/6] mint 10_000 to payer ATA");
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
  console.log("  payer ATA :", payerAta.address.toBase58());

  // -------- 4. Create escrow + init_tree with root = Z[26].
  console.log("\n[4/6] escrow + init_tree (root=Z[26])");
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

  const [tree] = merkleTreePda(pool, mint);
  console.log("  merkle_tree:", tree.toBase58());

  const z26 = bigintToBE32(BigInt(Z26_DEC));
  {
    const sig = await program.methods
      .initTree(Array.from(z26))
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
    const r = await connection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    results.push({ label: "init_tree", sig, cu: extractCU(r?.meta?.logMessages ?? undefined) });
  }

  // ============================================================
  //  CRYPTO SETUP
  //
  //  Build the canonical secret material we'll use for both the
  //  deposit commitment and the later withdraw nullifier.
  // ============================================================

  const Z = await zeroHashes();
  console.log("\n  Z[26] (off-chain) :", Z[TREE_DEPTH]);

  // asset_id = Poseidon1(mintPubkeyAsField). The mint pubkey is 32 BE bytes;
  // we interpret it as an unsigned BE integer and mask to 254 bits to fit
  // BN254. The on-chain handler currently does NOT recompute this (Phase 41
  // TODO), so any non-zero value circuit-bound to the proof is accepted.
  const mintBytes = mint.toBytes();
  let mintInt = 0n;
  for (const b of mintBytes) mintInt = (mintInt << 8n) | BigInt(b);
  const FIELD_MASK = (1n << 254n) - 1n;
  const mintField = mintInt & FIELD_MASK;
  const assetId = await H([mintField]);
  console.log("  asset_id          :", assetId);

  // Spending key + blinding for the single deposited note.
  const sk = 0x1337beef1337beefn;
  const ownerPk = await H([sk]);
  const blinding = 0xdeadbeefcafebaben;
  const realCommit = await H([
    DEPOSIT_AMOUNT_CIRCUIT,
    assetId,
    ownerPk,
    blinding,
  ]);
  console.log("  owner_pk          :", ownerPk);
  console.log("  blinding          :", blinding.toString());
  console.log("  REAL commit       :", realCommit);

  // -------- 5. DEPOSIT 1000 tokens with the REAL Poseidon commitment.
  console.log("\n[5/6] deposit 1000 tokens with REAL Poseidon commitment");
  const escrowBalBefore = (
    await connection.getTokenAccountBalance(escrowAddr)
  ).value.amount;
  const payerAtaBalBefore = (
    await connection.getTokenAccountBalance(payerAta.address)
  ).value.amount;
  console.log("  escrow balance BEFORE :", escrowBalBefore);
  console.log("  payer ATA bal BEFORE  :", payerAtaBalBefore);

  // The patched deposit ix uses queue_index = tree.next_index, AND no longer
  // advances next_index. So both should be 0 here.
  let nextIndexBeforeDeposit: bigint;
  {
    const treeAcct = await connection.getAccountInfo(tree);
    if (!treeAcct) throw new Error("tree account vanished");
    // Layout: 8 (disc) + root_history(2048) + pool(32) + mint(32) + root(32) + next_index(8)
    const offset = 8 + 2048 + 32 + 32 + 32;
    nextIndexBeforeDeposit = treeAcct.data.readBigUInt64LE(offset);
    console.log("  tree.next_index (pre-deposit):", nextIndexBeforeDeposit.toString());
  }
  const [commitRec] = commitmentPda(tree, nextIndexBeforeDeposit);

  // Pack the real commitment as a 32-byte BE blob — must match the field-
  // element representation the circuit uses.
  const realCommitBE = bigintToBE32(BigInt(realCommit));

  {
    const sig = await program.methods
      .deposit(new (require("bn.js"))(DEPOSIT_AMOUNT.toString()), Array.from(realCommitBE))
      .accounts({
        depositor: payer.publicKey,
        poolConfig: pool,
        mint,
        merkleTree: tree,
        depositorTokenAccount: payerAta.address,
        escrow: escrowAddr,
        commitmentRecord: commitRec,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed", skipPreflight: false });
    console.log("  deposit sig:", sig);
    const r = await connection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const cu = extractCU(r?.meta?.logMessages ?? undefined);
    console.log("  CU consumed:", cu);
    results.push({ label: "deposit", sig, cu });

    const escrowBalAfter = (
      await connection.getTokenAccountBalance(escrowAddr)
    ).value.amount;
    const payerAtaBalAfter = (
      await connection.getTokenAccountBalance(payerAta.address)
    ).value.amount;
    console.log("  escrow balance AFTER  :", escrowBalAfter);
    console.log("  payer ATA bal AFTER   :", payerAtaBalAfter);

    // Verify next_index did NOT advance (patched deposit).
    const treeAcct = await connection.getAccountInfo(tree);
    const offset = 8 + 2048 + 32 + 32 + 32;
    const nextIndexAfterDeposit = treeAcct!.data.readBigUInt64LE(offset);
    console.log("  tree.next_index (post-deposit):", nextIndexAfterDeposit.toString());
    if (nextIndexAfterDeposit !== 0n) {
      throw new Error(
        `Expected next_index=0 after deposit (patched ix), got ${nextIndexAfterDeposit}`
      );
    }
  }

  // ============================================================
  //  [6/6] FORESTER FOLD with the REAL commitment.
  //
  //  Build batchedUpdate input.json:
  //    commitments = [realCommit, 0, 0, 0]
  //    start_index = 0
  //    old_root    = Z[26]
  //    new_root    = root after inserting realCommit at slot 0
  //                  (all-zero siblings at every depth → same tree shape,
  //                  just leaf[0] flipped from 0 → realCommit)
  //
  //  Per-step sibling paths (depth 0..25):
  //    step 0 (insert realCommit at slot 0): all siblings = Z[d]
  //    step 1 (insert 0 at slot 1): sibling[0] = realCommit, sibling[d>=1] = Z[d]
  //    step 2 (insert 0 at slot 2): sibling[0] = 0,
  //                                  sibling[1] = Poseidon(realCommit, 0),
  //                                  sibling[d>=2] = Z[d]
  //    step 3 (insert 0 at slot 3): sibling[0] = 0,
  //                                  sibling[1] = Poseidon(realCommit, 0),
  //                                  sibling[d>=2] = Z[d]
  // ============================================================
  console.log("\n[6/6a] forester batched-update — build witness + proof");
  const p = await poseidon();
  const F = p.F;

  // Compute new_root after inserting realCommit at slot 0 in empty tree.
  // Since siblings are all Z[d], new_root = path-hash from realCommit upward.
  let current = F.e(realCommit);
  for (let d = 0; d < TREE_DEPTH; d++) {
    // bit-0 at every level (slot index = 0) → current is left, sibling is right.
    current = p([current, F.e(Z[d])]);
  }
  const newRoot = F.toString(current);
  console.log("  new_root :", newRoot);

  // Build per-step path elements.
  const node_d1_left = F.toString(p([F.e(realCommit), F.e("0")])); // Poseidon(realCommit, 0)

  const pathRow_step0 = Z.slice(0, TREE_DEPTH); // all Z[d]
  const pathRow_step1 = [realCommit, ...Z.slice(1, TREE_DEPTH)];
  const pathRow_step2 = ["0", node_d1_left, ...Z.slice(2, TREE_DEPTH)];
  const pathRow_step3 = ["0", node_d1_left, ...Z.slice(2, TREE_DEPTH)];

  const foresterInput = {
    oldRoot: Z[TREE_DEPTH],
    newRoot,
    startIndex: "0",
    commitment: [realCommit, "0", "0", "0"],
    pad: "0",
    pathElements: [pathRow_step0, pathRow_step1, pathRow_step2, pathRow_step3],
  };

  const foresterInputPath = path.join(__dirname, "_tmp_forester_input.json");
  const foresterWtnsPath = path.join(__dirname, "_tmp_forester.wtns");
  const foresterProofPath = path.join(__dirname, "_tmp_forester_proof.json");
  const foresterPublicPath = path.join(__dirname, "_tmp_forester_public.json");
  fs.writeFileSync(foresterInputPath, JSON.stringify(foresterInput, null, 2));

  // Generate witness.
  console.log("  generating witness…");
  const batchWasm = path.join(ARTIFACTS_DIR, "batchedUpdate_js", "batchedUpdate.wasm");
  await snarkjs.wtns.calculate(
    foresterInput,
    batchWasm,
    foresterWtnsPath
  );

  // Groth16 prove.
  console.log("  generating Groth16 proof…");
  const batchZkey = path.join(CEREMONY_DIR, "batchedUpdate_final.zkey");
  const { proof: foresterProof, publicSignals: foresterPublics } =
    await snarkjs.groth16.prove(batchZkey, foresterWtnsPath);
  fs.writeFileSync(foresterProofPath, JSON.stringify(foresterProof, null, 2));
  fs.writeFileSync(foresterPublicPath, JSON.stringify(foresterPublics, null, 2));
  console.log("  public signals:", foresterPublics);

  // Convert to on-chain wire format.
  const fOldRoot = bigintToBE32(BigInt(foresterPublics[0]));
  const fNewRoot = bigintToBE32(BigInt(foresterPublics[1]));
  const fStartIndex = BigInt(foresterPublics[2]);
  const fCommitments = [3, 4, 5, 6].map((i) =>
    Array.from(bigintToBE32(BigInt(foresterPublics[i])))
  );
  const fProofA = g1NegToBE64(foresterProof.pi_a);
  const fProofB = g2ToBE128(foresterProof.pi_b);
  const fProofC = g1ToBE64(foresterProof.pi_c);

  console.log("\n[6/6b] submit update_root_via_proof");
  let foresterSig: string | undefined;
  try {
    const sig = await program.methods
      .updateRootViaProof({
        proofA: Array.from(fProofA),
        proofB: Array.from(fProofB),
        proofC: Array.from(fProofC),
        oldRoot: Array.from(fOldRoot),
        newRoot: Array.from(fNewRoot),
        startIndex: new (require("bn.js"))(fStartIndex.toString()),
        commitments: fCommitments,
      } as any)
      .accounts({
        forester: payer.publicKey,
        poolConfig: pool,
        verifierKey: vk,
        mint,
        merkleTree: tree,
      })
      .rpc({ commitment: "confirmed", skipPreflight: false });
    foresterSig = sig;
    console.log("  update_root_via_proof sig:", sig);
    const r = await connection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const cu = extractCU(r?.meta?.logMessages ?? undefined);
    console.log("  CU consumed:", cu);
    console.log("  >>> REAL FORESTER FOLD VERIFIED ON-CHAIN <<<");
    results.push({ label: "update_root_via_proof (real)", sig, cu });

    const treeAcct = await connection.getAccountInfo(tree);
    const offset_ni = 8 + 2048 + 32 + 32 + 32;
    const offset_root = 8 + 2048 + 32 + 32;
    const niAfter = treeAcct!.data.readBigUInt64LE(offset_ni);
    const rootAfter = treeAcct!.data.subarray(offset_root, offset_root + 32);
    console.log("  tree.next_index :", niAfter.toString());
    console.log("  tree.root       :", rootAfter.toString("hex"));
  } catch (e: any) {
    const logs: string[] | undefined =
      e?.logs ?? e?.transactionLogs ?? e?.simulationResponse?.logs;
    console.log("  update_root_via_proof FAILED:", e?.message || String(e));
    if (logs) for (const l of logs) console.log("    ", l);
    results.push({
      label: "update_root_via_proof (real)",
      error: e?.message || String(e),
      logs,
    });
  }

  // ============================================================
  //  [7/7] WITHDRAW with a REAL transfer-circuit proof.
  //
  //  Witness shape:
  //    input_0  : amount=DEPOSIT_AMOUNT, leaf_index=0, sk, blinding (the deposit)
  //               sibling path = all Z[d] (since leaves 1..3 are 0 and the tree
  //               beyond depth 1 is all-zero subtrees)
  //    input_1  : dummy (amount=0)
  //    output_0 : dummy (amount=0)
  //    output_1 : dummy (amount=0)
  //    public_amount = +DEPOSIT_AMOUNT  (withdraw → positive)
  // ============================================================
  console.log("\n[7/7a] withdraw — build transfer-circuit witness + proof");

  // Dummy input #1 — matches the canonical dummy used by the Rust prover
  // (sk=2, blinding=102, leaf_index=0, all-zero path).
  const dummySk1 = 2n;
  const dummyBl1 = 102n;
  const dummyLeafIdx1 = 0n;
  const dummyOwnerPk1 = await H([dummySk1]);
  const dummyInCommit1 = await H([0n, assetId, dummyOwnerPk1, dummyBl1]);
  const dummyInNf1 = await H([dummySk1, dummyInCommit1, dummyLeafIdx1]);

  // Real input #0 — must match what we deposited.
  const realInNf = await H([sk, realCommit, 0n]);

  // Dummy outputs — both amount=0. Owner = ownerPk for both.
  const outBlinding0 = 88888n;
  const outBlinding1 = 88889n;
  const outCommit0 = await H([0n, assetId, ownerPk, outBlinding0]);
  const outCommit1 = await H([0n, assetId, ownerPk, outBlinding1]);

  // public_amount = +DEPOSIT_AMOUNT (positive = withdraw per circuit
  // convention: sum(inputs) === sum(outputs) + public_amount).
  const publicAmount = DEPOSIT_AMOUNT_CIRCUIT.toString();

  // Sibling path for inclusion proof of leaf 0 (after forester fold).
  // Leaves 1..3 are all 0; beyond that the subtrees are all-zero.
  // So at depth 0 sibling = 0 (== Z[0]), at depth d>=1 sibling = Z[d].
  const realInputPath = Z.slice(0, TREE_DEPTH); // all Z[d]

  const txInput = {
    // public
    root: newRoot,
    inputNullifier: [realInNf, dummyInNf1],
    outputCommitment: [outCommit0, outCommit1],
    publicAmount,
    assetId,
    extDataHash: "0",
    // private
    inAmount: [DEPOSIT_AMOUNT_CIRCUIT.toString(), "0"],
    inBlinding: [blinding.toString(), dummyBl1.toString()],
    inPrivateKey: [sk.toString(), dummySk1.toString()],
    inLeafIndex: ["0", "0"],
    inPathElements: [realInputPath, Array(TREE_DEPTH).fill("0")],
    outAmount: ["0", "0"],
    outBlinding: [outBlinding0.toString(), outBlinding1.toString()],
    outOwnerPubkey: [ownerPk, ownerPk],
  };

  const txInputPath = path.join(__dirname, "_tmp_tx_input.json");
  const txWtnsPath = path.join(__dirname, "_tmp_tx.wtns");
  const txProofPath = path.join(__dirname, "_tmp_tx_proof.json");
  const txPublicPath = path.join(__dirname, "_tmp_tx_public.json");
  fs.writeFileSync(txInputPath, JSON.stringify(txInput, null, 2));

  console.log("  generating witness…");
  const txWasm = path.join(ARTIFACTS_DIR, "transaction_js", "transaction.wasm");
  try {
    await snarkjs.wtns.calculate(txInput, txWasm, txWtnsPath);
  } catch (e: any) {
    console.log("  witness calculation FAILED:", e?.message || String(e));
    results.push({
      label: "withdraw witness",
      error: e?.message || String(e),
    });
    return await finalize(connection, payer, initialBalance, {
      mint,
      escrow: escrowAddr,
      tree,
    });
  }

  console.log("  generating Groth16 proof…");
  const txZkey = path.join(CEREMONY_DIR, "transaction_final.zkey");
  const { proof: txProof, publicSignals: txPublics } =
    await snarkjs.groth16.prove(txZkey, txWtnsPath);
  fs.writeFileSync(txProofPath, JSON.stringify(txProof, null, 2));
  fs.writeFileSync(txPublicPath, JSON.stringify(txPublics, null, 2));
  console.log("  public signals:");
  console.log("    root         :", txPublics[0]);
  console.log("    in_nf_0      :", txPublics[1]);
  console.log("    in_nf_1      :", txPublics[2]);
  console.log("    out_cm_0     :", txPublics[3]);
  console.log("    out_cm_1     :", txPublics[4]);
  console.log("    public_amount:", txPublics[5]);
  console.log("    asset_id     :", txPublics[6]);
  console.log("    ext_data_hash:", txPublics[7]);

  // ------------------------------------------------------------
  //  Patched withdraw handler now takes the second-input nullifier
  //  (`inputNullifier[1]`, the dummy's computed nullifier) as an
  //  explicit arg `input_nullifier_1` so the on-chain public-input
  //  vector matches the prover's. We pass txPublics[2] through.
  // ------------------------------------------------------------

  console.log("\n[7/7b] submit withdraw");
  // Create a fresh recipient + their ATA.
  const recipientKp = Keypair.generate();
  const recipientAta = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mint,
    recipientKp.publicKey,
    false,
    "confirmed",
    undefined,
    TOKEN_PROGRAM_ID
  );
  console.log("  recipient    :", recipientKp.publicKey.toBase58());
  console.log("  recipient ATA:", recipientAta.address.toBase58());

  const recipientBalBefore = (
    await connection.getTokenAccountBalance(recipientAta.address)
  ).value.amount;
  const escrowBalBeforeWd = (
    await connection.getTokenAccountBalance(escrowAddr)
  ).value.amount;
  console.log("  recipient ATA BEFORE :", recipientBalBefore);
  console.log("  escrow ATA BEFORE    :", escrowBalBeforeWd);

  // Build withdraw args. The "real" nullifier goes in args.nullifier; the
  // dummy-input nullifier (txPublics[2]) goes in args.input_nullifier_1.
  const wdRoot = bigintToBE32(BigInt(txPublics[0]));
  const wdNullifier = bigintToBE32(BigInt(txPublics[1]));
  const wdInputNullifier1 = bigintToBE32(BigInt(txPublics[2]));
  const wdChangeCommit = bigintToBE32(BigInt(txPublics[3]));
  const wdPadCommit = bigintToBE32(BigInt(txPublics[4]));
  const wdPublicAmount = bigintToBE32(BigInt(txPublics[5]));
  const wdAssetId = bigintToBE32(BigInt(txPublics[6]));
  const wdExtData = bigintToBE32(BigInt(txPublics[7]));

  const wdProofA = g1NegToBE64(txProof.pi_a);
  const wdProofB = g2ToBE128(txProof.pi_b);
  const wdProofC = g1ToBE64(txProof.pi_c);

  // Withdraw expects a change_commitment PDA at the CURRENT tree.next_index
  // (which is 4 after the forester fold).
  let nextIndexForWd: bigint;
  {
    const treeAcct = await connection.getAccountInfo(tree);
    const offset = 8 + 2048 + 32 + 32 + 32;
    nextIndexForWd = treeAcct!.data.readBigUInt64LE(offset);
    console.log("  tree.next_index for change_commitment PDA:", nextIndexForWd.toString());
  }
  const [changeCommitPda] = commitmentPda(tree, nextIndexForWd);
  const [nullifierAcct] = nullifierPda(mint, wdNullifier);

  const withdrawMethod = program.methods
    .withdraw({
      proofA: Array.from(wdProofA),
      proofB: Array.from(wdProofB),
      proofC: Array.from(wdProofC),
      root: Array.from(wdRoot),
      nullifier: Array.from(wdNullifier),
      changeCommitment: Array.from(wdChangeCommit),
      amount: new (require("bn.js"))(DEPOSIT_AMOUNT.toString()),
      relayerFee: new (require("bn.js"))(0),
      publicAmount: Array.from(wdPublicAmount),
      assetId: Array.from(wdAssetId),
      extDataHash: Array.from(wdExtData),
      paddingCommitment: Array.from(wdPadCommit),
      inputNullifier1: Array.from(wdInputNullifier1),
    } as any)
    .accounts({
      payer: payer.publicKey,
      poolConfig: pool,
      verifierKey: vk,
      mint,
      merkleTree: tree,
      nullifier: nullifierAcct,
      changeCommitment: changeCommitPda,
      escrow: escrowAddr,
      recipientTokenAccount: recipientAta.address,
      relayerTokenAccount: recipientAta.address, // unused (fee=0); same as recipient
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    });

  try {
    const relayerUrl = relayBaseUrl();
    if (relayerUrl) {
      console.log("  submitting via relayer:", relayerUrl);
      const ix = await withdrawMethod.instruction();
      const relayerId = await relayWithdraw(relayerUrl, ix, {
        recipient: recipientAta.address,
        fee: 0n,
        relayerFee: 0n,
        proofA: wdProofA,
        proofB: wdProofB,
        proofC: wdProofC,
        root: wdRoot,
        nullifier0: wdNullifier,
        nullifier1: wdInputNullifier1,
        changeCommitment: wdChangeCommit,
        paddingCommitment: wdPadCommit,
        publicAmount: wdPublicAmount,
        assetId: wdAssetId,
        extDataHash: wdExtData,
      });
      results.push({ label: "withdraw", sig: `relayer:${relayerId}`, cu: "relayer" });
    } else {
      const sig = await withdrawMethod.rpc({ commitment: "confirmed", skipPreflight: false });
      console.log("  withdraw sig:", sig);
      const r = await connection.getTransaction(sig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      const cu = extractCU(r?.meta?.logMessages ?? undefined);
      console.log("  CU consumed:", cu);
      results.push({ label: "withdraw", sig, cu });
    }

    const recipientBalAfter = (
      await connection.getTokenAccountBalance(recipientAta.address)
    ).value.amount;
    const escrowBalAfter = (
      await connection.getTokenAccountBalance(escrowAddr)
    ).value.amount;
    console.log("  recipient ATA AFTER  :", recipientBalAfter);
    console.log("  escrow ATA AFTER     :", escrowBalAfter);
    console.log(
      "  recipient delta      :",
      BigInt(recipientBalAfter) - BigInt(recipientBalBefore)
    );
  } catch (e: any) {
    const logs: string[] | undefined =
      e?.logs ?? e?.transactionLogs ?? e?.simulationResponse?.logs;
    console.log("  withdraw FAILED:", e?.message || String(e));
    if (logs) {
      console.log("  --- program logs ---");
      for (const l of logs) console.log("    ", l);
      console.log("  --------------------");
    }
    results.push({
      label: "withdraw",
      error: e?.message || String(e),
      logs,
    });
  }

  await finalize(connection, payer, initialBalance, {
    mint,
    escrow: escrowAddr,
    tree,
  });
}

async function finalize(
  connection: Connection,
  payer: Keypair,
  initialBalance: number,
  ctx: { mint: PublicKey; escrow: PublicKey; tree: PublicKey }
) {
  console.log("\n=========================================");
  console.log("RESULTS");
  console.log("=========================================");
  for (const r of results) {
    if (r.error) {
      console.log(`  ${r.label}: FAILED — ${r.error}`);
    } else {
      console.log(`  ${r.label}: OK  sig=${r.sig}  cu=${r.cu}`);
    }
  }
  const finalBalance = await connection.getBalance(payer.publicKey);
  console.log(
    `\nPayer SOL: ${(initialBalance / 1e9).toFixed(6)} -> ${(
      finalBalance / 1e9
    ).toFixed(6)} (Δ ${((finalBalance - initialBalance) / 1e9).toFixed(6)})`
  );

  const outPath = path.join(__dirname, "full_loop_devnet.result.json");
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        program_id: PROGRAM_ID.toBase58(),
        payer: payer.publicKey.toBase58(),
        mint: ctx.mint.toBase58(),
        escrow: ctx.escrow.toBase58(),
        merkle_tree: ctx.tree.toBase58(),
        results,
        sol_delta: (finalBalance - initialBalance) / 1e9,
      },
      null,
      2
    )
  );
  console.log("Wrote", outPath);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FATAL:", e);
    process.exit(1);
  });
