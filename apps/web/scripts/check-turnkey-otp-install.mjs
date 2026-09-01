#!/usr/bin/env node

import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

const required = [
  /verificationAttemptedRef/,
  /normalizeOtpCode/,
  /otpCode:\s*normalizedOtpCode/,
  /deferred:\s*true/,
  /\[Turnkey OTP\] verification rejected/,
  /Start over; do not retry it/,
];

const requiredCaptchaSafety = [
  /requestToken/,
  /turnstileConfigured/,
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

  const require = createRequire(import.meta.url);
  const otpRuntime = require(files[0]);
  for (const [input, expected] of [[" a1b2c3 ", "A1B2C3"], ["z9y8x7", "Z9Y8X7"]]) {
    if (otpRuntime.normalizeOtpCode(input) !== expected) {
      throw new Error("installed Turnkey OTP runtime does not normalize pasted codes");
    }
  }

  const captchaFiles = [
    path.join(root, "node_modules/@turnkey/react-wallet-kit/dist/components/auth/TurnstileWidget.js"),
    path.join(root, "node_modules/@turnkey/react-wallet-kit/dist/components/auth/TurnstileWidget.mjs"),
  ];

  for (const file of captchaFiles) {
    const source = await readFile(file, "utf8");
    for (const pattern of requiredCaptchaSafety) {
      if (!pattern.test(source)) {
        throw new Error(`${path.relative(root, file)} is missing deferred CAPTCHA safety`);
      }
    }
  }

  const authFiles = [
    path.join(root, "node_modules/@turnkey/react-wallet-kit/dist/components/auth/index.js"),
    path.join(root, "node_modules/@turnkey/react-wallet-kit/dist/components/auth/index.mjs"),
  ];
  for (const file of authFiles) {
    const source = await readFile(file, "utf8");
    if (!/beginOtpInitialization/.test(source)) {
      throw new Error(`${path.relative(root, file)} permits overlapping OTP initialization`);
    }
  }

  const modalFiles = [
    path.join(root, "node_modules/@turnkey/react-wallet-kit/dist/providers/modal/Provider.js"),
    path.join(root, "node_modules/@turnkey/react-wallet-kit/dist/providers/modal/Provider.mjs"),
  ];
  for (const file of modalFiles) {
    const source = await readFile(file, "utf8");
    if (!/dispatchEvent\(new Event\(["']ghola:turnkey-auth-modal-closed["']\)\)/.test(source)) {
      throw new Error(`${path.relative(root, file)} does not release the app modal lock on close`);
    }
  }

  const kitRoot = await realpath(path.join(root, "node_modules/@turnkey/react-wallet-kit"));
  const kitPackage = JSON.parse(await readFile(path.join(kitRoot, "package.json"), "utf8"));
  if (kitPackage.version !== "2.4.3" || kitPackage.dependencies?.["@turnkey/core"] !== "2.8.1") {
    throw new Error("Turnkey OTP runtime is not pinned to wallet-kit 2.4.3 / core 2.8.1");
  }
  for (const extension of ["js", "mjs"]) {
    const coreSource = await readFile(
      path.resolve(kitRoot, `../core/dist/__clients__/core.${extension}`),
      "utf8",
    );
    if (!/attested stamper[\s\S]*?stampLogin/.test(coreSource)) {
      throw new Error(`Turnkey OTP ${extension} runtime is missing attested stampLogin`);
    }

    const passkeySource = await readFile(
      path.resolve(kitRoot, `../core/dist/__stampers__/passkey/base.${extension}`),
      "utf8",
    );
    if (!/withPlatformKey[\s\S]*?\?\s*["']platform["'][\s\S]*?:\s*this\.config\.withSecurityKey[\s\S]*?\?\s*["']cross-platform["']/.test(passkeySource)) {
      throw new Error(`Turnkey passkey ${extension} runtime is missing platform/security-key routing`);
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
