/**
 * One-shot client-side migration from `localStorage`-stored JWTs to the new
 * HttpOnly `ghola_session` cookie set by the backend.
 *
 * Pre-migration the SAID JWT lived in `localStorage["ghola_token"]` and the
 * Orni JWT lived in `localStorage["ghola_orni_token"]`. After the migration
 * both backends emit the JWT as a `Set-Cookie: ghola_session=…; HttpOnly`
 * header — JS cannot read it, which closes the "any XSS → permanent session
 * hijack" hole the audit flagged.
 *
 * Backend support: each cloud (thumper-cloud, said-cloud, orni-models-api)
 * exposes a `POST /…/auth/refresh-cookie` route. It accepts the JWT in
 * `Authorization: Bearer …` OR in the JSON body as `{ token }`, validates
 * the signature, and re-emits the same JWT (still valid for its original
 * lifetime) as a proper `Set-Cookie`. We then purge the localStorage entry.
 *
 * If the migration request fails (network, expired JWT, …) we still purge
 * the legacy localStorage entry — at worst the user has to sign in again.
 *
 * Idempotent: safe to call on every page load. After both keys are gone the
 * function is a no-op (it returns at the first localStorage check).
 *
 * DEPRECATION TIMELINE: leave this helper deployed for ~90 days after the
 * cookie cutover. Then delete the helper, the call sites, and the
 * `/auth/refresh-cookie` endpoints on the three backends. All sessions in
 * the wild older than 90 days will already have re-signed by then; the
 * remainder will re-sign on next visit.
 */

const SAID_LEGACY_KEY = "ghola_token";
const ORNI_LEGACY_KEY = "ghola_orni_token";

const SAID_API_BASE =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080/v1";
const ORNI_API_BASE =
  process.env.NEXT_PUBLIC_ORNI_API_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  "http://localhost:8081/api";

async function migrateOne(
  key: string,
  url: string,
): Promise<void> {
  if (typeof window === "undefined") return;
  const token = window.localStorage.getItem(key);
  if (!token) return;

  try {
    await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        // Belt and suspenders: send via header so middleware can pick it up
        // regardless of how the body is parsed downstream.
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ token }),
    });
  } catch {
    // Swallow — at worst the user has to sign in again. We still purge
    // the legacy key below so a stale JWT doesn't keep sitting in
    // localStorage.
  }

  try {
    window.localStorage.removeItem(key);
  } catch {
    // localStorage disabled (private browsing). No-op.
  }
}

export async function runTokenMigration(): Promise<void> {
  if (typeof window === "undefined") return;
  // Read first to avoid even calling fetch when nothing needs migrating.
  const hasSaid = !!window.localStorage.getItem(SAID_LEGACY_KEY);
  const hasOrni = !!window.localStorage.getItem(ORNI_LEGACY_KEY);
  if (!hasSaid && !hasOrni) return;

  await Promise.all([
    hasSaid
      ? migrateOne(SAID_LEGACY_KEY, `${SAID_API_BASE}/auth/refresh-cookie`)
      : Promise.resolve(),
    hasOrni
      ? migrateOne(ORNI_LEGACY_KEY, `${ORNI_API_BASE}/auth/refresh-cookie`)
      : Promise.resolve(),
  ]);
}
