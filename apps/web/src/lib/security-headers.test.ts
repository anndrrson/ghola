/**
 * Regression test pinning the shape of the response security headers
 * emitted by `next.config.ts`. The runtime SRI / CSP enforcement
 * stack has been reverted once before; this test exists so the
 * specific properties we care about (HSTS present, XFO=DENY,
 * Permissions-Policy locked, `script-src` without `'unsafe-inline'`
 * when the build allowlist is loaded) cannot silently regress.
 *
 * The test uses the file at `public/.well-known/csp-inline-hashes.json`
 * as a fixture: we write a fixture there, re-import `next.config.ts`
 * via vite's cache-busting query, and assert against the freshly
 * built `SECURITY_HEADERS` array. We restore the original file
 * (or remove the fixture) at the end so we don't leak state into
 * other tests or the developer's working tree.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const INLINE_HASHES_PATH = join(
  process.cwd(),
  "public",
  ".well-known",
  "csp-inline-hashes.json",
);
const WELL_KNOWN_DIR = join(process.cwd(), "public", ".well-known");

// Snapshot whatever was on disk before this test ran so we can
// restore it in afterAll (the file is a build artifact; an in-tree
// build may have left it sitting there).
let preexisting: string | null = null;
let preexistingDir = false;

beforeAll(() => {
  preexistingDir = existsSync(WELL_KNOWN_DIR);
  if (existsSync(INLINE_HASHES_PATH)) {
    preexisting = readFileSync(INLINE_HASHES_PATH, "utf8");
  }
});

afterAll(() => {
  if (preexisting !== null) {
    writeFileSync(INLINE_HASHES_PATH, preexisting);
  } else if (existsSync(INLINE_HASHES_PATH)) {
    rmSync(INLINE_HASHES_PATH);
  }
  // Don't tear down the .well-known directory itself; other build
  // artifacts may live there (sri-manifest.json).
  if (!preexistingDir && existsSync(WELL_KNOWN_DIR)) {
    // only remove if we created it AND it's empty
    try {
      rmSync(WELL_KNOWN_DIR, { recursive: false });
    } catch {
      // non-empty, leave it
    }
  }
});

async function importConfig(suffix: string) {
  // Cache-bust the import so the module re-reads the fixture file
  // each time we toggle the allowlist on/off.
  return (await import(
    /* @vite-ignore */ `../../next.config.ts?cb=${suffix}`
  )) as {
    SECURITY_HEADERS: Array<{ key: string; value: string }>;
    buildCspHeader: () => { key: string; value: string };
  };
}

function headerMap(headers: Array<{ key: string; value: string }>) {
  const m = new Map<string, string>();
  for (const h of headers) m.set(h.key.toLowerCase(), h.value);
  return m;
}

describe("security headers (always present)", () => {
  it("includes HSTS with includeSubDomains and preload", async () => {
    // Use the dev-fallback path (allowlist missing) for the
    // always-present checks; they should be invariant either way.
    if (existsSync(INLINE_HASHES_PATH)) rmSync(INLINE_HASHES_PATH);
    const { SECURITY_HEADERS } = await importConfig("no-allowlist-1");
    const m = headerMap(SECURITY_HEADERS);
    const hsts = m.get("strict-transport-security");
    expect(hsts).toBeDefined();
    expect(hsts).toContain("max-age=");
    expect(hsts).toContain("includeSubDomains");
    expect(hsts).toContain("preload");
  });

  it("locks X-Frame-Options to DENY and X-Content-Type-Options to nosniff", async () => {
    if (existsSync(INLINE_HASHES_PATH)) rmSync(INLINE_HASHES_PATH);
    const { SECURITY_HEADERS } = await importConfig("no-allowlist-2");
    const m = headerMap(SECURITY_HEADERS);
    expect(m.get("x-frame-options")).toBe("DENY");
    expect(m.get("x-content-type-options")).toBe("nosniff");
  });

  it("sets a strict Referrer-Policy and a locked-down Permissions-Policy", async () => {
    if (existsSync(INLINE_HASHES_PATH)) rmSync(INLINE_HASHES_PATH);
    const { SECURITY_HEADERS } = await importConfig("no-allowlist-3");
    const m = headerMap(SECURITY_HEADERS);
    expect(m.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    const perm = m.get("permissions-policy") ?? "";
    for (const dir of [
      "camera=()",
      "microphone=()",
      "geolocation=()",
      "payment=()",
      "usb=()",
    ]) {
      expect(perm).toContain(dir);
    }
  });
});

describe("CSP — dev-fallback (allowlist missing)", () => {
  it("emits Content-Security-Policy-Report-Only with default-src 'self'", async () => {
    if (existsSync(INLINE_HASHES_PATH)) rmSync(INLINE_HASHES_PATH);
    const { SECURITY_HEADERS } = await importConfig("no-allowlist-4");
    const m = headerMap(SECURITY_HEADERS);
    expect(m.has("content-security-policy")).toBe(false);
    const csp = m.get("content-security-policy-report-only");
    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'self'");
  });
});

describe("CSP — enforcing (allowlist loaded)", () => {
  beforeAll(() => {
    mkdirSync(WELL_KNOWN_DIR, { recursive: true });
    // Fixture: two synthetic sha256 sources. The exact values don't
    // matter for this test — only that they're spliced into
    // `script-src` and that `'unsafe-inline'` is dropped.
    writeFileSync(
      INLINE_HASHES_PATH,
      JSON.stringify({
        version: 1,
        generated_at: new Date().toISOString(),
        git_commit: null,
        hashes: [
          "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          "sha256-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
        ],
      }),
    );
  });

  it("emits enforcing Content-Security-Policy with default-src 'self' and no 'unsafe-inline' in script-src", async () => {
    const { SECURITY_HEADERS } = await importConfig("with-allowlist-1");
    const m = headerMap(SECURITY_HEADERS);
    const csp = m.get("content-security-policy");
    expect(csp).toBeDefined();
    expect(m.has("content-security-policy-report-only")).toBe(false);
    expect(csp).toContain("default-src 'self'");
    // Extract just the script-src directive for a precise assertion.
    const directives = (csp ?? "").split(";").map((d) => d.trim());
    const scriptSrc = directives.find((d) => d.startsWith("script-src "));
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).toContain("'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='");
    expect(scriptSrc).toContain("'sha256-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB='");
    // 'self' and 'wasm-unsafe-eval' must still be allowed for the
    // first-party bundles and WebLLM's WASM step.
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).toContain("'wasm-unsafe-eval'");
  });
});
