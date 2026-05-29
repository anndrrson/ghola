#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const chunkDir = path.join(root, ".next", "static", "chunks");

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
  try {
    const info = await stat(chunkDir);
    if (!info.isDirectory()) throw new Error(`${chunkDir} is not a directory`);
  } catch {
    console.error("[auth-bundle-guard] missing .next/static/chunks; run next build first");
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

  console.log(`[auth-bundle-guard] scanned ${files.length} client chunk(s); session auth is same-origin safe`);
}

await main();
