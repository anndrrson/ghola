import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

import { verifyTurnkeyOtpInstall } from "./check-turnkey-otp-install.mjs";

const patchPath = new URL("../patches/@turnkey__react-wallet-kit@2.4.3.patch", import.meta.url);
const corePatchPath = new URL("../patches/@turnkey__core@2.8.1.patch", import.meta.url);

test("Turnkey OTP patch prevents stale or repeated verification", async () => {
  const source = await readFile(patchPath, "utf8");

  assert.match(source, /disabled:\s*submitting \|\| verificationAttempted[\s\S]*?otpId/);
  assert.match(source, /if \(verificationAttemptedRef\.current\) return/);
  assert.match(source, /verificationAttemptedRef\.current = true/);
  assert.match(source, /normalizeOtpCode[\s\S]*?\.toUpperCase\(\)/);
  assert.match(source, /otpCode:\s*normalizedOtpCode/);
  assert.match(source, /beginOtpInitialization/);
  assert.match(source, /publicKey\s*=\s*await createApiKeyPair\(\)[\s\S]*?await initOtp/);
  assert.match(source, /publicKey:\s*publicKey/);
  assert.match(source, /dispatchEvent\(new Event\(["']ghola:turnkey-auth-modal-closed["']\)\)/);
  assert.match(source, /\[Turnkey OTP\] verification rejected/);
  assert.match(source, /Start over; do not retry it/);
  assert.doesNotMatch(source, /detail\.includes\(["']not found["']\)/);
  assert.match(source, /if \(!turnstileConfigured\) return \{\}/);
  assert.doesNotMatch(source, /^\+.*throw new Error\(["`]Error completing OTP/gm);
});

test("Turnkey key-store patch repairs stale Preview databases", async () => {
  const source = await readFile(corePatchPath, "utf8");

  assert.match(source, /indexedDB\.open\(DB_NAME\)/);
  assert.match(source, /objectStoreNames\.contains\(DB_STORE\)/);
  assert.match(source, /indexedDB\.open\(DB_NAME, nextVersion\)/);
  assert.match(source, /onversionchange\s*=\s*\(\)\s*=>\s*.*\.close\(\)/);
  assert.match(source, /tx\.onabort/);
  assert.doesNotMatch(source, /^\+.*indexedDB\.open\(DB_NAME, 1\)/gm);
});

test("installed Turnkey OTP runtime contains the safety patch", async () => {
  await verifyTurnkeyOtpInstall();

  const vercelConfig = await readFile(new URL("../vercel.json", import.meta.url), "utf8");
  const packageJson = await readFile(new URL("../package.json", import.meta.url), "utf8");
  const workspaceConfig = await readFile(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8");
  assert.match(vercelConfig, /"installCommand":\s*"ONNXRUNTIME_NODE_INSTALL=skip corepack pnpm@10\.34\.5 install --frozen-lockfile"/);
  assert.match(packageJson, /check-turnkey-otp-install\.mjs/);
  assert.match(workspaceConfig, /'@turnkey\/core@2\.8\.1':\s*patches\/@turnkey__core@2\.8\.1\.patch/);
  assert.match(workspaceConfig, /'@turnkey\/react-wallet-kit@2\.4\.3':\s*patches\/@turnkey__react-wallet-kit@2\.4\.3\.patch/);
});

test("release installs preserve the pinned Turnkey patches", async () => {
  const [ci, siteCanary, supplyChain, packageJson, reproducibleBuild, siteSmoke] = await Promise.all([
    readFile(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8"),
    readFile(new URL("../../../.github/workflows/site-canary.yml", import.meta.url), "utf8"),
    readFile(new URL("../../../.github/workflows/supply-chain.yml", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("./verify-reproducible-build.sh", import.meta.url), "utf8"),
    readFile(new URL("./smoke-site-load.mjs", import.meta.url), "utf8"),
  ]);

  for (const workflow of [ci, siteCanary]) {
    assert.match(workflow, /pnpm\/action-setup@v4[\s\S]*?version:\s*10\.34\.5/);
    assert.match(workflow, /cache:\s*pnpm/);
    assert.match(workflow, /cache-dependency-path:\s*apps\/web\/pnpm-lock\.yaml/);
    assert.match(workflow, /pnpm install --frozen-lockfile/);
    assert.doesNotMatch(workflow, /\bnpm ci\b/);
  }

  assert.match(packageJson, /"packageManager":\s*"pnpm@10\.34\.5"/);
  assert.match(packageJson, /"security:check":\s*"pnpm test && pnpm run lint"/);
  assert.match(ci, /release-gate:[\s\S]*?pnpm\/action-setup@v4[\s\S]*?version:\s*10\.34\.5[\s\S]*?pnpm --dir apps\/web audit --prod/);
  assert.match(ci, /pnpm_audit_rc[\s\S]*?\-gt 1[\s\S]*?metadata\.dependencies/);
  assert.match(ci, /--argjson pnpm_high[\s\S]*?pnpm_audit_high:\s*\$pnpm_high/);
  assert.doesNotMatch(ci, /\$npm_(high|critical)/);
  assert.match(supplyChain, /pnpm-audit-web:[\s\S]*?pnpm\/action-setup@v4[\s\S]*?pnpm --dir apps\/web audit --audit-level=high/);
  assert.match(siteSmoke, /from ["']@playwright\/test["']/);
  assert.doesNotMatch(siteSmoke, /from ["']playwright["']/);
  assert.match(reproducibleBuild, /pnpm run build/);
  assert.doesNotMatch(reproducibleBuild, /(^|\s)npm run build/m);
  await assert.rejects(access(new URL("../package-lock.json", import.meta.url)));
});
