/**
 * Post-build step that walks the production output and publishes a
 * Subresource Integrity (SRI) manifest at `public/.well-known/sri-manifest.json`.
 *
 * Why: Next.js doesn't ship SRI on its emitted `<script>` tags, so a
 * compromised CDN serving ghola.xyz could swap a tampered bundle and
 * the browser would happily execute it — defeating the sealed
 * envelope before encryption ever runs. The manifest lets a reviewer
 * (or a tightening browser-side guard, future work) verify each loaded
 * artifact against an out-of-band hash.
 *
 * Manifest shape:
 * {
 *   "version": 1,
 *   "generated_at": "2026-05-15T..Z",
 *   "git_commit": "<sha>",  // optional, populated by CI
 *   "files": [
 *     { "path": "/_next/static/chunks/abc.js", "sha256": "...", "sha384": "..." },
 *     ...
 *   ],
 *   "manifest_sha256": "<hash of the sorted manifest body>"
 * }
 *
 * The top-level `manifest_sha256` is what you'd commit somewhere
 * tamper-evident (a git tag, a transparency log) to make the whole
 * manifest itself auditable.
 *
 * Verification (manual, until enforcing CSP/SRI lands):
 *   1. Fetch https://ghola.xyz/.well-known/sri-manifest.json
 *   2. For each entry, curl https://ghola.xyz<path>, sha256 the body
 *   3. Compare against the manifest. Mismatch = tampered.
 *
 * Failure mode: if `.next/static` doesn't exist, the script no-ops
 * (we only generate after `next build`, not after dev). It never
 * fails the build.
 */
import { createHash } from "crypto";
import { readdir, readFile, writeFile, mkdir, stat } from "fs/promises";
import { dirname, join, relative } from "path";
import { execSync } from "child_process";

const ROOT = process.cwd();
const PUBLIC_DIR = join(ROOT, "public");
const MANIFEST_PATH = join(PUBLIC_DIR, ".well-known", "sri-manifest.json");

function vercelOutputRoots() {
  return Array.from(new Set([
    process.env.VERCEL_OUTPUT_DIR,
    join(ROOT, ".vercel", "output"),
    join(ROOT, "../..", ".vercel", "output"),
    process.env.VERCEL ? "/vercel/output" : null,
  ].filter(Boolean)));
}

async function builtStaticOutput() {
  const candidates = [
    { dir: join(ROOT, ".next", "static"), outputRoot: null },
    ...vercelOutputRoots().map((outputRoot) => ({
      dir: join(outputRoot, "static", "_next", "static"),
      outputRoot,
    })),
  ];
  for (const candidate of candidates) {
    const exists = await stat(candidate.dir).then((info) => info.isDirectory(), () => false);
    if (exists) return { ...candidate, checked: candidates.map((item) => item.dir) };
  }
  return { dir: null, outputRoot: null, checked: candidates.map((item) => item.dir) };
}

async function walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const files = [];
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      files.push(...(await walk(p)));
    } else if (e.isFile() && /\.(js|css|mjs)$/.test(e.name)) {
      files.push(p);
    }
  }
  return files;
}

function gitCommit() {
  try {
    return execSync("git rev-parse HEAD", { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

async function main() {
  const staticOutput = await builtStaticOutput();
  if (!staticOutput.dir) {
    console.warn(
      `[sri-manifest] built static output not found (${staticOutput.checked.join(", ")}) — skipping. Run \`npm run build\` first.`,
    );
    return;
  }
  const files = await walk(staticOutput.dir);
  files.sort();

  const entries = await Promise.all(
    files.map(async (path) => {
      const body = await readFile(path);
      const sha256 = createHash("sha256").update(body).digest("hex");
      const sha384b64 = createHash("sha384").update(body).digest("base64");
      const rel = relative(staticOutput.dir, path).replace(/\\/g, "/");
      const publicPath = `/_next/static/${rel}`;
      return {
        path: publicPath,
        sha256,
        sha384: `sha384-${sha384b64}`,
        bytes: body.byteLength,
      };
    }),
  );

  const manifestBody = JSON.stringify({ files: entries }, null, 2);
  const manifestSha256 = createHash("sha256").update(manifestBody).digest("hex");

  const manifest = {
    version: 1,
    generated_at: new Date().toISOString(),
    git_commit: gitCommit(),
    file_count: entries.length,
    total_bytes: entries.reduce((s, e) => s + e.bytes, 0),
    files: entries,
    manifest_sha256: manifestSha256,
  };

  await mkdir(join(PUBLIC_DIR, ".well-known"), { recursive: true });
  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  if (staticOutput.outputRoot) {
    const deployedManifestPath = join(
      staticOutput.outputRoot,
      "static",
      ".well-known",
      "sri-manifest.json",
    );
    await mkdir(dirname(deployedManifestPath), { recursive: true });
    await writeFile(deployedManifestPath, JSON.stringify(manifest, null, 2));
  }
  console.log(
    `[sri-manifest] wrote ${entries.length} entries (${(manifest.total_bytes / 1024).toFixed(1)} KB) → ${relative(ROOT, MANIFEST_PATH)}`,
  );
  console.log(`[sri-manifest] manifest_sha256: ${manifestSha256}`);
}

main().catch((err) => {
  console.error("[sri-manifest] error:", err);
  process.exit(1);
});
