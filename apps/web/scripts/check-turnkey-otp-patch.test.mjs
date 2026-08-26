import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const patchPath = new URL("../patches/@turnkey__react-wallet-kit@2.3.1.patch", import.meta.url);

test("Turnkey OTP patch prevents stale or repeated verification", async () => {
  const source = await readFile(patchPath, "utf8");

  assert.match(source, /disabled:\s*submitting \|\| verificationAttempted[\s\S]*?otpId/);
  assert.match(source, /if \(submitting \|\| verificationAttempted\) return/);
  assert.match(source, /\[Turnkey OTP\] verification rejected/);
  assert.match(source, /Start over; do not retry it/);
  assert.doesNotMatch(source, /^\+.*throw new Error\(["`]Error completing OTP/gm);
});
