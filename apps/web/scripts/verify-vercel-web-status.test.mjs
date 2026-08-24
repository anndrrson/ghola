import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_EVIDENCE_PATH } from "./verify-hyperliquid-release-evidence.mjs";
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

test("Vercel uploads every file required by post-build release validation", () => {
  const ignoreRules = new Set(
    readFileSync(resolve(repoRoot, ".vercelignore"), "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim()),
  );
  const evidencePath = relative(repoRoot, DEFAULT_EVIDENCE_PATH).replaceAll("\\", "/");
  const requiredRules = [
    "!deploy",
    "!deploy/evidence",
    `!${evidencePath}`,
    "!crates",
    "!crates/said-shielded-pool-circuits",
    "!crates/said-shielded-pool-circuits/artifacts",
    "!crates/said-shielded-pool-circuits/artifacts/**",
  ];

  for (const rule of requiredRules) {
    assert.ok(ignoreRules.has(rule), `${rule} must be included in .vercelignore`);
  }
});

test("Vercel auth validation scans source when the Next adapter owns emitted chunks", () => {
  const authGuard = readFileSync(
    resolve(webRoot, "scripts/check-auth-client-bundle.mjs"),
    "utf8",
  );

  assert.match(authGuard, /walkSource\(path\.join\(root, "src"\)\)/);
  assert.match(authGuard, /failForbidden\(await findForbidden\(sourceFiles\), "source"\)/);
  assert.match(authGuard, /if \(process\.env\.VERCEL\)/);
  assert.match(authGuard, /Vercel adapter owns emitted chunks/);
});

test("release keeps Hyperliquid onboarding on one resumable wallet per authenticated owner lane", () => {
  const cockpit = readFileSync(
    resolve(webRoot, "src/components/private-account/PrivateAccountCockpit.tsx"),
    "utf8",
  );
  const pendingStore = readFileSync(
    resolve(webRoot, "src/lib/hyperliquid-pending-api-wallet.ts"),
    "utf8",
  );
  const ownerAuthorization = readFileSync(
    resolve(webRoot, "src/lib/hyperliquid-owner-authorization.ts"),
    "utf8",
  );
  const agentPolicy = readFileSync(
    resolve(webRoot, "src/lib/hyperliquid-agent-policy.ts"),
    "utf8",
  );

  assert.match(cockpit, /resumePendingHyperliquidApiWallet/);
  assert.match(cockpit, /authScope: accountCommitment/);
  assert.match(cockpit, /const ownerAddress = await connectInjectedHyperliquidOwner\(provider\)/);
  assert.match(cockpit, /focusedHyperliquidWalletProvisioning\.current = true/);
  assert.match(cockpit, /void ensureHyperliquidSigningWallet\(\)\.finally/);
  assert.match(cockpit, /resumeOrCreatePendingHyperliquidApiWallet/);
  assert.match(cockpit, /getHyperliquidApiWalletAuthorization/);
  assert.match(cockpit, /authorizeHyperliquidAgentWithInjectedOwner/);
  assert.match(cockpit, /authorizationStatus\?\.authorized === true/);
  assert.match(cockpit, /named_slot_available/);
  assert.match(cockpit, /Ghola detects the venue state automatically/);
  assert.match(cockpit, /Revoke this exact trade-only wallet on Hyperliquid before replacement/);
  assert.match(cockpit, /await clearPendingHyperliquidApiWallet/);
  assert.doesNotMatch(cockpit, /generateHyperliquidApiWallet\(\)/);
  assert.match(pendingStore, /"AES-GCM"/);
  assert.match(pendingStore, /const DB_VERSION = 2/);
  assert.match(pendingStore, /authScope: string/);
  assert.match(pendingStore, /ownerAddress: string/);
  assert.match(pendingStore, /pendingSlotId\(lane\.authScope, lane\.userDid, lane\.network, lane\.ownerAddress\)/);
  assert.match(pendingStore, /`\$\{input\.authScope\}\\0\$\{input\.userDid\}\\0\$\{input\.network\}\\0\$\{input\.ownerAddress\}\\0`/);
  assert.match(pendingStore, /STORE_QUARANTINED/);
  assert.match(pendingStore, /objectStore\(STORE_PENDING\)\.add\(row\)/);
  assert.match(ownerAuthorization, /exchange\.approveAgent/);
  assert.match(ownerAuthorization, /eth_requestAccounts/);
  assert.match(agentPolicy, /GHOLA_HYPERLIQUID_AGENT_NAME = "ghola"/);
  assert.match(agentPolicy, /HYPERLIQUID_NAMED_AGENT_LIMIT = 3/);
  assert.doesNotMatch(cockpit, /generatedAgentAddress \? authorizationOpened : agentKeyConfirmed/);
});

test("release isolates local and Turnkey signing sessions by the authenticated user", () => {
  const localWalletProvider = readFileSync(
    resolve(webRoot, "src/lib/turnkey-provider.tsx"),
    "utf8",
  );
  const walletProvider = readFileSync(
    resolve(webRoot, "src/lib/wallet-provider.tsx"),
    "utf8",
  );
  const perpsProvider = readFileSync(
    resolve(webRoot, "src/lib/perps-turnkey-provider.tsx"),
    "utf8",
  );
  const perpsBoundary = readFileSync(
    resolve(webRoot, "src/lib/perps-turnkey-session-boundary.ts"),
    "utf8",
  );

  assert.match(localWalletProvider, /SCOPED_WALLET_STORAGE_PREFIX/);
  assert.match(localWalletProvider, /opaqueTurnkeyWalletScope/);
  assert.match(localWalletProvider, /migrateOrQuarantineLegacyWallet/);
  assert.match(localWalletProvider, /migrated_matching_browser_identity/);
  assert.doesNotMatch(localWalletProvider, /JSON\.stringify\(\{ version: 1, legacy \}\)/);
  assert.match(walletProvider, /key=\{authScope \|\| "signed-out"\}/);
  assert.match(walletProvider, /authResolved=\{!thumperAuth\.loading\}/);
  assert.match(perpsProvider, /opaqueTurnkeyWalletScope\(thumper\.user\?\.id \|\| ""\)/);
  assert.match(perpsProvider, /onAuthenticationSuccess/);
  assert.match(perpsProvider, /void turnkey\.logout\(\)/);
  assert.match(perpsBoundary, /thumper_identity_mismatch/);
  assert.match(perpsBoundary, /turnkey_organization_mismatch/);
  assert.match(perpsBoundary, /unbound_turnkey_session/);
});
