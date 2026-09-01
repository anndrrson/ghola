import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const DOMAIN = "ghola-carry-release-source-tree-v1";
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export function attestCarryReleaseSourceTree({
  repoRoot,
  releaseFiles,
  expectedDigest,
  expectedRevision,
  run = execFileSync,
  read = readFileSync,
  lstat = lstatSync,
  realpath = realpathSync,
  gitAvailable = existsSync(resolve(String(repoRoot || ""), ".git")),
} = {}) {
  const root = resolve(String(repoRoot || ""));
  const paths = canonicalReleasePaths(releaseFiles);
  if (!gitAvailable) throw new Error("carry_release_source_tree_git_unavailable");
  const sourceRevision = resolveCarrySourceRevision({ repoRoot: root, run });
  if (expectedRevision && !revisionMatches(sourceRevision, expectedRevision)) {
    throw new Error("carry_release_source_revision_mismatch");
  }
  const dirtyFiles = dirtyCarryReleaseFiles({ repoRoot: root, releaseFiles: paths, run });
  if (dirtyFiles.length > 0) {
    throw new Error(`carry_release_source_tree_dirty:${dirtyFiles.join(",")}`);
  }
  const sourceTreeDigest = computeCarrySourceTreeDigest({
    repoRoot: root,
    releaseFiles: paths,
    read,
    lstat,
    realpath,
  });
  if (expectedDigest && sourceTreeDigest !== expectedDigest) {
    throw new Error("carry_release_source_tree_digest_mismatch");
  }
  return Object.freeze({
    version: 1,
    algorithm: "sha256",
    source_revision: sourceRevision,
    source_tree_digest: sourceTreeDigest,
    release_file_count: paths.length,
  });
}

export function computeCarrySourceTreeDigest({
  repoRoot,
  releaseFiles,
  read = readFileSync,
  lstat = lstatSync,
  realpath = realpathSync,
} = {}) {
  const root = resolve(String(repoRoot || ""));
  const paths = canonicalReleasePaths(releaseFiles);
  let realRoot;
  try {
    realRoot = realpath(root);
  } catch {
    throw new Error("carry_release_source_root_unreadable");
  }
  const entries = paths.map((path) => {
    const absolute = resolve(root, path);
    if (!withinRoot(root, absolute)) throw new Error(`carry_release_source_path_invalid:${path}`);
    let metadata;
    let realAbsolute;
    try {
      metadata = lstat(absolute);
      realAbsolute = realpath(absolute);
    } catch {
      throw new Error(`carry_release_source_unreadable:${path}`);
    }
    if (!metadata.isFile()) throw new Error(`carry_release_source_not_regular:${path}`);
    if (!withinRoot(realRoot, realAbsolute)) throw new Error(`carry_release_source_path_invalid:${path}`);
    let contents;
    try {
      contents = read(absolute);
    } catch {
      throw new Error(`carry_release_source_unreadable:${path}`);
    }
    const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
    return Object.freeze({
      path,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  });
  const material = JSON.stringify({ domain: DOMAIN, version: 1, entries });
  return `sha256:${createHash("sha256").update(material).digest("hex")}`;
}

export function dirtyCarryReleaseFiles({ repoRoot, releaseFiles, run = execFileSync } = {}) {
  const root = resolve(String(repoRoot || ""));
  const paths = canonicalReleasePaths(releaseFiles);
  let output;
  try {
    output = String(run("git", [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--",
      ...paths,
    ], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }));
  } catch {
    throw new Error("carry_release_source_tree_status_unavailable");
  }
  return Object.freeze(output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .sort());
}

export function resolveCarrySourceRevision({ repoRoot, run = execFileSync } = {}) {
  try {
    const revision = String(run("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
      cwd: resolve(String(repoRoot || "")),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })).trim().toLowerCase();
    if (/^[0-9a-f]{40}$/.test(revision)) return revision;
  } catch {
    // Fail closed below.
  }
  throw new Error("carry_release_source_revision_unavailable");
}

export function validCarrySourceTreeDigest(value) {
  return DIGEST.test(String(value || ""));
}

export function canonicalReleasePaths(releaseFiles) {
  if (!Array.isArray(releaseFiles) || releaseFiles.length === 0) {
    throw new Error("carry_release_source_paths_missing");
  }
  const paths = [...new Set(releaseFiles.map((value) => String(value || "").replaceAll("\\", "/")))].sort();
  for (const path of paths) {
    if (!path || isAbsolute(path) || path === "." || path.startsWith("../") || path.includes("/../")) {
      throw new Error(`carry_release_source_path_invalid:${path || "missing"}`);
    }
  }
  return Object.freeze(paths);
}

function revisionMatches(actual, expected) {
  const normalized = String(expected || "").trim().toLowerCase();
  return /^[0-9a-f]{7,40}$/.test(normalized) && actual.startsWith(normalized);
}

function withinRoot(root, absolute) {
  const path = relative(root, absolute);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
