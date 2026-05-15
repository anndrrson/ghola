/**
 * Post-build step that rewrites the HTML emitted by `next build` so that
 * every same-origin `<script src="/_next/...">` and `<link rel="modulepreload"
 * href="/_next/...">` (plus `<link rel="preload" as="script" href="/_next/...">`)
 * tag carries `integrity="sha384-..."` + `crossorigin="anonymous"`.
 *
 * Why this exists
 * ---------------
 * `apps/web/scripts/build-sri-manifest.mjs` already publishes the
 * authoritative hashes at `/.well-known/sri-manifest.json`, and the service
 * worker at `apps/web/public/sw.js` enforces them on second+ load. But on
 * the very first visit the SW isn't active yet, and Next.js emits its
 * `<script>` tags without an `integrity=` attribute. A compromised CDN
 * (or a malicious cache layer between us and the visitor) can swap the
 * entry bundle and the browser will happily execute it. That's the last
 * meaningful first-load supply-chain hole and this script closes it.
 *
 * Approach
 * --------
 * 1. Load the manifest written by `build-sri-manifest.mjs`. If it's
 *    missing the script exits with a non-zero status — the order
 *    in `package.json` matters.
 * 2. Walk `.next/` recursively for `*.html` files. Next.js stores the
 *    prerendered output for App Router pages under `.next/server/app/`
 *    (e.g. `index.html`, `agents.html`, dynamic shells like
 *    `r/[hash]/page.html` if they ever get prerendered).
 * 3. For each file, use a regex-based rewrite (Next.js's emitted HTML is
 *    machine-generated and predictable, so a regex is honest and safe
 *    here) over `<script ... src="/_next/...">` and `<link ...
 *    href="/_next/...">` tags. If the manifest has a `sha384` entry for
 *    the referenced path, splice `integrity` + `crossorigin` into the
 *    attribute list. If the tag already has an `integrity=` attribute we
 *    leave it alone — that's what makes re-runs idempotent.
 * 4. Skip tags that point at paths NOT in the manifest. Next emits the
 *    occasional reference to assets we don't hash (third-party CDN
 *    chunks via `next/script`, etc.); failing on those would be wrong.
 *
 * What this DOESN'T cover
 * -----------------------
 * - Dynamically server-rendered pages: their HTML is produced on each
 *   request by the Next.js runtime, not at build time, so a post-build
 *   rewrite can't reach them. The fix for those is server-side
 *   injection (e.g. an `instrumentation.ts` hook or a Next response
 *   transformer); tracked as a follow-up.
 * - Inline `<script>` blocks (the `__NEXT_DATA__` JSON and the boot
 *   script Next.js emits). SRI doesn't apply to inline scripts; CSP's
 *   `script-src 'sha256-...'` is the lever there.
 *
 * Determinism note
 * ----------------
 * The manifest is computed from `.next/static/` BEFORE this script
 * runs. This script only mutates `.next/server/app/*.html` (not
 * checked into git, not part of the manifest input). So
 * `verify-reproducible-build.sh` — which compares `manifest_sha256` —
 * is unaffected. Two builds at the same SHA still produce the same
 * manifest hash.
 */
import { readdir, readFile, writeFile, stat } from "fs/promises";
import { join, relative } from "path";

const ROOT = process.cwd();
const NEXT_DIR = join(ROOT, ".next");
const MANIFEST_PATH = join(
  ROOT,
  "public",
  ".well-known",
  "sri-manifest.json",
);

async function loadManifest() {
  let raw;
  try {
    raw = await readFile(MANIFEST_PATH, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      console.error(
        `[inject-sri] manifest not found at ${relative(ROOT, MANIFEST_PATH)}.`,
      );
      console.error(
        "[inject-sri] run scripts/build-sri-manifest.mjs first (the npm",
      );
      console.error("[inject-sri] build script wires this for you).");
      process.exit(1);
    }
    throw err;
  }
  const parsed = JSON.parse(raw);
  const byPath = new Map();
  for (const f of parsed.files) {
    byPath.set(f.path, f);
  }
  return byPath;
}

async function walkHtml(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const out = [];
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walkHtml(p)));
    } else if (e.isFile() && p.endsWith(".html")) {
      out.push(p);
    }
  }
  return out;
}

// Extract a `src=` or `href=` attribute value from a tag string.
function attrValue(tag, name) {
  // Supports both double and single quoted values. Next.js uses double.
  const re = new RegExp(`\\s${name}=("([^"]*)"|'([^']*)')`, "i");
  const m = tag.match(re);
  if (!m) return null;
  return m[2] ?? m[3] ?? null;
}

function hasAttr(tag, name) {
  return new RegExp(`\\s${name}\\s*=`, "i").test(tag);
}

// Splice `integrity` + `crossorigin` attributes into a tag right before
// the closing `>` (or `/>` for self-closing). Keeps original formatting
// intact so the diff for review is minimal.
function spliceAttrs(tag, sri) {
  const inject = ` integrity="${sri}" crossorigin="anonymous"`;
  // Handle self-closing `/>` first.
  if (/\/\s*>$/.test(tag)) {
    return tag.replace(/\s*\/\s*>$/, `${inject}/>`);
  }
  return tag.replace(/\s*>$/, `${inject}>`);
}

// Returns { rewritten: string, count: number }.
function rewriteHtml(html, manifest) {
  let count = 0;

  // <script ... src="/_next/..."> ... we match the OPEN tag only (not
  // any body, which for script tags isn't an issue at the open-tag boundary).
  const scriptTagRe = /<script\b[^>]*\bsrc=("[^"]*"|'[^']*')[^>]*>/gi;
  html = html.replace(scriptTagRe, (tag) => {
    const src = attrValue(tag, "src");
    if (!src || !src.startsWith("/_next/")) return tag;
    if (hasAttr(tag, "integrity")) return tag; // idempotent
    const entry = manifest.get(src);
    if (!entry) return tag; // not hashed by us, leave it
    count += 1;
    return spliceAttrs(tag, entry.sha384);
  });

  // <link ... href="/_next/..."> — only when it's an asset reference we
  // care about: rel=modulepreload OR (rel=preload AND as=script|style|font).
  // SRI is permitted on `<link rel="preload" as="script">` and
  // `<link rel="modulepreload">`. We also tag CSS preloads since they're
  // in the manifest, but Next typically uses `<link rel="stylesheet">`
  // for CSS which DOES support integrity.
  const linkTagRe = /<link\b[^>]*\bhref=("[^"]*"|'[^']*')[^>]*\/?>/gi;
  html = html.replace(linkTagRe, (tag) => {
    const href = attrValue(tag, "href");
    if (!href || !href.startsWith("/_next/")) return tag;
    if (hasAttr(tag, "integrity")) return tag; // idempotent
    const rel = (attrValue(tag, "rel") || "").toLowerCase();
    // Only inject for tags where SRI is meaningful + supported.
    const eligible =
      rel === "modulepreload" ||
      rel === "stylesheet" ||
      rel === "preload";
    if (!eligible) return tag;
    const entry = manifest.get(href);
    if (!entry) return tag;
    count += 1;
    return spliceAttrs(tag, entry.sha384);
  });

  return { rewritten: html, count };
}

async function main() {
  // Confirm `.next` exists.
  const ok = await stat(NEXT_DIR).then(
    () => true,
    () => false,
  );
  if (!ok) {
    console.error(
      `[inject-sri] ${relative(ROOT, NEXT_DIR)} not found — run \`next build\` first.`,
    );
    process.exit(1);
  }

  const manifest = await loadManifest();
  const htmlFiles = await walkHtml(NEXT_DIR);
  if (htmlFiles.length === 0) {
    console.warn(
      "[inject-sri] no .html files under .next/ — nothing to do.",
    );
    return;
  }

  let totalInjected = 0;
  let filesTouched = 0;
  for (const file of htmlFiles) {
    const original = await readFile(file, "utf8");
    const { rewritten, count } = rewriteHtml(original, manifest);
    if (count > 0 && rewritten !== original) {
      await writeFile(file, rewritten);
      totalInjected += count;
      filesTouched += 1;
    }
  }

  console.log(
    `[inject-sri] injected ${totalInjected} integrity attributes across ${filesTouched}/${htmlFiles.length} HTML files`,
  );
  console.log(
    `[inject-sri] manifest entries available: ${manifest.size}`,
  );
  if (totalInjected === 0) {
    // Not necessarily an error — could be a re-run. But surface it.
    console.warn(
      "[inject-sri] zero attributes injected. Either this is a re-run on already-injected output, or no HTML referenced manifest entries.",
    );
  }
}

main().catch((err) => {
  console.error("[inject-sri] error:", err);
  process.exit(1);
});
