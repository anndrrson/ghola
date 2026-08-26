#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const required = [
  /verificationAttempted/,
  /\[Turnkey OTP\] verification rejected/,
  /Start over; do not retry it/,
];

export async function verifyTurnkeyOtpInstall(root = process.cwd()) {
  const files = [
    path.join(root, "node_modules/@turnkey/react-wallet-kit/dist/components/auth/OTP.js"),
    path.join(root, "node_modules/@turnkey/react-wallet-kit/dist/components/auth/OTP.mjs"),
  ];

  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const pattern of required) {
      if (!pattern.test(source)) {
        throw new Error(`${path.relative(root, file)} is missing the Ghola OTP safety patch`);
      }
    }
    if (/Error completing OTP/.test(source)) {
      throw new Error(`${path.relative(root, file)} still contains the unsafe OTP retry path`);
    }
  }
}

try {
  await verifyTurnkeyOtpInstall();
  console.log("[turnkey-otp-install] verified patched runtime");
} catch (error) {
  console.error(`[turnkey-otp-install] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
