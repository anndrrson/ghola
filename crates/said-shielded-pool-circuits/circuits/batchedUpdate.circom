pragma circom 2.1.5;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/bitify.circom";
include "node_modules/circomlib/circuits/mux1.circom";

include "./merkleProof.circom";

/*
 * Ghola SAID shielded-pool BATCHED COMMITMENT-INSERTION circuit.
 *
 * Proves: starting from a depth-`levels` Poseidon-BN254 Merkle tree whose
 * root is `oldRoot` and whose next-free leaf index is `startIndex`,
 * inserting `commitment[0..batchSize-1]` at positions
 * `startIndex .. startIndex+batchSize-1` (in order) yields a tree with
 * root `newRoot`.
 *
 * At every position `startIndex+i` the *current* leaf (before this insert)
 * MUST be the zero field element — we're appending into empty slots. This
 * is enforced by re-deriving the running root from the same sibling-path
 * with a zero leaf and checking it matches the running root.
 *
 * PUBLIC INPUTS (canonical order, padded with one zero to keep
 * NUM_PUBLIC_INPUTS = 8 on-chain — see programs/said-shielded-pool/src/state.rs):
 *   [0] oldRoot
 *   [1] newRoot
 *   [2] startIndex
 *   [3] commitment[0]
 *   [4] commitment[1]
 *   [5] commitment[2]
 *   [6] commitment[3]
 *   [7] _pad   (must be 0; binding-only)
 *
 * PRIVATE INPUTS (per step i ∈ [0, batchSize)):
 *   pathElements[i][levels]   sibling path at leaf position startIndex+i
 *                             in the tree state JUST BEFORE step i.
 *
 * Subtlety:
 *   When two consecutive inserts share a sibling subtree (the two leaves
 *   are neighbours under some ancestor), the sibling path of step i+1
 *   differs from step i. The witness builder
 *   (`crates/said-shielded-pool-indexer/src/forester/witness.rs`) snapshots
 *   the path BEFORE each step, so the circuit just consumes them
 *   independently — no cross-step sibling reconciliation needed inside
 *   the constraint system.
 */
template BatchedUpdate(levels, batchSize) {
    // --------- PUBLIC INPUTS ---------
    signal input oldRoot;
    signal input newRoot;
    signal input startIndex;
    signal input commitment[batchSize];
    signal input pad;

    // --------- PRIVATE INPUTS ---------
    signal input pathElements[batchSize][levels];

    // ============================================================
    //  Padding binding: force the proof to depend on `pad` without
    //  constraining its semantic meaning. Squaring `pad` and asserting
    //  it equals zero pins pad to 0 (so the on-chain wrapper can pass
    //  a literal zero for the unused 8th public input).
    // ============================================================
    signal padSquared;
    padSquared <== pad * pad;
    pad === 0;

    // ============================================================
    //  Step-by-step: chain the running root.
    //    runningRoot[0] === oldRoot
    //    runningRoot[i+1] = root after inserting commitment[i]
    //    runningRoot[batchSize] === newRoot
    //
    //  Each step uses two `MerkleProof` instances over the SAME sibling
    //  path:
    //    (a) leaf = 0           → root_before  ; must equal runningRoot[i]
    //    (b) leaf = commitment[i] → root_after ; becomes runningRoot[i+1]
    //
    //  This simultaneously proves:
    //    - the slot was empty (root_before == runningRoot[i])
    //    - inserting `commitment[i]` produces the expected next root
    // ============================================================
    component beforeProof[batchSize];
    component afterProof[batchSize];

    signal runningRoot[batchSize + 1];
    runningRoot[0] <== oldRoot;

    for (var i = 0; i < batchSize; i++) {
        beforeProof[i] = MerkleProof(levels);
        beforeProof[i].leaf      <== 0;
        beforeProof[i].leafIndex <== startIndex + i;
        for (var j = 0; j < levels; j++) {
            beforeProof[i].pathElements[j] <== pathElements[i][j];
        }
        // Enforce: the slot at startIndex+i was empty in runningRoot[i].
        beforeProof[i].root === runningRoot[i];

        afterProof[i] = MerkleProof(levels);
        afterProof[i].leaf      <== commitment[i];
        afterProof[i].leafIndex <== startIndex + i;
        for (var j = 0; j < levels; j++) {
            afterProof[i].pathElements[j] <== pathElements[i][j];
        }

        runningRoot[i + 1] <== afterProof[i].root;
    }

    // ============================================================
    //  Final equality: the running root after all batchSize inserts
    //  must match the public `newRoot`.
    // ============================================================
    runningRoot[batchSize] === newRoot;
}

component main { public [
    oldRoot,
    newRoot,
    startIndex,
    commitment,
    pad
] } = BatchedUpdate(26, 4);
