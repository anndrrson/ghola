import assert from "node:assert/strict";
import test from "node:test";
import { createGitPreviewDeployment } from "./create-git-preview-deployment.mjs";

const BRANCH = "feature/carry";
const SHA = "a".repeat(40);
const PROJECT = {
  id: "project_1",
  name: "web",
  link: { type: "github", repoId: 123, productionBranch: "main" },
};

test("creates one Git-bound Preview and waits for READY", async () => {
  const requests = [];
  const responses = [
    response(PROJECT),
    response(deployment("QUEUED")),
    response(deployment("READY")),
  ];
  const result = await createGitPreviewDeployment({
    cwd: "/repo",
    run: gitRun(),
    read: async () => JSON.stringify({ projectId: PROJECT.id, orgId: "team_1", projectName: PROJECT.name }),
    env: { VERCEL_TOKEN: "token" },
    fetchImpl: async (url, init = {}) => {
      requests.push([url, init]);
      return responses.shift();
    },
    sleep: async () => {},
    now: (() => { let value = 1; return () => value++; })(),
  });
  assert.equal(result.url, "https://preview.example");
  assert.equal(requests.length, 3);
  const create = JSON.parse(requests[1][1].body);
  assert.deepEqual(create.gitSource, { type: "github", repoId: 123, ref: BRANCH, sha: SHA });
  assert.equal(Object.hasOwn(create, "target"), false);
});

test("refuses an unpushed source before contacting Vercel", async () => {
  let contacted = false;
  await assert.rejects(createGitPreviewDeployment({
    cwd: "/repo",
    run: gitRun({ remote: `${"b".repeat(40)}\trefs/heads/${BRANCH}` }),
    fetchImpl: async () => { contacted = true; return response({}); },
  }), /preview_git_source_not_pushed/);
  assert.equal(contacted, false);
});

test("rejects any production deployment response", async () => {
  const production = { ...deployment("QUEUED"), target: "production" };
  const responses = [response(PROJECT), response(production)];
  await assert.rejects(createGitPreviewDeployment({
    cwd: "/repo",
    run: gitRun(),
    read: async () => JSON.stringify({ projectId: PROJECT.id, orgId: "team_1", projectName: PROJECT.name }),
    env: { VERCEL_TOKEN: "token" },
    fetchImpl: async () => responses.shift(),
  }), /preview_git_deploy_binding_invalid/);
});

function gitRun(overrides = {}) {
  return (_command, args) => {
    if (args[0] === "branch") return `${BRANCH}\n`;
    if (args[0] === "rev-parse") return `${SHA}\n`;
    if (args[0] === "status") return overrides.status || "";
    if (args[0] === "ls-remote") return overrides.remote || `${SHA}\trefs/heads/${BRANCH}\n`;
    throw new Error(`unexpected command:${args.join(" ")}`);
  };
}

function deployment(readyState) {
  return {
    id: "deployment_1",
    url: "preview.example",
    projectId: PROJECT.id,
    target: null,
    readyState,
    gitSource: { type: "github", repoId: 123, ref: BRANCH, sha: SHA },
  };
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}
