import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assembleCarryReleaseEvidenceFile,
  parseCarryAssemblyArgs,
} from "./assemble-carry-release-evidence.mjs";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const SOURCE_TREE = Object.freeze({
  source_revision: "a".repeat(40),
  source_tree_digest: `sha256:${"c".repeat(64)}`,
  release_file_count: 1,
});

test("assembles, verifies, and atomically writes canonical lifecycle evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ghola-carry-assemble-"));
  const candidatePath = join(directory, "candidate.json");
  const firstPath = join(directory, "first.json");
  const secondPath = join(directory, "second.json");
  const outputPath = join(directory, "proof.json");
  await Promise.all([
    writeFile(candidatePath, JSON.stringify({ preview_url: "https://preview.vercel.app", web_commit_sha: "a".repeat(40) })),
    writeFile(firstPath, JSON.stringify({ material: { position_id: "first" } })),
    writeFile(secondPath, JSON.stringify({ position_id: "second" })),
  ]);
  let verifyCalls = 0;
  const result = await assembleCarryReleaseEvidenceFile({
    candidatePath,
    lifecyclePaths: [firstPath, secondPath],
    outputPath,
  }, {
    attestSourceTree: () => SOURCE_TREE,
    assemble: ({ candidate, lifecycles }) => ({
      z: lifecycles,
      candidate,
      evidence_commitment: "carryrelease_test",
    }),
    verify: async (evidence) => {
      verifyCalls += 1;
      assert.deepEqual(evidence.z, [{ position_id: "first" }, { position_id: "second" }]);
      assert.equal(evidence.candidate.source_tree_digest, SOURCE_TREE.source_tree_digest);
      return { ok: true, evidence_commitment: evidence.evidence_commitment };
    },
  });
  assert.equal(verifyCalls, 1);
  assert.equal(result.output_path, outputPath);
  assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), result.evidence);
  assert.match(await readFile(outputPath, "utf8"), /^\{\n  "candidate":/);
  assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
});

test("never changes the prior artifact when verification fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ghola-carry-assemble-fail-"));
  const candidatePath = join(directory, "candidate.json");
  const firstPath = join(directory, "first.json");
  const secondPath = join(directory, "second.json");
  const outputPath = join(directory, "proof.json");
  await Promise.all([
    writeFile(candidatePath, "{}"),
    writeFile(firstPath, "{}"),
    writeFile(secondPath, "{}"),
    writeFile(outputPath, "existing-proof\n"),
  ]);
  await assert.rejects(() => assembleCarryReleaseEvidenceFile({
    candidatePath,
    lifecyclePaths: [firstPath, secondPath],
    outputPath,
  }, {
    attestSourceTree: () => SOURCE_TREE,
    assemble: () => ({ evidence_commitment: "invalid" }),
    verify: async () => {
      throw new Error("proof rejected");
    },
  }), /proof rejected/);
  assert.equal(await readFile(outputPath, "utf8"), "existing-proof\n");
  assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
});

test("rejects a dirty release-critical source tree before assembling evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ghola-carry-assemble-dirty-"));
  const candidatePath = join(directory, "candidate.json");
  const firstPath = join(directory, "first.json");
  const secondPath = join(directory, "second.json");
  const outputPath = join(directory, "proof.json");
  await Promise.all([
    writeFile(candidatePath, JSON.stringify({ web_commit_sha: "a".repeat(40) })),
    writeFile(firstPath, "{}"),
    writeFile(secondPath, "{}"),
    writeFile(outputPath, "existing-proof\n"),
  ]);
  let assembled = false;
  await assert.rejects(() => assembleCarryReleaseEvidenceFile({
    candidatePath,
    lifecyclePaths: [firstPath, secondPath],
    outputPath,
  }, {
    attestSourceTree: () => {
      throw new Error("carry_release_source_tree_dirty:apps/web/release-critical.ts");
    },
    assemble: () => {
      assembled = true;
      return {};
    },
  }), /carry_release_source_tree_dirty:apps\/web\/release-critical\.ts/);
  assert.equal(assembled, false);
  assert.equal(await readFile(outputPath, "utf8"), "existing-proof\n");
});

test("requires one candidate and two unique lifecycle inputs", () => {
  assert.throws(() => parseCarryAssemblyArgs([]), /carry_release_candidate_missing/);
  assert.throws(
    () => parseCarryAssemblyArgs(["--candidate", "candidate.json", "--lifecycle", "one.json"]),
    /carry_release_lifecycle_count_insufficient/,
  );
  assert.throws(
    () => parseCarryAssemblyArgs([
      "--candidate", "candidate.json",
      "--lifecycle", "one.json",
      "--lifecycle", "one.json",
    ]),
    /carry_release_lifecycle_input_duplicate/,
  );
  assert.throws(() => parseCarryAssemblyArgs(["--candidate", "candidate.json", "--prod"]),
    /carry_release_assembly_argument_invalid/);
  assert.throws(
    () => parseCarryAssemblyArgs([
      "--candidate", "candidate.json",
      "--lifecycle", "one.json",
      "--lifecycle", "two.json",
      "--output", "first.json",
      "--output", "second.json",
    ]),
    /carry_release_output_duplicate/,
  );
});

test("parses an explicit deterministic assembly command", () => {
  const parsed = parseCarryAssemblyArgs([
    "--candidate", "candidate.json",
    "--lifecycle", "first.json",
    "--lifecycle", "second.json",
    "--output", "proof.json",
  ]);
  assert.deepEqual(parsed, {
    candidatePath: "candidate.json",
    lifecyclePaths: ["first.json", "second.json"],
    outputPath: "proof.json",
  });
  assert.equal(pkg.scripts["assemble:carry-release-evidence"],
    "node scripts/assemble-carry-release-evidence.mjs");
});

test("refuses to overwrite any assembly input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ghola-carry-assemble-overlap-"));
  const candidatePath = join(directory, "candidate.json");
  const firstPath = join(directory, "first.json");
  const secondPath = join(directory, "second.json");
  await Promise.all([
    writeFile(candidatePath, "{}"),
    writeFile(firstPath, "{}"),
    writeFile(secondPath, "{}"),
  ]);
  await assert.rejects(() => assembleCarryReleaseEvidenceFile({
    candidatePath,
    lifecyclePaths: [firstPath, secondPath],
    outputPath: firstPath,
  }), /carry_release_output_overlaps_input/);
  assert.equal(await readFile(firstPath, "utf8"), "{}");
});
