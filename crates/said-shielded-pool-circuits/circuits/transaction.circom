pragma circom 2.1.5;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/comparators.circom";

include "./keypair.circom";
include "./commitment.circom";
include "./merkleProof.circom";

/*
 * Ghola SAID shielded-pool transaction circuit.
 *
 * Topology: 2-in / 2-out UTXO transfer with a single shared `asset_id` per
 * proof and a signed `public_amount` for deposit/withdraw.
 *
 *   sum(input_amounts) === sum(output_amounts) + public_amount
 *
 * `public_amount` is encoded as an in-field signed value (negative values are
 * represented as `FIELD - |v|`, i.e. the field-element negation). The
 * circuit performs the conservation check in the field — the caller is
 * responsible for range-checking `public_amount` off-circuit against the
 * platform's signed-64-bit envelope.
 *
 * PUBLIC INPUTS (in order, must match `said-shielded-pool-types::PublicInputs`):
 *   [0] root
 *   [1] input_nullifier_0
 *   [2] input_nullifier_1
 *   [3] output_commitment_0
 *   [4] output_commitment_1
 *   [5] public_amount
 *   [6] asset_id
 *   [7] ext_data_hash
 *
 * `ext_data_hash` is a binding-only public signal: it is referenced inside
 * the circuit (so the Groth16 proof is bound to its value) but is NOT
 * recomputed from any other signals. It commits the proof to off-circuit
 * data (recipient, relayer fee, memo, etc.) and prevents proof malleability.
 */

template Transaction(levels, nIns, nOuts) {
    // --------- PUBLIC INPUTS ---------
    signal input root;
    signal input inputNullifier[nIns];
    signal input outputCommitment[nOuts];
    signal input publicAmount;
    signal input assetId;
    signal input extDataHash;

    // --------- PRIVATE INPUTS ---------
    // Per-input note data + spend authorization + membership witness
    signal input inAmount[nIns];
    signal input inBlinding[nIns];
    signal input inPrivateKey[nIns];
    signal input inLeafIndex[nIns];
    signal input inPathElements[nIns][levels];

    // Per-output note data
    signal input outAmount[nOuts];
    signal input outBlinding[nOuts];
    signal input outOwnerPubkey[nOuts];

    // ============================================================
    //  ext_data_hash binding
    // ============================================================
    // Force the proof to depend on extDataHash without constraining its
    // value. Squaring is a cheap way to introduce a real constraint.
    signal extDataHashSquared;
    extDataHashSquared <== extDataHash * extDataHash;

    // ============================================================
    //  Range-check all amounts to 64 bits (per SPEC.md §6.3)
    // ============================================================
    component inAmountBits[nIns];
    for (var i = 0; i < nIns; i++) {
        inAmountBits[i] = Num2Bits(64);
        inAmountBits[i].in <== inAmount[i];
    }
    component outAmountBits[nOuts];
    for (var o = 0; o < nOuts; o++) {
        outAmountBits[o] = Num2Bits(64);
        outAmountBits[o].in <== outAmount[o];
    }

    // !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
    // SECURITY TODO (H1) — UNDER-CONSTRAINED VALUE CONSERVATION.
    //
    // Only the per-note amounts are range-checked above (each < 2^64).
    // The SUM accumulators `inSumAccum`/`outSumAccum` and `publicAmount`
    // are NOT range-checked, and the conservation equation at the bottom
    // (`inSum === outSum + publicAmount`) is evaluated in the BN254 field
    // (modulus r ≈ 2^254). With nIns=2 the input sum can reach ~2^65 and
    // `publicAmount` is a free field element, so an attacker can pick a
    // `publicAmount` near r that makes the equation wrap and manufacture
    // value. THIS MUST BE FIXED before mainnet by adding:
    //   * `Num2Bits(65)` (or a `LessThan`) on inSumAccum[nIns] and
    //     outSumAccum[nOuts], and
    //   * a signed-range check on `publicAmount` (e.g. constrain it into
    //     the [-(2^64-1), 2^64-1] signed-64 envelope: range-check both
    //     `publicAmount` and `r - publicAmount` to <= 2^64 bits).
    // Fixing this requires recompiling the circuit + redoing the
    // trusted-setup ceremony, which is OUT OF SCOPE for this code change.
    //
    // COMPENSATING ON-CHAIN CONTROLS NOW IN PLACE (defense-in-depth, not
    // a substitute for the circuit fix):
    //   * `withdraw` recomputes `public_amount = encode(-(amount))` from a
    //     u64 `amount` (so a withdraw's public_amount is bounded to a
    //     valid 64-bit negation) and binds escrow payout to it (C1).
    //   * `transfer` forces `public_amount == 0`.
    //   * every public input is checked to be a CANONICAL field element
    //     (< r) on-chain (H2), removing the non-canonical wrap freedom.
    // These bound the *settlement* side but do NOT make the circuit sound
    // on their own — internal note value can still wrap. Treat H1 as OPEN.
    // !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

    // ============================================================
    //  INPUTS: derive owner_pubkey, commitment, nullifier; verify membership
    // ============================================================
    component inKeypair[nIns];
    component inCommitment[nIns];
    component inNullifier[nIns];
    component inMerkle[nIns];

    // Zero-amount inputs skip membership verification (dummy / padding notes).
    // We implement this by checking either:
    //   * inAmount[i] == 0      (dummy: any path is fine), or
    //   * computed_root == root (real input: must be in the tree)
    // To keep the constraint system simple we use IsZero on the amount and
    // require (1 - isZero) * (computed_root - root) === 0.
    component inAmountIsZero[nIns];

    signal inSumAccum[nIns + 1];
    inSumAccum[0] <== 0;

    for (var i = 0; i < nIns; i++) {
        inKeypair[i] = Keypair();
        inKeypair[i].privateKey <== inPrivateKey[i];

        inCommitment[i] = Commitment();
        inCommitment[i].amount      <== inAmount[i];
        inCommitment[i].assetId     <== assetId;
        inCommitment[i].ownerPubkey <== inKeypair[i].publicKey;
        inCommitment[i].blinding    <== inBlinding[i];

        inNullifier[i] = Nullifier();
        inNullifier[i].nullifyingKey <== inPrivateKey[i];
        inNullifier[i].commitment    <== inCommitment[i].commitment;
        inNullifier[i].leafIndex     <== inLeafIndex[i];

        // Bind computed nullifier to the public signal
        inNullifier[i].nullifier === inputNullifier[i];

        inMerkle[i] = MerkleProof(levels);
        inMerkle[i].leaf      <== inCommitment[i].commitment;
        inMerkle[i].leafIndex <== inLeafIndex[i];
        for (var j = 0; j < levels; j++) {
            inMerkle[i].pathElements[j] <== inPathElements[i][j];
        }

        // Real inputs must be in the tree; dummy (amount == 0) inputs skip.
        inAmountIsZero[i] = IsZero();
        inAmountIsZero[i].in <== inAmount[i];
        (1 - inAmountIsZero[i].out) * (inMerkle[i].root - root) === 0;

        inSumAccum[i + 1] <== inSumAccum[i] + inAmount[i];
    }

    // ============================================================
    //  OUTPUTS: build commitments; enforce shared asset_id
    // ============================================================
    component outCommitment[nOuts];

    signal outSumAccum[nOuts + 1];
    outSumAccum[0] <== 0;

    for (var o = 0; o < nOuts; o++) {
        outCommitment[o] = Commitment();
        outCommitment[o].amount      <== outAmount[o];
        outCommitment[o].assetId     <== assetId;
        outCommitment[o].ownerPubkey <== outOwnerPubkey[o];
        outCommitment[o].blinding    <== outBlinding[o];

        outCommitment[o].commitment === outputCommitment[o];

        outSumAccum[o + 1] <== outSumAccum[o] + outAmount[o];
    }

    // ============================================================
    //  Distinct nullifiers (prevent double-spend within one tx)
    // ============================================================
    // For 2-in we just enforce nullifier_0 != nullifier_1.
    component nullifiersDistinct = IsEqual();
    nullifiersDistinct.in[0] <== inputNullifier[0];
    nullifiersDistinct.in[1] <== inputNullifier[1];
    nullifiersDistinct.out === 0;

    // ============================================================
    //  Value conservation (per-asset, in-field signed arithmetic)
    //    sum(inAmount) === sum(outAmount) + publicAmount
    // ============================================================
    // SECURITY TODO (H1): this equality is checked mod r with NO range
    // bound on the sums or `publicAmount` — see the large warning block
    // above. Add Num2Bits/LessThan range checks on inSumAccum[nIns],
    // outSumAccum[nOuts], and the signed `publicAmount` before mainnet
    // (requires circuit recompile + ceremony).
    inSumAccum[nIns] === outSumAccum[nOuts] + publicAmount;
}

component main { public [
    root,
    inputNullifier,
    outputCommitment,
    publicAmount,
    assetId,
    extDataHash
] } = Transaction(26, 2, 2);
