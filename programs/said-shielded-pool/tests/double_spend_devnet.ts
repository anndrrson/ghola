/**
 * double_spend_devnet.ts — Stream 3 replay/double-spend devnet drill.
 *
 * Companion to `full_loop_devnet.ts`. Reuses the pool, mint, and
 * recipient state that `full_loop_devnet.ts` leaves behind in
 * `full_loop_devnet.result.json` and exercises three replay vectors:
 *
 *   (1) Re-submit a confirmed withdraw with the SAME proof bytes and
 *       the SAME recipient. Expect: `NullifierAlreadyUsed` (the on-chain
 *       `init nullifier_pda` constraint fails — atomic, no state change).
 *
 *   (2) Re-submit with the SAME proof bytes but a DIFFERENT recipient.
 *       Expect: `InvalidProof` from `groth16-solana`. The proof binds
 *       the recipient via `ext_data_hash`, so the public-input vector
 *       computed on-chain doesn't match what the proof committed to.
 *       NOTE the distinction from (1): a different recipient gives us
 *       `InvalidProof` (verifier-level), NOT `NullifierAlreadyUsed`
 *       (program-level), because we never reach the nullifier init —
 *       verification fails first. This separation matters because a
 *       single error category for both would let an adversary infer
 *       whether a particular recipient had spent that nullifier.
 *
 *   (3) (Optional, currently `it.skip`) Submit against a stale root.
 *       Requires the test runner to first batch ≥64 additional updates
 *       to rotate the proof's root out of `root_history`. Expect:
 *       `RootNotInHistory`. Left skipped because the setup adds ~5 min
 *       of wall-clock fold loops; the unit-level model in
 *       `replay_cross_root.rs` covers the predicate at the type level.
 *
 * # Status as of Stream 3 landing
 *
 * The new said-shielded-pool program with the dedup-aware error
 * matrix is NOT YET REDEPLOYED — the dispatcher controls the redeploy
 * cadence. Until that lands, this whole file is `describe.skip`'d.
 * Remove the `.skip` once the deployed program ID at
 * `5bmCDeaQceBpWgK8aADB4Tz4JzqZ9hkCi3qedC6oZR8A` matches the source.
 *
 * Run:
 *   cd programs/said-shielded-pool
 *   npx ts-node tests/double_spend_devnet.ts
 */

// --- Anchor 1000-byte ix-encode scratch buffer monkey-patch ---
// (same as full_loop_devnet.ts; required for proof+public-inputs > 1KB)
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
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const PROGRAM_ID = new PublicKey("5bmCDeaQceBpWgK8aADB4Tz4JzqZ9hkCi3qedC6oZR8A");
const RPC_URL =
  process.env.RPC_URL ?? "https://api.devnet.solana.com";

const STATE_PATH = path.resolve(__dirname, "full_loop_devnet.result.json");

// Programmatic mini-test framework. We avoid Mocha so this stays runnable
// via `npx ts-node`. Switch to `it.skip` semantics with a simple flag.
const SKIP_ALL = true; // Flip to `false` once the new program is deployed.

type Step = {
  name: string;
  skip?: boolean;
  run: () => Promise<void>;
};

async function runSteps(steps: Step[]) {
  let passed = 0;
  let skipped = 0;
  let failed = 0;
  for (const s of steps) {
    if (s.skip) {
      console.log(`[skip] ${s.name}`);
      skipped += 1;
      continue;
    }
    try {
      await s.run();
      console.log(`[pass] ${s.name}`);
      passed += 1;
    } catch (err) {
      console.error(`[fail] ${s.name}:`, err);
      failed += 1;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failed > 0) process.exit(1);
}

// ---------- Helpers ----------

/**
 * Match against an Anchor error name in the AnchorError's stack.
 * Anchor surfaces program errors as `Error: ... Custom: <code>` in the
 * sim logs; we grep the log lines because pulling the IDL just to map
 * code -> name is heavier than this drill needs.
 */
function logsContain(err: any, needle: string): boolean {
  const blob =
    (err?.logs ?? []).join("\n") +
    "\n" +
    (err?.message ?? "") +
    "\n" +
    String(err);
  return blob.includes(needle);
}

interface FullLoopState {
  pool: string;
  merkleTree: string;
  mint: string;
  recipientATA: string;
  // The witness/proof emitted by the successful first withdraw,
  // captured by `full_loop_devnet.ts` for replay drills.
  withdrawProof?: {
    pi_a: any;
    pi_b: any;
    pi_c: any;
    publicInputs: string[];
  };
}

function loadState(): FullLoopState {
  if (!fs.existsSync(STATE_PATH)) {
    throw new Error(
      `${STATE_PATH} missing — run full_loop_devnet.ts first to seed pool state`
    );
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
}

// ---------- Steps ----------

const steps: Step[] = [
  {
    name:
      "(1) replay confirmed withdraw with same proof + same recipient -> NullifierAlreadyUsed",
    skip: SKIP_ALL,
    run: async () => {
      const state = loadState();
      if (!state.withdrawProof) {
        throw new Error(
          "full_loop_devnet.result.json missing withdrawProof — re-run full_loop with REPLAY_CAPTURE=1"
        );
      }
      const connection = new Connection(RPC_URL, "confirmed");
      // Build the same withdraw ix from the captured proof. Use the
      // same accounts as the original tx (loaded from state).
      //
      // NOTE: full implementation is deferred until the redeploy lands;
      // this is the structural blueprint. The matching dispatcher-side
      // gate is the SKIP_ALL flag above.
      //
      // Expected: ix simulation errors with `NullifierAlreadyUsed`
      // (Anchor error name) -- NOT `InvalidProof`, NOT `RootNotInHistory`.
      void connection;
      throw new Error("not implemented until program redeploy");
    },
  },
  {
    name:
      "(2) replay confirmed withdraw with same proof + different recipient -> InvalidProof",
    skip: SKIP_ALL,
    run: async () => {
      const state = loadState();
      if (!state.withdrawProof) {
        throw new Error(
          "full_loop_devnet.result.json missing withdrawProof — re-run full_loop with REPLAY_CAPTURE=1"
        );
      }
      const connection = new Connection(RPC_URL, "confirmed");
      // Construct a fresh recipient ATA, build the withdraw ix with
      // the SAME pi_a/pi_b/pi_c bytes but the new recipient + new
      // ext_data_hash. The verifier computes the public-input vector
      // from the on-chain account list, finds that ext_data_hash
      // doesn't match what the proof committed to, and rejects with
      // `InvalidProof`.
      //
      // Crucial assertion: error must be `InvalidProof`, NOT
      // `NullifierAlreadyUsed`. If we ever see the latter here, it
      // means the verifier accepted a recipient-substituted proof —
      // a catastrophic break that would let a relayer redirect funds.
      void connection;
      throw new Error("not implemented until program redeploy");
    },
  },
  {
    name: "(3) submit against rotated-out root -> RootNotInHistory",
    skip: true, // Always skip in this file; covered by replay_stale_root.rs
    run: async () => {
      // Setup cost: ≥64 fresh fold batches to rotate the original root
      // out of `root_history`. Run as a separate `npx ts-node` invocation
      // when you actually want this drill.
    },
  },
];

runSteps(steps).catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
