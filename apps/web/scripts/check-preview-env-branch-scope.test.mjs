import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  PRIVATE_WORKER_PREVIEW_ENV_GROUPS,
  assessPreviewBranchEnvScope,
  currentGitBranch,
  listVercelPreviewEnvKeys,
  parseVercelEnvListKeys,
  verifyCurrentPreviewBranchEnvScope,
} from "./check-preview-env-branch-scope.mjs";

const KEYS = Object.freeze({
  url: "GHOLA_PRIVATE_AGENT_EXECUTION_URL",
  auth: "PRIVATE_AGENT_WORKER_CAPABILITY_SECRET",
  image: "GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST",
  signer: "GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64",
  turnkeyOrganization: "NEXT_PUBLIC_TURNKEY_PERPS_ORGANIZATION_ID",
  turnkeyAuthProxy: "NEXT_PUBLIC_TURNKEY_PERPS_AUTH_PROXY_CONFIG_ID",
  publicBeta: "GHOLA_PRIVATE_AGENT_BETA_PUBLIC_ENABLED",
  mainnetDelegation: "NEXT_PUBLIC_GHOLA_PERPS_MAINNET_ENABLED",
  privateAccountStore: "GHOLA_PRIVATE_ACCOUNT_STORE",
  requestProofSecret: "GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET",
  requestProofMode: "GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_MODE",
});

test("extracts only allowlisted names from Vercel output and never returns values", () => {
  const secret = "secret-that-must-never-leave-the-list-command";
  const output = [
    "name value environments (git branch) created",
    `${KEYS.url} https://worker.example Preview (feature/carry) 1h ago`,
    `${KEYS.auth} ${secret} Preview (feature/carry) 1h ago`,
    "UNRELATED_SECRET another-secret Preview 1h ago",
  ].join("\n");
  const result = parseVercelEnvListKeys(output);
  assert.deepEqual([...result].sort(), [KEYS.auth, KEYS.url].sort());
  assert.doesNotMatch(JSON.stringify([...result]), /secret-that|worker\.example|another-secret/);
});

test("accepts aliases when every required group applies to the current branch", () => {
  const result = assessPreviewBranchEnvScope({
    branch: "feature/carry",
    allPreviewKeys: Object.values(KEYS),
    branchPreviewKeys: Object.values(KEYS),
  });
  assert.deepEqual(result, {
    branch: "feature/carry",
    checked_groups: PRIVATE_WORKER_PREVIEW_ENV_GROUPS.map((group) => group.id),
  });
});

test("fails clearly when private-worker variables exist only on another branch", () => {
  assert.throws(
    () => assessPreviewBranchEnvScope({
      branch: "feature/current",
      allPreviewKeys: Object.values(KEYS),
      branchPreviewKeys: [KEYS.url, KEYS.image, KEYS.signer],
    }),
    /preview_env_branch_scope_invalid:feature\/current:configured only outside this branch scope: private_worker_auth/,
  );
});

test("distinguishes absent Preview configuration from another-branch scope", () => {
  const productKeys = [
    KEYS.turnkeyOrganization,
    KEYS.turnkeyAuthProxy,
    KEYS.publicBeta,
    KEYS.mainnetDelegation,
    KEYS.privateAccountStore,
  ];
  assert.throws(
    () => assessPreviewBranchEnvScope({
      branch: "feature/current",
      allPreviewKeys: [KEYS.url, KEYS.auth, ...productKeys],
      branchPreviewKeys: [KEYS.url, ...productKeys],
    }),
    /configured only outside this branch scope: private_worker_auth; missing from every Preview scope: private_worker_image_digest,private_worker_funding_signer/,
  );
});

test("fails before deploy when private-account persistence is absent from the branch", () => {
  const withoutPersistence = Object.values(KEYS).filter((key) => key !== KEYS.privateAccountStore);
  assert.throws(
    () => assessPreviewBranchEnvScope({
      branch: "feature/current",
      allPreviewKeys: Object.values(KEYS),
      branchPreviewKeys: withoutPersistence,
    }),
    /configured only outside this branch scope: private_account_persistence/,
  );
});

test("fails before deploy when private-account request proof is absent from the branch", () => {
  const withoutRequestProof = Object.values(KEYS).filter((key) =>
    key !== KEYS.requestProofSecret && key !== KEYS.requestProofMode);
  assert.throws(
    () => assessPreviewBranchEnvScope({
      branch: "feature/current",
      allPreviewKeys: Object.values(KEYS),
      branchPreviewKeys: withoutRequestProof,
    }),
    /configured only outside this branch scope: private_account_request_proof_secret,private_account_request_proof_mode/,
  );
});

test("uses the checked-out branch and ignores stale CI branch metadata", () => {
  assert.equal(currentGitBranch({
    env: { VERCEL_GIT_COMMIT_REF: "feature/stale" },
    run: () => ({ status: 0, stdout: "feature/local\n" }),
  }), "feature/local");
  assert.equal(currentGitBranch({
    run: () => ({ status: 0, stdout: "feature/local\n" }),
  }), "feature/local");
  assert.throws(
    () => currentGitBranch({ run: () => ({ status: 1, stdout: "" }) }),
    /preview_env_branch_unavailable/,
  );
  assert.throws(
    () => currentGitBranch({ run: () => ({ status: 0, stdout: "bad branch\n" }) }),
    /preview_env_branch_invalid/,
  );
});

test("Vercel list failures suppress command output", () => {
  const secret = "must-not-appear";
  assert.throws(
    () => listVercelPreviewEnvKeys({
      branch: "feature/carry",
      run: () => ({ status: 1, stdout: secret, stderr: secret }),
    }),
    (error) => {
      assert.match(error.message, /preview_env_scope_list_failed:current_branch/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
});

test("checks all Preview metadata before branch-effective metadata", () => {
  const calls = [];
  const result = verifyCurrentPreviewBranchEnvScope({
    branch: "feature/carry",
    list: ({ branch }) => {
      calls.push(branch ?? null);
      return new Set(Object.values(KEYS));
    },
  });
  assert.deepEqual(calls, [null, "feature/carry"]);
  assert.equal(result.branch, "feature/carry");
});

test("the supported Preview deploy command runs the branch guard before Vercel", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(
    pkg.scripts["preview:deploy"],
    "node scripts/deploy-preview.mjs",
  );
  assert.match(pkg.scripts["test:release-gates"], /check-preview-env-branch-scope\.test\.mjs/);
});
