pragma circom 2.1.5;

include "../node_modules/circomlib/circuits/poseidon.circom";

/*
 * Note commitment:
 *   commitment = Poseidon(amount, asset_id, owner_pubkey, blinding)
 *
 * The note tuple `(amount, asset_id, owner_pubkey, blinding)` is the canonical
 * shielded-pool note for the Ghola SAID anonymous-agents track. The blinding
 * factor is a random field element supplied by the sender; without it, low-
 * entropy notes (e.g. zero-amount placeholders) would be trivially guessable.
 *
 * Poseidon-BN254 is used so the same hash can be recomputed on-chain via
 * Solana's `sol_poseidon` syscall when verifying off-circuit data.
 */
template Commitment() {
    signal input amount;
    signal input assetId;
    signal input ownerPubkey;
    signal input blinding;
    signal output commitment;

    component hasher = Poseidon(4);
    hasher.inputs[0] <== amount;
    hasher.inputs[1] <== assetId;
    hasher.inputs[2] <== ownerPubkey;
    hasher.inputs[3] <== blinding;
    commitment <== hasher.out;
}
