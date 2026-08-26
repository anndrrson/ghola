import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { verifyTurnkeyOtpInstall } from "./check-turnkey-otp-install.mjs";

const patchPath = new URL("../patches/@turnkey__react-wallet-kit@2.3.1.patch", import.meta.url);

test("Turnkey OTP patch prevents stale or repeated verification", async () => {
  const source = await readFile(patchPath, "utf8");

  assert.match(source, /disabled:\s*submitting \|\| verificationAttempted[\s\S]*?otpId/);
  assert.match(source, /if \(submitting \|\| verificationAttempted\) return/);
  assert.match(source, /\[Turnkey OTP\] verification rejected/);
  assert.match(source, /Start over; do not retry it/);
  assert.doesNotMatch(source, /^\+.*throw new Error\(["`]Error completing OTP/gm);
});

test("installed Turnkey OTP runtime contains the safety patch", async () => {
  await verifyTurnkeyOtpInstall();

  const vercelConfig = await readFile(new URL("../vercel.json", import.meta.url), "utf8");
  const packageJson = await readFile(new URL("../package.json", import.meta.url), "utf8");
  assert.match(vercelConfig, /"installCommand":\s*"pnpm install --frozen-lockfile"/);
  assert.match(packageJson, /check-turnkey-otp-install\.mjs/);
});
