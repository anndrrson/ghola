import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { deployPreview } from "./deploy-preview.mjs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const vercelConfig = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));

test("deploys only after the branch Preview scope passes", () => {
  const calls = [];
  const result = deployPreview({
    args: [],
    verify: () => ({ branch: "feature/carry" }),
    run: (command, args) => {
      calls.push([command, args]);
      return { status: 0 };
    },
  });
  assert.deepEqual(calls, [[process.execPath, ["scripts/create-git-preview-deployment.mjs"]]]);
  assert.deepEqual(result, { branch: "feature/carry" });
});

test("rejects every forwarded deployment override before checking or deploying", () => {
  for (const args of [
    ["--prod"],
    ["--target=production"],
    ["--prebuilt"],
    ["--cwd", "/tmp/other"],
    ["../other-project"],
    ["-b", "KEY=value"],
    ["-e", "KEY=value"],
  ]) {
    let verified = false;
    let spawned = false;
    assert.throws(
      () => deployPreview({
        args,
        verify: () => {
          verified = true;
        },
        run: () => {
          spawned = true;
        },
      }),
      /preview_deploy_arguments_forbidden/,
    );
    assert.equal(verified, false);
    assert.equal(spawned, false);
  }
});

test("does not invoke Vercel when branch verification fails", () => {
  let spawned = false;
  assert.throws(
    () => deployPreview({
      args: [],
      verify: () => {
        throw new Error("wrong branch scope");
      },
      run: () => {
        spawned = true;
      },
    }),
    /wrong branch scope/,
  );
  assert.equal(spawned, false);
});

test("fails closed without claiming a Preview on CLI failure", () => {
  assert.throws(
    () => deployPreview({
      args: [],
      verify: () => ({ branch: "feature/carry" }),
      run: () => ({ status: 1 }),
    }),
    /preview_deploy_failed:1/,
  );
});

test("disables automatic Git deployments and keeps runtime authorization first in every source build", () => {
  assert.equal(vercelConfig.git?.deploymentEnabled, false);
  assert.equal(Object.hasOwn(vercelConfig, "buildCommand"), false);
  assert.match(pkg.scripts.build, /^node scripts\/check-private-worker-runtime-config\.mjs && /);
});
