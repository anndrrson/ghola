pragma circom 2.1.5;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/mux1.circom";

/*
 * Depth-26 Poseidon Merkle inclusion proof.
 *
 * Each level hashes the current node with its sibling. The position bit
 * (decomposed from `leafIndex`) selects whether `current` is the left or
 * right input to Poseidon(2). This matches the Tornado-Nova / Solana
 * `sol_poseidon`-compatible tree layout used by the SAID shielded pool.
 *
 * The depth-26 tree supports 2^26 ≈ 67M notes, which matches SPEC.md §4.2.
 */
template MerkleProof(levels) {
    signal input leaf;
    signal input pathElements[levels];
    signal input leafIndex;
    signal output root;

    // Decompose leafIndex into `levels` path-selector bits.
    component indexBits = Num2Bits(levels);
    indexBits.in <== leafIndex;

    component hashers[levels];
    component muxLeft[levels];
    component muxRight[levels];

    signal current[levels + 1];
    current[0] <== leaf;

    for (var i = 0; i < levels; i++) {
        // mux selects which input is `current` (left) vs `sibling` (right)
        // based on the i-th path bit.
        //  bit = 0 -> current is left,  sibling is right
        //  bit = 1 -> sibling is left,  current is right
        muxLeft[i]  = Mux1();
        muxRight[i] = Mux1();

        muxLeft[i].c[0]  <== current[i];
        muxLeft[i].c[1]  <== pathElements[i];
        muxLeft[i].s     <== indexBits.out[i];

        muxRight[i].c[0] <== pathElements[i];
        muxRight[i].c[1] <== current[i];
        muxRight[i].s    <== indexBits.out[i];

        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== muxLeft[i].out;
        hashers[i].inputs[1] <== muxRight[i].out;

        current[i + 1] <== hashers[i].out;
    }

    root <== current[levels];
}
