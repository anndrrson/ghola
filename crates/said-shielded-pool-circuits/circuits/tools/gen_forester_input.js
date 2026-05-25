// Generate a deterministic input.json for batchedUpdate.circom that
// inserts four zero commitments into an empty depth-26 tree at slots 0..3.
//
// The resulting witness should produce a proof where new_root == old_root
// (== root of the empty depth-26 tree), proving the trivial "insert zeros
// into empty slots" identity. Useful as the smoke-test fixture for the
// Rust verify-test in crates/said-shielded-pool-prover/tests/.

const path = require("path");
const fs = require("fs");
const { buildPoseidon } = require("circomlibjs");

const TREE_DEPTH = 26;
const BATCH = 4;

(async () => {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  // Compute Z[0..TREE_DEPTH], where Z[0] = 0 and Z[d] = Poseidon(Z[d-1], Z[d-1]).
  const Z = [F.e(0)];
  for (let d = 1; d <= TREE_DEPTH; d++) {
    Z.push(poseidon([Z[d - 1], Z[d - 1]]));
  }

  // Empty tree root is Z[TREE_DEPTH].
  const oldRoot = F.toString(Z[TREE_DEPTH]);
  // Inserting all-zero commitments into empty slots leaves the root unchanged.
  const newRoot = oldRoot;

  // Sibling path at each step, for slot startIndex+i when starting from an
  // empty tree and inserting zero commitments:
  //   sibling[d] = Z[d]   (regardless of bit, because filled[d] starts at 0
  //                        and is overwritten with current = 0 at every step,
  //                        so filled[d] tracks Z[d] from depth 1 upward and
  //                        stays 0 at d=0; both equal Z[d]).
  const pathRow = [];
  for (let d = 0; d < TREE_DEPTH; d++) {
    pathRow.push(F.toString(Z[d]));
  }

  const input = {
    oldRoot,
    newRoot,
    startIndex: "0",
    commitment: Array(BATCH).fill("0"),
    pad: "0",
    pathElements: Array(BATCH).fill(pathRow),
  };

  const outPath = path.join(__dirname, "..", "..", "artifacts", "input_forester_empty.json");
  fs.writeFileSync(outPath, JSON.stringify(input, null, 2));
  console.log("wrote", outPath);
  console.log("emptyTreeRoot (Z[" + TREE_DEPTH + "]) =", oldRoot);
})();
