import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  attestCarryReleaseSourceTree,
  computeCarrySourceTreeDigest,
} from "../../../scripts/carry-source-tree-attestation.mjs";

test("attests a clean deterministic release tree", () => {
  const fixture = gitFixture();
  try {
    const releaseFiles = ["critical-b.txt", "critical-a.txt"];
    const clean = attestCarryReleaseSourceTree({ repoRoot: fixture, releaseFiles });
    assert.match(clean.source_revision, /^[0-9a-f]{40}$/);
    assert.match(clean.source_tree_digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(clean.release_file_count, 2);
    assert.equal(clean.source_tree_digest, computeCarrySourceTreeDigest({
      repoRoot: fixture,
      releaseFiles: [...releaseFiles].reverse(),
    }));
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("ignores unrelated dirt", () => {
  const fixture = gitFixture();
  try {
    const releaseFiles = ["critical-a.txt", "critical-b.txt"];
    const clean = attestCarryReleaseSourceTree({ repoRoot: fixture, releaseFiles });
    writeFileSync(join(fixture, "unrelated.txt"), "unrelated change\n");
    assert.equal(
      attestCarryReleaseSourceTree({ repoRoot: fixture, releaseFiles }).source_tree_digest,
      clean.source_tree_digest,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("rejects a tampered expected digest", () => {
  const fixture = gitFixture();
  try {
    const releaseFiles = ["critical-a.txt", "critical-b.txt"];
    assert.throws(() => attestCarryReleaseSourceTree({
      repoRoot: fixture,
      releaseFiles,
      expectedDigest: `sha256:${"f".repeat(64)}`,
    }), /carry_release_source_tree_digest_mismatch/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("rejects release-critical dirt", () => {
  const fixture = gitFixture();
  try {
    const releaseFiles = ["critical-a.txt", "critical-b.txt"];
    const clean = attestCarryReleaseSourceTree({ repoRoot: fixture, releaseFiles });
    writeFileSync(join(fixture, "critical-a.txt"), "tampered\n");
    assert.throws(() => attestCarryReleaseSourceTree({ repoRoot: fixture, releaseFiles }),
      /carry_release_source_tree_dirty:.*critical-a\.txt/);
    assert.throws(() => attestCarryReleaseSourceTree({
      repoRoot: fixture,
      releaseFiles,
      expectedDigest: clean.source_tree_digest,
    }), /carry_release_source_tree_dirty/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("rejects a release-critical symlink escape", () => {
  const fixture = gitFixture();
  const outside = mkdtempSync(join(tmpdir(), "ghola-carry-source-outside-"));
  try {
    const outsideFile = join(outside, "external-source.txt");
    writeFileSync(outsideFile, "external\n");
    symlinkSync(outsideFile, join(fixture, "critical-link.txt"));
    run(fixture, "add", "critical-link.txt");
    run(fixture, "commit", "-m", "symlink fixture");
    assert.throws(() => attestCarryReleaseSourceTree({
      repoRoot: fixture,
      releaseFiles: ["critical-link.txt"],
    }), /carry_release_source_not_regular:critical-link\.txt/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

function gitFixture() {
  const directory = mkdtempSync(join(tmpdir(), "ghola-carry-source-tree-"));
  writeFileSync(join(directory, "critical-a.txt"), "alpha\n");
  writeFileSync(join(directory, "critical-b.txt"), "beta\n");
  writeFileSync(join(directory, "unrelated.txt"), "stable\n");
  run(directory, "init");
  run(directory, "config", "user.email", "carry-test@ghola.invalid");
  run(directory, "config", "user.name", "Ghola Carry Test");
  run(directory, "add", ".");
  run(directory, "commit", "-m", "fixture");
  return directory;
}

function run(cwd, ...args) {
  return execFileSync("git", args, { cwd, stdio: "ignore" });
}
