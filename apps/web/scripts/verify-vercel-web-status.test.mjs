import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { verifyVercelWebStatus, VERCEL_WEB_CONTEXT } from "./verify-vercel-web-status.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(scriptDir, "..");
const repoRoot = resolve(webRoot, "../..");

const completed = {
  context: VERCEL_WEB_CONTEXT,
  state: "success",
  description: "Deployment has completed",
  targetUrl: "https://vercel.com/example/web/deployment-id",
  sha: "81bb796b",
};

test("accepts only a completed Vercel web deployment", () => {
  assert.deepEqual(verifyVercelWebStatus(completed), {
    context: VERCEL_WEB_CONTEXT,
    state: "success",
    description: "Deployment has completed",
    target_url: completed.targetUrl,
    sha: completed.sha,
  });
});

test("rejects Vercel's green canceled-by-ignore result", () => {
  assert.throws(
    () => verifyVercelWebStatus({
      ...completed,
      description: "Canceled by Ignored Build Step",
    }),
    /was not built/,
  );
});

test("rejects non-success and incomplete status events", () => {
  assert.throws(
    () => verifyVercelWebStatus({ ...completed, state: "failure" }),
    /not successful/,
  );
  assert.throws(
    () => verifyVercelWebStatus({ ...completed, description: "Checks passed" }),
    /not a completed deployment/,
  );
});

test("requires the exact web context, deployment URL, and commit SHA", () => {
  assert.throws(
    () => verifyVercelWebStatus({ ...completed, context: "Vercel – repo" }),
    /unexpected Vercel status context/,
  );
  assert.throws(
    () => verifyVercelWebStatus({ ...completed, targetUrl: "" }),
    /missing its deployment target URL/,
  );
  assert.throws(
    () => verifyVercelWebStatus({ ...completed, sha: "not-a-sha" }),
    /valid commit SHA/,
  );
});

test("Vercel uploads every local package required by the web app", () => {
  const webPackage = JSON.parse(readFileSync(resolve(webRoot, "package.json"), "utf8"));
  const ignoreRules = new Set(
    readFileSync(resolve(repoRoot, ".vercelignore"), "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim()),
  );

  for (const dependency of Object.values(webPackage.dependencies || {})) {
    if (typeof dependency !== "string" || !dependency.startsWith("file:")) continue;

    const packagePath = relative(
      repoRoot,
      resolve(webRoot, dependency.slice("file:".length)),
    ).replaceAll("\\", "/");

    assert.ok(
      ignoreRules.has(`!${packagePath}`) && ignoreRules.has(`!${packagePath}/**`),
      `${packagePath} must be included in .vercelignore`,
    );
  }
});

test("release keeps Hyperliquid onboarding on one resumable pending wallet", () => {
  const cockpit = readFileSync(
    resolve(webRoot, "src/components/private-account/PrivateAccountCockpit.tsx"),
    "utf8",
  );
  const pendingStore = readFileSync(
    resolve(webRoot, "src/lib/hyperliquid-pending-api-wallet.ts"),
    "utf8",
  );

  assert.match(cockpit, /resumePendingHyperliquidApiWallet/);
  assert.match(cockpit, /resumeOrCreatePendingHyperliquidApiWallet/);
  assert.match(cockpit, /getHyperliquidApiWalletAuthorization/);
  assert.match(cockpit, /Revoke this exact trade-only wallet on Hyperliquid before replacement/);
  assert.match(cockpit, /await clearPendingHyperliquidApiWallet/);
  assert.doesNotMatch(cockpit, /generateHyperliquidApiWallet\(\)/);
  assert.match(pendingStore, /"AES-GCM"/);
  assert.match(pendingStore, /pendingSlotId\(userDid, input\.network\)/);
  assert.match(pendingStore, /objectStore\(STORE_PENDING\)\.add\(row\)/);
});
