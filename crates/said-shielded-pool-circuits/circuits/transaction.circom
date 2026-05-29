pragma circom 2.1.5;

// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
// !! H1 VALUE-CONSERVATION RANGE CONSTRAINTS ADDED 2026-05-25.          !!
// !!                                                                    !!
// !! This circuit's CONSTRAINT SYSTEM CHANGED. The previously-generated !!
// !! proving + verifying keys are now INVALID:                          !!
// !!   * crates/said-shielded-pool-circuits/ceremony/transaction_*.zkey !!
// !!   * the compiled-in `VERIFYING_KEY` in                             !!
// !!     programs/said-shielded-pool/src/verifying_key.rs               !!
// !! BOTH no longer match this circuit. Proofs against the old keys     !!
// !! will FAIL to verify, and (worse) the old keys do NOT enforce the   !!
// !! new range checks. The proving + verifying keys MUST be regenerated !!
// !! via a fresh MULTI-PARTY TRUSTED-SETUP CEREMONY (≥10 contributors,  !!
// !! per SPEC.md §13) before ANY deploy. Do NOT ship a binary whose     !!
// !! compiled-in VK predates this change.                               !!
// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/bitify.circom";
include "node_modules/circomlib/circuits/comparators.circom";

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
 * represented as `FIELD - |v|`, i.e. the field-element negation), matching
 * `said-shielded-pool-client::tx_builder::encode_public_amount` and the
 * prover's `encode_signed_public_amount`:
 *   * deposit  (value enters pool): publicAmount = r - amount   ∈ (r-2^64, r)
 *   * withdraw (value leaves pool): publicAmount =  amount      ∈ [0, 2^64)
 *   * transfer (no net flow):       publicAmount =  0
 *
 * Derivation (the authoritative source — do NOT re-invert this): conservation
 * is `sum(inputs) === sum(outputs) + publicAmount` (enforced below).
 *   - deposit:  inputs=0, outputs=+amount → publicAmount = -amount = r-amount.
 *   - withdraw: inputs=+amount, outputs=0 → publicAmount = +amount.
 * This matches circuits/tools/build_deposit_input.js, the working witness
 * generator. (An earlier version of THIS header had deposit/withdraw swapped
 * — that was the documentation bug; the equation below is correct.)
 *
 * H1 (2026-05-25): the conservation check is now SOUND in-circuit:
 *   - `publicAmount` is range-constrained to the signed-64-bit envelope
 *     above (its magnitude fits 64 bits in exactly one of the two halves),
 *     so it can no longer be an arbitrary field element chosen to wrap r.
 *   - `inSumAccum`/`outSumAccum` are range-constrained to 65 bits
 *     (64 + ceil(log2(nIns=2))), so neither side can reach the field
 *     modulus, and `sumIn === sumOut + publicAmount` cannot wrap mod r.
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

/*
 * Compile-time helper: number of bits needed to bound a sum of `n` values
 * that are each < 2^64 without any field wrap, i.e. 64 + ceil(log2(n)).
 * `n` is a circom compile-time parameter, so this resolves at compile time.
 */
function sumBits(n) {
    var extra = 0;
    var pow = 1;        // 2^extra
    while (pow < n) {
        pow = pow * 2;
        extra = extra + 1;
    }
    return 64 + extra;  // ceil(log2(n)) extra bits over the 64-bit elements
}

/*
 * Range-constrain a SIGNED public amount to the protocol's signed-64-bit
 * envelope. The witness supplies:
 *   - `isNeg`  : 1 iff `in` is the field-negation of a positive magnitude
 *                (i.e. a withdraw), else 0.
 *   - `magnitude`: |in|, which MUST fit in 64 bits.
 * and the template enforces:
 *   - `isNeg ∈ {0,1}`,
 *   - `magnitude < 2^64` (Num2Bits),
 *   - `in == magnitude`            when isNeg == 0   (deposit / transfer)
 *   - `in == -magnitude` (= r-mag) when isNeg == 1   (withdraw)
 * Net effect: `in ∈ [0, 2^64) ∪ (r - 2^64, r)`. Arbitrary field values
 * (the H1 wrap vector) are rejected. magnitude==0 is valid under either
 * isNeg and yields in==0 (the pure-transfer case), which is fine.
 */
template SignedAmount64() {
    signal input in;
    signal input isNeg;       // witness hint (boolean)
    signal input magnitude;   // witness hint (|in|, < 2^64)

    // isNeg is boolean.
    isNeg * (isNeg - 1) === 0;

    // magnitude fits in 64 bits.
    component magBits = Num2Bits(64);
    magBits.in <== magnitude;

    // Select the signed value: (1 - 2*isNeg) * magnitude.
    //   isNeg = 0 ->  +magnitude
    //   isNeg = 1 ->  -magnitude  (field element r - magnitude)
    signal signed;
    signed <== (1 - 2 * isNeg) * magnitude;
    in === signed;
}

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

    // H1 (2026-05-25): signed-amount range-check witness hints.
    //   publicAmountIsNeg      = 1 iff publicAmount encodes a withdraw
    //                            (field-negation of a positive magnitude).
    //   publicAmountMagnitude  = |publicAmount| as an unsigned < 2^64 value.
    // The prover/witness builder MUST set these consistently with
    // `publicAmount`; the `SignedAmount64` template below enforces the
    // relation, so a lying witness simply fails to satisfy the constraints.
    signal input publicAmountIsNeg;
    signal input publicAmountMagnitude;

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

    // ============================================================
    //  H1: signed-64-bit range check on publicAmount.
    // ============================================================
    // Constrains publicAmount ∈ [0, 2^64) ∪ (r - 2^64, r). Without this a
    // prover could choose a publicAmount near r so the conservation
    // equation below wraps mod r and forges value.
    component publicAmountRange = SignedAmount64();
    publicAmountRange.in        <== publicAmount;
    publicAmountRange.isNeg     <== publicAmountIsNeg;
    publicAmountRange.magnitude <== publicAmountMagnitude;

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
    //  H1: range-check the input/output sums so conservation can't wrap.
    // ============================================================
    // Each amount is already < 2^64, so a sum of `nIns` (resp. `nOuts`)
    // of them is < nIns * 2^64 <= 2^sumBits. Constraining the sums to
    // exactly `sumBits = 64 + ceil(log2(n))` bits proves they never reach
    // 2^sumBits, hence stay far below the field modulus r (~2^254). With
    // publicAmount also bounded to the signed-64-bit envelope above, the
    // equality `sumIn === sumOut + publicAmount` below is exact integer
    // arithmetic — it cannot be satisfied by a mod-r wrap.
    component inSumBits = Num2Bits(sumBits(nIns));
    inSumBits.in <== inSumAccum[nIns];
    component outSumBits = Num2Bits(sumBits(nOuts));
    outSumBits.in <== outSumAccum[nOuts];

    // ============================================================
    //  Value conservation (per-asset, signed arithmetic)
    //    sum(inAmount) === sum(outAmount) + publicAmount
    // ============================================================
    // H1 (2026-05-25): SOUND. `publicAmount` is range-bounded to the
    // signed-64-bit envelope (SignedAmount64 above) and both sums are
    // range-bounded to `sumBits` (above), so this equality holds over the
    // integers, not just mod r — no wrap is possible.
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
