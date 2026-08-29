import assert from "node:assert/strict";
import test from "node:test";
import { validateStablePreviewAssignment } from "./assign-stable-preview-alias.mjs";

const sha = "ba024f0e353663d69329dd11baab4fb356f9a214";
const deploymentUrl = "web-dq7u5vf17-anndrrsons-projects.vercel.app";
const alias = "web-git-codex-private-agent-worker-n-c18d85-anndrrsons-projects.vercel.app";

function fixture(overrides = {}) {
  return {
    deployment: { url: deploymentUrl, target: "preview", readyState: "READY" },
    stableAlias: alias,
    expectedSha: sha,
    status: {
      status: "green",
      release_identity: { ready: true, web_commit_sha: sha, web_deployment_url: `https://${deploymentUrl}` },
    },
    ...overrides,
  };
}

test("accepts an exact green Preview before assigning its stable branch alias", () => {
  const result = validateStablePreviewAssignment(fixture());
  assert.equal(result.stable_alias_hostname, alias);
  assert.equal(result.web_commit_sha, sha);
});

test("refuses production deployments and non-branch aliases", () => {
  assert.throws(() => validateStablePreviewAssignment(fixture({
    deployment: { url: deploymentUrl, target: "production", readyState: "READY" },
  })), /Preview deployment/);
  assert.throws(() => validateStablePreviewAssignment(fixture({ stableAlias: "web-preview.vercel.app" })), /branch alias/);
});

test("refuses stale source or identity from another deployment", () => {
  assert.throws(() => validateStablePreviewAssignment(fixture({ expectedSha: "0".repeat(40) })), /expected source commit/);
  assert.throws(() => validateStablePreviewAssignment(fixture({
    status: {
      status: "green",
      release_identity: {
        ready: true,
        web_commit_sha: sha,
        web_deployment_url: "https://web-other-anndrrsons-projects.vercel.app",
      },
    },
  })), /different deployment/);
});
