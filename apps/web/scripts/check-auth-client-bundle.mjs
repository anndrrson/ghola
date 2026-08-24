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
    file: "src/lib/google-auth-client.ts",
    patterns: [
      { label: "redirect UX mode", pattern: /ux_mode:\s*["']redirect["']/ },
      { label: "fixed same-origin callback", pattern: /GOOGLE_AUTH_CALLBACK_PATH/ },
    ],
  },
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

  let chunkDir = null;
  for (const candidate of chunkDirCandidates) {
    const found = await stat(candidate).then((info) => info.isDirectory(), () => false);
    if (found) {
      chunkDir = candidate;
      break;
    }
  }
  if (!chunkDir) {
    console.error(`[auth-bundle-guard] missing built client chunks; checked ${chunkDirCandidates.join(", ")}`);
    process.exit(1);
  }

  const files = await walk(chunkDir);
  const hits = [];

  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const rule of forbidden) {
      if (rule.pattern.test(text)) {
        hits.push({
          file: path.relative(root, file),
          label: rule.label,
        });
      }
    }
  }

  if (hits.length) {
    console.error("[auth-bundle-guard] forbidden client auth routing found:");
    for (const hit of hits) {
      console.error(`- ${hit.file}: ${hit.label}`);
    }
    console.error("Browser session auth must call same-origin /api/auth/session/* routes only.");
    process.exit(1);
  }

  console.log(`[auth-bundle-guard] scanned ${files.length} client chunk(s); session auth is same-origin safe and Google uses the verified redirect callback`);
}

await main();
