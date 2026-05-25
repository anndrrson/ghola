#!/usr/bin/env node
// Build a snarkjs input.json for a deposit-only scenario:
//   * 2 dummy inputs (amount = 0, dummy keys, dummy paths)
//   * 1 real output (amount = DEPOSIT_AMOUNT)
//   * 1 dummy output (amount = 0)
//   * public_amount = +DEPOSIT_AMOUNT
//
// This produces signals that match `transaction.circom` exactly. All values
// in the resulting JSON are decimal strings (snarkjs convention).

const { buildPoseidon } = require("circomlibjs");
const fs = require("fs");
const path = require("path");

const LEVELS = 26;
const N_INS = 2;
const N_OUTS = 2;
const DEPOSIT_AMOUNT = 1000n;

async function main() {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  // Helper: poseidon over n field elements → decimal string
  const H = (...xs) => F.toString(poseidon(xs.map((x) => F.e(x))));

  // ---- Asset ----
  // For PoC use a fixed mint pubkey (32 bytes). AssetId = Poseidon1(mintBytes).
  // Pack the 32 bytes as a single field element (assuming the high bits fit).
  const mintBytes = BigInt(
    "0x" + "11".repeat(32)
  ); // simple placeholder; light-poseidon would split bytes — we just hash one elem.
  // To stay BN254-safe, mask to 254 bits:
  const FIELD_MASK = (1n << 254n) - 1n;
  const mintField = mintBytes & FIELD_MASK;
  const assetId = H(mintField);

  // ---- Real owner ----
  const realSk = 12345n;
  const realPk = H(realSk);
  const realBlinding = 99999n;

  // ---- Dummy inputs ----
  const dummySk = [1n, 2n];
  const dummyBlinding = [101n, 102n];
  const dummyLeafIndex = [0n, 0n];
  const dummyPathElements = [
    new Array(LEVELS).fill("0"),
    new Array(LEVELS).fill("0"),
  ];

  // For amount=0 inputs the circuit still computes nullifier; bind to whatever
  // we compute here so the proof can satisfy the equality constraint.
  const dummyInCommitment = dummySk.map((sk, i) => {
    const pk = H(sk);
    return H(0n, assetId, pk, dummyBlinding[i]);
  });
  const dummyInNullifier = dummySk.map((sk, i) =>
    H(sk, dummyInCommitment[i], dummyLeafIndex[i])
  );

  // ---- Outputs ----
  // Output 0: real, amount = DEPOSIT_AMOUNT, owner = realPk
  const out0Commitment = H(DEPOSIT_AMOUNT, assetId, realPk, realBlinding);
  // Output 1: dummy, amount = 0
  const out1Owner = realPk; // any owner — amount is zero
  const out1Blinding = 88888n;
  const out1Commitment = H(0n, assetId, out1Owner, out1Blinding);

  // ---- Root ----
  // For a fresh pool, root = Z[LEVELS] (the empty-tree root). We need to
  // precompute zero hashes the same way the circuits' MerkleProof template
  // would expect — but since inAmount=0, the membership check is skipped
  // via `(1 - isZero) * (computed_root - root) === 0`. So root can be
  // ANYTHING — including 0 — and the circuit will accept it. We'll pass 0.
  const root = "0";

  // ---- Public binding ----
  const extDataHash = "0"; // arbitrary; the program will validate this matches off-circuit ext data.

  // ---- public_amount ----
  // Circuit convention: sum(inputs) === sum(outputs) + public_amount
  //   deposit:  inputs=0, outputs=+amount → public_amount = -amount (mod p)
  //   withdraw: inputs=+amount, outputs=0 → public_amount = +amount
  const BN254_FIELD =
    21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  const publicAmount = ((BN254_FIELD - DEPOSIT_AMOUNT) % BN254_FIELD).toString();

  // H1 (2026-05-25): signed-amount range-check witness hints. This scenario
  // encodes publicAmount = p - DEPOSIT_AMOUNT, i.e. the field-NEGATION of a
  // positive magnitude → isNeg = 1, magnitude = DEPOSIT_AMOUNT. The circuit's
  // SignedAmount64 template enforces publicAmount == (1 - 2*isNeg)*magnitude.
  const publicAmountIsNeg = "1";
  const publicAmountMagnitude = DEPOSIT_AMOUNT.toString();

  const input = {
    // public
    root,
    inputNullifier: dummyInNullifier,
    outputCommitment: [out0Commitment, out1Commitment],
    publicAmount,
    assetId,
    extDataHash,
    // private — signed-amount hints (H1)
    publicAmountIsNeg,
    publicAmountMagnitude,
    // private — inputs
    inAmount: ["0", "0"],
    inBlinding: dummyBlinding.map((x) => x.toString()),
    inPrivateKey: dummySk.map((x) => x.toString()),
    inLeafIndex: dummyLeafIndex.map((x) => x.toString()),
    inPathElements: dummyPathElements,
    // private — outputs
    outAmount: [DEPOSIT_AMOUNT.toString(), "0"],
    outBlinding: [realBlinding.toString(), out1Blinding.toString()],
    outOwnerPubkey: [realPk, out1Owner],
  };

  const outPath = path.resolve(__dirname, "../../artifacts/input_deposit.json");
  fs.writeFileSync(outPath, JSON.stringify(input, null, 2));
  console.log("wrote", outPath);

  // Also print the public signals in expected order for downstream debugging
  console.log("\npublic signals (order: root, in_nf_0, in_nf_1, out_cm_0, out_cm_1, public_amount, asset_id, ext_data_hash):");
  console.log(JSON.stringify({
    root,
    in_nf_0: dummyInNullifier[0],
    in_nf_1: dummyInNullifier[1],
    out_cm_0: out0Commitment,
    out_cm_1: out1Commitment,
    public_amount: publicAmount,
    asset_id: assetId,
    ext_data_hash: extDataHash,
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
