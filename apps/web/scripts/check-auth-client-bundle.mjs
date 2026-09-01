#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();

function vercelOutputRoots() {
  return Array.from(new Set([
    process.env.VERCEL_OUTPUT_DIR,
    path.join(root, ".vercel", "output"),
    path.resolve(root, "../..", ".vercel", "output"),
    process.env.VERCEL ? "/vercel/output" : null,
  ].filter(Boolean)));
}

const chunkDirCandidates = [
  path.join(root, ".next", "static", "chunks"),
  ...vercelOutputRoots().map((outputRoot) =>
    path.join(outputRoot, "static", "_next", "static", "chunks")
  ),
];

const requiredGoogleRedirectSources = [
  {
    file: "vercel.json",
    patterns: [
      { label: "pinned patch-aware Vercel install", pattern: /"installCommand":\s*"ONNXRUNTIME_NODE_INSTALL=skip corepack pnpm@10\.34\.5 install --frozen-lockfile"/ },
    ],
  },
  {
    file: "pnpm-workspace.yaml",
    patterns: [
      { label: "Turnkey OTP patched dependency declaration", pattern: /'@turnkey\/react-wallet-kit@2\.4\.3':\s*patches\/@turnkey__react-wallet-kit@2\.4\.2\.patch/ },
    ],
  },
  {
    file: "package.json",
    patterns: [
      { label: "installed Turnkey OTP pre-build guard", pattern: /check-turnkey-otp-install\.mjs/ },
    ],
  },
  {
    file: "src/lib/perps-turnkey-provider.tsx",
    patterns: [
      { label: "platform-only Ghola passkey configuration", pattern: /withPlatformKey:\s*true/ },
      { label: "attempt-bound Turnkey session key", pattern: /sessionKey:\s*attempt\.attemptId/ },
      { label: "exact active Turnkey session resolution", pattern: /resolveExactActivePerpsTurnkeySession/ },
      { label: "atomic pending-to-identity commit", pattern: /withPerpsTurnkeyStorageLock\(["']pending["'][\s\S]*?withPerpsTurnkeyStorageLock\(["']identity["']/ },
      { label: "targeted Turnkey logout", pattern: /turnkey\.logout\(\{\s*sessionKey/ },
    ],
  },
  {
    file: "src/app/api/turnkey/sign-message/route.ts",
    patterns: [
      { label: "session-bound Turnkey signing ownership check", pattern: /sessionOwnsTurnkeyWallet\(\{/ },
      { label: "fail-closed Turnkey wallet ownership response", pattern: /turnkey_wallet_session_mismatch/ },
    ],
  },
  {
    file: "src/app/api/turnkey/_ownership.ts",
    patterns: [
      { label: "authoritative email-to-sub-org ownership lookup", pattern: /filterType:\s*["']EMAIL["']/ },
      { label: "exact Turnkey wallet account binding", pattern: /account\.address === walletAddress/ },
    ],
  },
  {
    file: "patches/@turnkey__core@2.8.0.patch",
    patterns: [
      { label: "Turnkey platform authenticator selection", pattern: /this\.config\.withPlatformKey[\s\S]*?["']platform["']/ },
    ],
  },
  {
    file: "patches/@turnkey__react-wallet-kit@2.4.2.patch",
    patterns: [
      { label: "fresh OTP fields after resend", pattern: /disabled:\s*submitting \|\| verificationAttempted[\s\S]*?otpId/ },
      { label: "single OTP attempt per challenge", pattern: /if \(verificationAttemptedRef\.current\) return/ },
      { label: "case-normalized OTP submission", pattern: /otpCode:\s*normalizedOtpCode/ },
      { label: "single OTP initialization per modal", pattern: /beginOtpInitialization/ },
      { label: "modal-lifetime lock release", pattern: /ghola:turnkey-auth-modal-closed/ },
      { label: "actionable Turnkey OTP diagnostics", pattern: /\[Turnkey OTP\] verification rejected/ },
      { label: "no blind OTP retry", pattern: /Start over; do not retry it/ },
      { label: "unconfigured CAPTCHA fast path", pattern: /if \(!turnstileConfigured\) return \{\}/ },
    ],
  },
  {
    file: "src/lib/google-auth-client.ts",
    patterns: [
      { label: "redirect UX mode", pattern: /ux_mode:\s*["']redirect["']/ },
      { label: "fixed same-origin callback", pattern: /GOOGLE_AUTH_CALLBACK_PATH/ },
      { label: "exact Google origin allowlist", pattern: /NEXT_PUBLIC_GOOGLE_AUTH_ALLOWED_ORIGINS/ },
      { label: "fail-closed Google origin gate", pattern: /isGoogleAuthOriginAllowed\(window\.location\.origin/ },
    ],
  },
  ...[
    "src/components/AuthModal.tsx",
    "src/app/signin/page.tsx",
    "src/app/signup/page.tsx",
  ].map((file) => ({
    file,
    patterns: [
      { label: "Google origin availability gate", pattern: /googleAuthAvailableForCurrentOrigin/ },
      { label: "Google UI exact-origin gate", pattern: /googleOriginAllowed\s*&&\s*googleAvailable/ },
    ],
  })),
  {
    file: "src/app/api/auth/session/google/callback/route.ts",
    patterns: [
      { label: "Google double-submit CSRF check", pattern: /g_csrf_token/ },
      { label: "server session cookie", pattern: /withSessionCookie/ },
      { label: "internal-only return path", pattern: /safeInternalRedirect/ },
    ],
  },
];

const forbidden = [
  {
    label: "absolute upstream session auth URL",
    pattern: /https?:\/\/[^"'`\s]+\/api\/auth\/session\//,
  },
  {
    label: "Thumper upstream session auth path",
    pattern: /thumper-cloud\.onrender\.com\/api\/auth\/session\//,
  },
  {
    label: "API subdomain session auth path",
    pattern: /api\.ghola\.xyz\/api\/auth\/session\//,
  },
];

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".js")) files.push(fullPath);
  }
  return files;
}

async function walkSource(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkSource(fullPath));
      continue;
    }
    if (
      entry.isFile() &&
      /\.(?:js|jsx|mjs|ts|tsx)$/.test(entry.name) &&
      !/\.(?:test|spec)\.(?:js|jsx|mjs|ts|tsx)$/.test(entry.name)
    ) files.push(fullPath);
  }
  return files;
}

async function findForbidden(files) {
  const hits = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const rule of forbidden) {
      if (rule.pattern.test(source)) {
        hits.push({
          file: path.relative(root, file),
          label: rule.label,
        });
      }
    }
  }
  return hits;
}

function failForbidden(hits, scope) {
  if (!hits.length) return;
  console.error(`[auth-bundle-guard] forbidden auth routing found in ${scope}:`);
  for (const hit of hits) {
    console.error(`- ${hit.file}: ${hit.label}`);
  }
  console.error("Browser session auth must call same-origin /api/auth/session/* routes only.");
  process.exit(1);
}

async function main() {
  for (const requirement of requiredGoogleRedirectSources) {
    const source = await readFile(path.join(root, requirement.file), "utf8");
    for (const rule of requirement.patterns) {
      if (!rule.pattern.test(source)) {
        console.error(
          `[auth-bundle-guard] ${requirement.file} is missing ${rule.label}`,
        );
        process.exit(1);
      }
    }
  }

  const sourceFiles = await walkSource(path.join(root, "src"));
  failForbidden(await findForbidden(sourceFiles), "source");

  let chunkDir = null;
  for (const candidate of chunkDirCandidates) {
    const found = await stat(candidate).then((info) => info.isDirectory(), () => false);
    if (found) {
      chunkDir = candidate;
      break;
    }
  }
  if (!chunkDir) {
    // Next 16's Vercel adapter packages and removes `.next/static` inside
    // onBuildComplete before package.json post-build commands resume. The
    // source scan above remains mandatory on Vercel; local and CI release
    // builds retain the stricter emitted-bundle scan below.
    if (process.env.VERCEL) {
      console.log(
        `[auth-bundle-guard] scanned ${sourceFiles.length} source file(s); Vercel adapter owns emitted chunks`,
      );
      return;
    }
    console.error(`[auth-bundle-guard] missing built client chunks; checked ${chunkDirCandidates.join(", ")}`);
    process.exit(1);
  }

  const files = await walk(chunkDir);
  failForbidden(await findForbidden(files), "built client chunks");

  console.log(`[auth-bundle-guard] scanned ${files.length} client chunk(s); session auth is same-origin safe and Google uses the verified redirect callback`);
}

await main();
