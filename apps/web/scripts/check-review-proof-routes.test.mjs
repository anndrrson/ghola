import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./check-review-proof-routes.mjs", import.meta.url));
const REQUIRED = {
  "/v1/[...path]/route": "server/app/v1/[...path]/route.js",
  "/v1/private-account/demo/verification-key/route":
    "server/app/v1/private-account/demo/verification-key/route.js",
  "/v1/private-account/demo/verify/route":
    "server/app/v1/private-account/demo/verify/route.js",
};

test("accepts a build containing both dedicated review routes", async () => {
  await withManifest(REQUIRED, (buildDirectory) => {
    const result = runGuard(buildDirectory);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /packaged 2 dedicated review routes/);
  });
});

test("rejects a build where the generic v1 proxy would capture the key route", async () => {
  await withManifest({ "/v1/[...path]/route": REQUIRED["/v1/[...path]/route"] }, (buildDirectory) => {
    const result = runGuard(buildDirectory);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /verification-key\/route/);
    assert.match(result.stderr, /generic upstream and returns 404/);
  });
});

async function withManifest(manifest, assertion) {
  const buildDirectory = await mkdtemp(path.join(tmpdir(), "ghola-review-routes-"));
  try {
    const serverDirectory = path.join(buildDirectory, "server");
    await mkdir(serverDirectory, { recursive: true });
    await writeFile(
      path.join(serverDirectory, "app-paths-manifest.json"),
      JSON.stringify(manifest),
      "utf8",
    );
    assertion(buildDirectory);
  } finally {
    await rm(buildDirectory, { recursive: true, force: true });
  }
}

function runGuard(buildDirectory) {
  return spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env, GHOLA_NEXT_BUILD_DIR: buildDirectory },
  });
}
