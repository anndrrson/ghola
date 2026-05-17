/**
 * Post-build step that scans the prerendered HTML and publishes the
 * exact set of `'sha256-<base64>'` CSP hash sources needed to allow
 * the inline `<script>` blocks Next.js emits (the `__NEXT_DATA__`
 * payload, the bootstrap script, prefetch hints, etc.) WITHOUT
 * `'unsafe-inline'`.
 *
 * Why this exists
 * ---------------
 * SRI doesn't apply to inline scripts. With `script-src 'self'
 * 'unsafe-inline'` in our CSP, ANY inline `<script>` injected by an
 * upstream tamper would execute — defeating CSP for that category.
 * The fix per the CSP spec: enumerate the hash of every legitimate
 * inline script body and list them in `script-src`. When hash
 * sources are present and `'unsafe-inline'` is absent, the browser
 * runs ONLY inline scripts whose `sha256(body_bytes)` matches a
 * listed source.
 *
 * Approach
 * --------
 * 1. Walk `.next/server/app/` for `*.html` (the same dir
 *    `inject-script-integrity.mjs` rewrites).
 * 2. For each file, regex-match every inline `<script>` block — i.e.
 *    `<script ...>BODY</script>` where the open tag has NO `src=`
 *    attribute. Inline-with-type (e.g. `<script type="application/json"
 *    id="__NEXT_DATA__">`) is included; external (`<script src="...">`)
 *    is NOT. The Next.js HTML emitter is machine-generated and
 *    predictable, so a regex is honest here (same justification as
 *    `inject-script-integrity.mjs`).
 * 3. sha256 the EXACT bytes inside the tag (no surrounding HTML, no
 *    `<script>` markers), encode as base64.
 * 4. Deduplicate + sort the resulting `'sha256-<base64>'` strings and
 *    write them to `public/.well-known/csp-inline-hashes.json`.
 *
 * Determinism
 * -----------
 * The list is sorted and deduplicated, so two builds at the same git
 * SHA produce a byte-identical JSON file (modulo `generated_at`,
 * which is excluded from any downstream determinism check). The
 * outer manifest_sha256 in sri-manifest.json doesn't depend on this
 * file; reproducibility is preserved.
 *
 * Adding new inline-script sources
 * --------------------------------
 * If you add a third-party widget that injects an inline `<script>`,
 * re-run `npm run build` and its hash will be automatically picked
 * up here. If a script genuinely cannot be enumerated at build time
 * (e.g. truly per-request content) the right answer is a server-side
 * response transformer or a `'nonce-...'` source — not adding
 * `'unsafe-inline'` back. See the inline-script-gap follow-up in
 * SECURITY.md.
 *
 * Failure mode
 * ------------
 * If we find zero inline scripts in any prerendered HTML, something
 * is wrong with the parser (or Next.js changed its output shape).
 * Bail loudly rather than ship a CSP that quietly blocks every
 * inline block.
 */
import { createHash } from "crypto";
import { readdir, readFile, writeFile, mkdir, stat } from "fs/promises";
import { join, relative } from "path";
import { execSync } from "child_process";

const ROOT = process.cwd();
const NEXT_DIR = join(ROOT, ".next");
const APP_DIR = join(NEXT_DIR, "server", "app");
const PUBLIC_DIR = join(ROOT, "public");
const OUT_PATH = join(PUBLIC_DIR, ".well-known", "csp-inline-hashes.json");

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

// Match every `<script ...>BODY</script>` pair. We use a non-greedy
// body capture so consecutive `<script>` blocks don't collapse into
// one match. The dotAll flag is needed because the `__NEXT_DATA__`
// payload contains newlines.
const SCRIPT_BLOCK_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

function hasSrcAttr(openAttrs) {
  // Match `src="..."` or `src='...'` (with whitespace before `src` to
  // avoid false-positive matches inside other attribute values like
  // `data-src=`). The Next.js emitter always uses double quotes; we
  // accept both for safety.
  return /\bsrc\s*=\s*("[^"]*"|'[^']*')/i.test(openAttrs);
}

// Extract inline-script bodies from one HTML file. Returns an array
// of strings (the exact bytes between `<script ...>` and
// `</script>`).
function extractInlineBodies(html) {
  const bodies = [];
  for (const m of html.matchAll(SCRIPT_BLOCK_RE)) {
    const openAttrs = m[1] ?? "";
    const body = m[2] ?? "";
    if (hasSrcAttr(openAttrs)) continue;
    bodies.push(body);
  }
  return bodies;
}

function sha256Base64(body) {
  // CSP hash sources hash the raw byte content of the script tag
  // body. Encode as UTF-8 to match how the browser will hash the
  // same bytes it parsed off the wire. Node's `createHash` accepts
  // strings directly and defaults to UTF-8.
  return createHash("sha256").update(body, "utf8").digest("base64");
}

function gitCommit() {
  if (process.env.GIT_COMMIT) return process.env.GIT_COMMIT;
  try {
    return execSync("git rev-parse HEAD", {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

async function main() {
  const ok = await stat(NEXT_DIR).then(
    () => true,
    () => false,
  );
  if (!ok) {
    console.error(
      `[csp-inline] ${relative(ROOT, NEXT_DIR)} not found — run \`next build\` first.`,
    );
    process.exit(1);
  }

  const htmlFiles = await walkHtml(APP_DIR);
  if (htmlFiles.length === 0) {
    console.error(
      `[csp-inline] no .html files under ${relative(ROOT, APP_DIR)} — Next.js may have changed its output layout.`,
    );
    process.exit(1);
  }

  const seen = new Set();
  let totalBlocks = 0;
  for (const file of htmlFiles) {
    const html = await readFile(file, "utf8");
    const bodies = extractInlineBodies(html);
    for (const body of bodies) {
      totalBlocks += 1;
      seen.add(`sha256-${sha256Base64(body)}`);
    }
  }

  if (totalBlocks === 0) {
    // Loud failure per requirement: zero inline scripts means the
    // parser is broken or Next.js stopped emitting inline blocks.
    // Either way, ship-with-zero-hashes would break the live site
    // once CSP is enforcing, so fail the build instead.
    console.error(
      `[csp-inline] scanned ${htmlFiles.length} HTML files and found ZERO inline <script> blocks. ` +
        `Next.js always emits inline bootstrap/__NEXT_DATA__ scripts on prerendered pages, ` +
        `so this almost certainly means the parser is broken. Refusing to write an empty allowlist ` +
        `(would break the deployed site under enforcing CSP).`,
    );
    process.exit(1);
  }

  // Deterministic ordering — sort lexicographically so two builds at
  // the same SHA produce byte-identical hash lists.
  const hashes = Array.from(seen).sort();

  await mkdir(join(PUBLIC_DIR, ".well-known"), { recursive: true });
  const payload = {
    version: 1,
    generated_at: new Date().toISOString(),
    git_commit: gitCommit(),
    hashes,
  };
  await writeFile(OUT_PATH, JSON.stringify(payload, null, 2));
  console.log(
    `[csp-inline] scanned ${htmlFiles.length} HTML files, found ${totalBlocks} inline <script> block(s), ${hashes.length} unique hash(es) → ${relative(ROOT, OUT_PATH)}`,
  );
}

main().catch((err) => {
  console.error("[csp-inline] error:", err);
  process.exit(1);
});
