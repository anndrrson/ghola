#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

export async function createGitPreviewDeployment({
  cwd = REPO_ROOT,
  run = execFileSync,
  fetchImpl = fetch,
  read = readFile,
  sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  now = Date.now,
  timeoutMs = 15 * 60_000,
  env = process.env,
} = {}) {
  const branch = output(run, "git", ["branch", "--show-current"], cwd);
  const sha = output(run, "git", ["rev-parse", "HEAD"], cwd).toLowerCase();
  const status = output(run, "git", ["status", "--porcelain"], cwd, true);
  const remote = output(run, "git", ["ls-remote", "--heads", "origin", branch], cwd);
  if (!branch || branch === "main" || !/^[0-9a-f]{40}$/.test(sha) || status) {
    throw new Error("preview_git_source_not_clean");
  }
  if (remote.split(/\s+/)[0]?.toLowerCase() !== sha) {
    throw new Error("preview_git_source_not_pushed");
  }

  const projectLink = JSON.parse(await read(resolve(cwd, ".vercel/project.json"), "utf8"));
  const token = env.VERCEL_TOKEN || await readVercelToken({ read, env });
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const team = encodeURIComponent(projectLink.orgId);
  const projectResponse = await fetchImpl(
    `https://api.vercel.com/v9/projects/${encodeURIComponent(projectLink.projectId)}?teamId=${team}`,
    { headers },
  );
  const project = await responseJson(projectResponse, "preview_project_read_failed");
  if (project.id !== projectLink.projectId || project.name !== projectLink.projectName
    || project.link?.type !== "github" || !project.link.repoId
    || project.link.productionBranch === branch) {
    throw new Error("preview_git_project_binding_invalid");
  }

  const createResponse = await fetchImpl(
    `https://api.vercel.com/v13/deployments?teamId=${team}&forceNew=1`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: project.name,
        project: project.id,
        gitSource: { type: "github", repoId: project.link.repoId, ref: branch, sha },
      }),
    },
  );
  let deployment = await responseJson(createResponse, "preview_git_deploy_create_failed");
  assertPreviewDeployment(deployment, { branch, sha, projectId: project.id });
  const deadline = now() + timeoutMs;
  while (!["READY", "ERROR", "CANCELED"].includes(deployment.readyState)) {
    if (now() >= deadline) throw new Error("preview_git_deploy_timeout");
    await sleep(2_000);
    const response = await fetchImpl(
      `https://api.vercel.com/v13/deployments/${encodeURIComponent(deployment.id)}?teamId=${team}`,
      { headers },
    );
    deployment = await responseJson(response, "preview_git_deploy_read_failed");
    assertPreviewDeployment(deployment, { branch, sha, projectId: project.id });
  }
  if (deployment.readyState !== "READY") {
    throw new Error(`preview_git_deploy_failed:${deployment.readyState.toLowerCase()}`);
  }
  return Object.freeze({
    id: deployment.id,
    url: `https://${deployment.url}`,
    branch,
    sha,
  });
}

function assertPreviewDeployment(deployment, { branch, sha, projectId }) {
  if (!deployment?.id || !deployment.url || deployment.projectId !== projectId
    || deployment.target === "production"
    || deployment.gitSource?.type !== "github"
    || deployment.gitSource?.ref !== branch
    || String(deployment.gitSource?.sha || "").toLowerCase() !== sha) {
    throw new Error("preview_git_deploy_binding_invalid");
  }
}

async function readVercelToken({ read, env }) {
  const candidates = [
    env.VERCEL_GLOBAL_CONFIG && resolve(env.VERCEL_GLOBAL_CONFIG, "auth.json"),
    join(homedir(), "Library/Application Support/com.vercel.cli/auth.json"),
    join(homedir(), ".config/com.vercel.cli/auth.json"),
  ].filter(Boolean);
  for (const path of candidates) {
    try {
      const parsed = JSON.parse(await read(path, "utf8"));
      if (typeof parsed.token === "string" && parsed.token) return parsed.token;
    } catch {
      // Try the next standard Vercel CLI credential location.
    }
  }
  throw new Error("vercel_token_missing");
}

async function responseJson(response, code) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${code}:${response.status}`);
  return body;
}

function output(run, command, args, cwd, allowEmpty = false) {
  const value = String(run(command, args, { cwd, encoding: "utf8" }) || "").trim();
  if (!allowEmpty && !value) throw new Error("preview_git_source_missing");
  return value;
}

async function main() {
  if (process.argv.length !== 2) throw new Error("preview_git_deploy_arguments_forbidden");
  const result = await createGitPreviewDeployment();
  console.log(`[preview-git-deploy] ${result.url}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`[preview-git-deploy] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
