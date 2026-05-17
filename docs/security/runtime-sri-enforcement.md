# Runtime SRI enforcement — operator runbook

Subresource Integrity (SRI) on Ghola's web tier is enforced in four
layered ways. Each layer has a distinct threat model and a distinct
failure mode. The layers are arranged so the system **fails closed**
on tampering and **fails open** on missing build artifacts — i.e. a
broken deploy degrades to "no enforcement" rather than to "site
down."

This document is for the operator standing in front of a paged alert
or a regression. If the live site is broken and you suspect an SRI
layer, work through this top to bottom.

## The four layers

| Layer | Source of truth | Enforced by | Fails closed on |
|---|---|---|---|
| 1. Build-time SRI manifest | `apps/web/scripts/build-sri-manifest.mjs` | reviewers (out-of-band hash compare) | tampered static asset, post-build |
| 2. Script-tag `integrity=` attrs | `apps/web/scripts/inject-script-integrity.mjs` | browser (native SRI check) | first-load CDN tamper |
| 3. SW runtime hash verification | `apps/web/public/sw.js` | service worker (every same-origin GET) | live tamper / cache poisoning |
| 4. Enforcing CSP w/ inline-script allowlist | `apps/web/scripts/build-inline-csp.mjs` + `next.config.ts` | browser (CSP `script-src` hashes) | injected inline `<script>` |

All four are wired into `npm run build`:

```
next build
  && node scripts/build-sri-manifest.mjs       # layer 1
  && node scripts/inject-script-integrity.mjs  # layer 2
  && node scripts/build-inline-csp.mjs         # layer 4
```

Layer 3 ships with `public/sw.js`; it loads layer 1's manifest at SW
install/activate time and uses it to verify every fetch.

## Layer 1 — `/.well-known/sri-manifest.json`

Authoritative hashes for every emitted JS/CSS/MJS under `.next/static`.
Two builds at the same git SHA produce a byte-identical manifest (the
deterministic-build invariant). The whole manifest body is hashed and
the resulting `manifest_sha256` is the single-string commitment a
reviewer compares against a known-good value.

Verify manually:

```bash
curl -s https://ghola.xyz/.well-known/sri-manifest.json | jq -r .manifest_sha256
```

Re-derive locally:

```bash
cd apps/web && ./scripts/verify-reproducible-build.sh
```

The script builds twice and asserts equality. If it fails, layer 1 is
broken: something in the build pipeline is non-deterministic and the
manifest commitment is meaningless until you fix it. Most common
cause: a random build id leaking into a chunk path (see
`generateBuildId` in `next.config.ts`).

**Recovery.** Layer 1 is informational; if it's broken, the OTHER
layers still enforce on the bytes they actually see. But the
reviewer's audit story breaks until reproducibility is restored.

## Layer 2 — `<script integrity="sha384-…">` injection

After `next build`, `inject-script-integrity.mjs` walks `.next/`
HTML and splices `integrity="..."` + `crossorigin="anonymous"` into
every same-origin `<script src="/_next/...">` and matching
`<link rel="modulepreload"|"preload"|"stylesheet" href="/_next/...">`.
Hash sources come from layer 1's manifest.

This closes the first-load gap: before the service worker has
installed, the browser will refuse to execute a tampered chunk
because the `integrity` mismatch fails natively.

The script is idempotent: tags that already carry `integrity=` are
left alone. Tags referencing paths NOT in the manifest are left
alone (third-party `next/script` blocks etc.).

**Recovery.** If the build pipeline crashes here, `next build` already
succeeded — the HTML in `.next/server/app/` just doesn't have
integrity attrs spliced in yet. Re-run the script directly:

```bash
cd apps/web && node scripts/inject-script-integrity.mjs
```

It will re-walk and inject; nothing else has to be rebuilt.

## Layer 3 — service worker SRI enforcement

`public/sw.js` intercepts every same-origin GET in the browser. On
install it loads `/.well-known/sri-manifest.json` into memory. For
each fetch:

1. If the request path isn't in the manifest, fall through to
   network-first + cache-on-success (the historical offline-fallback
   behavior).
2. If it IS in the manifest, fetch from network, SHA-256 the body,
   compare against the manifest entry.
3. Match → return the response and cache it for offline.
4. Mismatch → return a synthetic **HTTP 502 SRI Mismatch** response
   AND broadcast `{ type: "sri-mismatch", path, expected, actual }`
   to every connected client. The status page picks this up and
   flips the "Runtime SRI enforcement" probe red.

The SW also accepts a `{ type: "sri-status" }` message and replies
with `{ manifestLoaded, hashCount, loadedAt, lastMismatch }` over a
MessagePort. The status page uses this to display the SW's pinned
count.

**Recovery — "the site won't load."** If the SW is 502-ing legitimate
traffic, the manifest is wrong (mismatched bundle deployed) or the
SW itself shipped with a bug. Two-stage rollback:

1. **Tell users to unregister the SW.** Browser DevTools →
   Application → Service Workers → Unregister. Or visit
   `chrome://serviceworker-internals` (Chrome) → Unregister.
2. **Server-side**: replace `public/sw.js` with a no-op (e.g. the
   single line `self.addEventListener("install",()=>self.skipWaiting())`)
   and redeploy. The browser auto-fetches an updated `sw.js` on every
   page load; within minutes, all clients will pick up the no-op and
   stop intercepting.

The SW's fall-open behaviour: if the manifest fetch fails entirely
(404, network error), the SW logs and falls through to the original
cache-on-success path. This is intentional — a missing manifest
should not break the site; layers 2 and 4 still apply.

## Layer 4 — enforcing CSP with inline-script hash allowlist

SRI doesn't apply to inline `<script>` blocks. Next.js emits a few of
those (the `__NEXT_DATA__` JSON payload, the bootstrap script, the
hydration-context script). Without action, our CSP would have to
include `'unsafe-inline'` in `script-src` — which means any inline
script an attacker can inject would execute.

`scripts/build-inline-csp.mjs` solves this:

1. Walks the prerendered HTML in `.next/server/app/`.
2. For every inline `<script>...</script>` block (no `src=`),
   computes `sha256(body_bytes)` and base64-encodes it.
3. Writes the deduplicated, sorted list to
   `public/.well-known/csp-inline-hashes.json`.

`next.config.ts` reads that file at module init. **When the file
exists and is non-empty**, the CSP is emitted as enforcing
`Content-Security-Policy` with every hash spliced into `script-src`
and `'unsafe-inline'` dropped. **When it's missing**, CSP falls back
to `Content-Security-Policy-Report-Only` with `'unsafe-inline'` so
dev workflows aren't broken — this is the dev-fallback documented in
`next.config.ts`.

The regression test `apps/web/src/lib/security-headers.test.ts`
asserts both branches: with a fixture allowlist, `script-src` must
not contain `'unsafe-inline'`; without it, the policy must remain
report-only. This prevents silent regression back to the unsafe
state.

**Recovery — "every page is broken with a CSP error."** Most likely
cause: a build added a new inline script (e.g. a new analytics
snippet) and the hash wasn't picked up. Fix: re-run `npm run build`
end-to-end, or hand-add the new hash to
`csp-inline-hashes.json` and redeploy. If you need to ship NOW and
the rebuild is blocked, delete `public/.well-known/csp-inline-hashes.json`
and redeploy — `next.config.ts` will fall back to report-only and
the site will load. Then fix the underlying issue.

## What to do if a deploy breaks

Triage order, fastest mitigation first:

1. **Status page red on "CSP inline-script allowlist"?** The
   allowlist file is missing or empty. Site is in report-only
   fallback; no user-visible breakage. Investigate the build job and
   redeploy.

2. **Status page red on "Runtime SRI enforcement"?** Either the SW
   reported a mismatch (genuinely tampered bundle — investigate the
   CDN immediately) or the SW couldn't load the manifest (404 the
   well-known path → look at deploy artifact). Mitigation: ship the
   no-op SW per layer-3 instructions.

3. **Pages 502-ing in user browsers?** Layer 3 is rejecting them.
   This is correct behavior if there's tampering; if it's a false
   positive (e.g. a CDN minified one extra whitespace and changed
   the hash) treat as a layer-3 emergency: ship the no-op SW.

4. **`verify-reproducible-build.sh` failing in CI?** Layer 1 invariant
   broke. Sites still works for users. Fix non-determinism before
   merging. Common causes: random build id, embedded build
   timestamp, non-stable chunk ordering.

## Probes and telemetry

`/security/status` page runs nine probes; the SRI-relevant ones are:

- **Web bundle SRI manifest** — reads layer 1.
- **Runtime SRI enforcement (service worker)** — postMessages
  layer 3 and reports its pinned count.
- **CSP inline-script allowlist** — reads layer 4's artifact and
  reports enforcing vs. report-only.
- **Security response headers** — reads the actual response and
  reports whether CSP is in enforcing or report-only mode based on
  which header name the server sent.

If you suspect a layer is degraded, hit `/security/status` first.
Each probe is computed from a live observable — it cannot lie about
the state on the actual deployed origin.

## Files

- `apps/web/public/sw.js` — layer 3 service worker
- `apps/web/scripts/build-sri-manifest.mjs` — layer 1 manifest builder
- `apps/web/scripts/inject-script-integrity.mjs` — layer 2 HTML rewriter
- `apps/web/scripts/build-inline-csp.mjs` — layer 4 inline-hash builder
- `apps/web/next.config.ts` — `buildCspHeader()`, the report-only/enforcing toggle
- `apps/web/src/lib/security-headers.test.ts` — header-shape regression test
- `apps/web/src/app/security/status/page.tsx` — live probes
- `apps/web/scripts/verify-reproducible-build.sh` — determinism check
