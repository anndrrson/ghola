pragma circom 2.1.5;

include "node_modules/circomlib/circuits/poseidon.circom";

/*
 * Keypair derivation (Tornado-Nova style, single-key v1).
 *
 * For v1, we use a single secret-key model:
 *   ak = Poseidon(sk)
 *
 * `ak` is the authorizing/viewing key surrogate that is embedded in note
 * commitments as `owner_pubkey`. A future fvk hierarchy can be derived from
 * `ak` without breaking commitment compatibility.
 *
 * The nullifying key `nk` is the same value as `sk` in v1 (the spender proves
 * knowledge of sk; the on-chain nullifier is bound to (nk, commitment,
 * leaf_index) so it is unlinkable across spends of unrelated notes).
 */
template Keypair() {
    signal input privateKey;
    signal output publicKey;

    component hasher = Poseidon(1);
    hasher.inputs[0] <== privateKey;
    publicKey <== hasher.out;
}

/*
 * Nullifier derivation:
 *   nullifier = Poseidon(nk, commitment, leaf_index)
 *
 * Binding the nullifier to `leaf_index` (Penumbra-style) ensures that two
 * notes with identical (amount, asset_id, owner, blinding) but distinct
 * positions in the tree produce distinct nullifiers. This avoids the
 * Tornado-classic footgun where identical-content notes collide.
 */
template Nullifier() {
    signal input nullifyingKey;
    signal input commitment;
    signal input leafIndex;
    signal output nullifier;

    component hasher = Poseidon(3);
    hasher.inputs[0] <== nullifyingKey;
    hasher.inputs[1] <== commitment;
    hasher.inputs[2] <== leafIndex;
    nullifier <== hasher.out;
}
