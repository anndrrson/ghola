import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assembleCarryNoSubmitEvidenceFile,
  parseCarryNoSubmitAssemblyArgs,
} from "./assemble-carry-no-submit-evidence.mjs";

const NOW = 1_800_000_000_000;
const SOURCE_TREE = Object.freeze({
  source_revision: "a".repeat(40),
  source_tree_digest: `sha256:${"c".repeat(64)}`,
  release_file_count: 1,
});

test("sanitizes sealed access, verifies, and atomically writes no-submit evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ghola-no-submit-assemble-"));
  const requestPath = join(directory, "request.json");
  const responsePath = join(directory, "response.json");
  const outputPath = join(directory, "proof.json");
  await Promise.all([
    writeFile(requestPath, JSON.stringify(request())),
    writeFile(responsePath, JSON.stringify(response())),
  ]);
  let verifyCalls = 0;
  const result = await assembleCarryNoSubmitEvidenceFile({
    requestPath,
    responsePath,
    previewUrl: "https://preview.vercel.app",
    webCommitSha: "a".repeat(40),
    workerImageDigest: `sha256:${"b".repeat(64)}`,
    outputPath,
    signerPublicKeysB64: ["signer"],
    sharedSecret: "secret",
  }, {
    attestSourceTree: () => SOURCE_TREE,
    verify: (evidence, expected) => {
      verifyCalls += 1;
      assert.equal("encrypted_execution_vault" in evidence.request.venue_access.hyperliquid, false);
      assert.equal("private_key" in evidence.request.venue_access.hyperliquid, false);
      assert.deepEqual(Object.keys(evidence.request.venue_access.hyperliquid).sort(), [
        "account_commitment",
        "policy_commitment",
        "vault_commitment",
      ]);
      assert.equal(expected.shared_secret, "secret");
      assert.deepEqual(expected.expected_signer_public_keys_b64, ["signer"]);
      assert.equal(evidence.source.source_tree_digest, SOURCE_TREE.source_tree_digest);
      assert.equal(expected.expected_source_tree_digest, SOURCE_TREE.source_tree_digest);
      return {
        ok: true,
        evidence_commitment: evidence.response.private_prime_readiness.evidence_commitment,
      };
    },
  });
  assert.equal(verifyCalls, 1);
  assert.equal(result.output_path, outputPath);
  const stored = JSON.parse(await readFile(outputPath, "utf8"));
  assert.deepEqual(stored, result.evidence);
  assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
});

test("never replaces prior evidence when verification fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ghola-no-submit-assemble-fail-"));
  const requestPath = join(directory, "request.json");
  const responsePath = join(directory, "response.json");
  const outputPath = join(directory, "proof.json");
  await Promise.all([
    writeFile(requestPath, JSON.stringify(request())),
    writeFile(responsePath, JSON.stringify(response())),
    writeFile(outputPath, "existing\n"),
  ]);
  await assert.rejects(() => assembleCarryNoSubmitEvidenceFile({
    requestPath,
    responsePath,
    previewUrl: "https://preview.vercel.app",
    webCommitSha: "a".repeat(40),
    workerImageDigest: `sha256:${"b".repeat(64)}`,
    outputPath,
  }, {
    attestSourceTree: () => SOURCE_TREE,
    verify: () => { throw new Error("proof rejected"); },
  }), /proof rejected/);
  assert.equal(await readFile(outputPath, "utf8"), "existing\n");
});

test("never persists a matrix response containing credential material", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ghola-no-submit-secret-"));
  const requestPath = join(directory, "request.json");
  const responsePath = join(directory, "response.json");
  const outputPath = join(directory, "proof.json");
  await Promise.all([
    writeFile(requestPath, JSON.stringify(request())),
    writeFile(responsePath, JSON.stringify({
      ...response(),
      debug: { encrypted_execution_vault: { ciphertext: "must-never-be-durable" } },
    })),
    writeFile(outputPath, "existing\n"),
  ]);
  let verifyCalls = 0;
  await assert.rejects(() => assembleCarryNoSubmitEvidenceFile({
    requestPath,
    responsePath,
    previewUrl: "https://preview.vercel.app",
    webCommitSha: "a".repeat(40),
    workerImageDigest: `sha256:${"b".repeat(64)}`,
    outputPath,
  }, {
    attestSourceTree: () => SOURCE_TREE,
    verify: () => { verifyCalls += 1; return { ok: true }; },
  }), /carry_no_submit_assembly_response_contains_credential_material/);
  assert.equal(verifyCalls, 0);
  assert.equal(await readFile(outputPath, "utf8"), "existing\n");
});

test("parses only the exact deterministic assembly inputs", () => {
  assert.deepEqual(parseCarryNoSubmitAssemblyArgs([
    "--request", "request.json",
    "--response", "response.json",
    "--preview-url", "https://preview.vercel.app",
    "--web-commit-sha", "a".repeat(40),
    "--worker-image-digest", `sha256:${"b".repeat(64)}`,
    "--output", "proof.json",
  ]), {
    requestPath: "request.json",
    responsePath: "response.json",
    previewUrl: "https://preview.vercel.app",
    webCommitSha: "a".repeat(40),
    workerImageDigest: `sha256:${"b".repeat(64)}`,
    outputPath: "proof.json",
  });
  assert.throws(() => parseCarryNoSubmitAssemblyArgs([]),
    /carry_no_submit_assembly_argument_missing:--request/);
  assert.throws(() => parseCarryNoSubmitAssemblyArgs(["--prod", "true"]),
    /carry_no_submit_assembly_argument_invalid:--prod/);
  assert.throws(() => parseCarryNoSubmitAssemblyArgs([
    "--request", "one.json",
    "--request", "two.json",
  ]), /carry_no_submit_assembly_argument_duplicate:--request/);
});

test("refuses overlapping request, response, and output paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ghola-no-submit-overlap-"));
  const requestPath = join(directory, "request.json");
  const responsePath = join(directory, "response.json");
  await Promise.all([
    writeFile(requestPath, JSON.stringify(request())),
    writeFile(responsePath, JSON.stringify(response())),
  ]);
  await assert.rejects(() => assembleCarryNoSubmitEvidenceFile({
    requestPath,
    responsePath,
    previewUrl: "https://preview.vercel.app",
    webCommitSha: "a".repeat(40),
    workerImageDigest: `sha256:${"b".repeat(64)}`,
    outputPath: requestPath,
  }), /carry_no_submit_assembly_output_overlaps_input/);
});

function request() {
  return {
    version: 1,
    owner_commitment: "owner_commitment_0001",
    operation_class: "matrix_no_submit",
    work_order_commitment: "carry_matrix_0001",
    asset: "BTC",
    notional_usd: "11",
    horizon_days: "1",
    venue_access: Object.fromEntries(["hyperliquid", "lighter", "aster"].map((venueId) => [venueId, {
      account_commitment: `account_commitment_${venueId}`,
      vault_commitment: `vault_commitment_${venueId}`,
      policy_commitment: `policy_commitment_${venueId}`,
      encrypted_execution_vault: { ciphertext: "never persist this" },
      private_key: "never persist this either",
    }])),
  };
}

function response() {
  return {
    private_prime_readiness: {
      checked_at_ms: NOW,
      evidence_commitment: `carry:private-prime:${"c".repeat(40)}`,
    },
  };
}
