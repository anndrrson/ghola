export const GOOGLE_AUTH_CALLBACK_PATH = "/api/auth/session/google/callback";
export const GOOGLE_REDIRECT_COOKIE_NAME = "ghola_google_redirect";
export const DEFAULT_GOOGLE_AUTH_ALLOWED_ORIGINS = "https://ghola.xyz";

type AuthSearchParams = {
  get: (name: string) => string | null;
};

export function isGoogleAuthOriginAllowed(
  origin: string,
  configuredOrigins: string | undefined,
): boolean {
  const currentOrigin = normalizedWebOrigin(origin);
  if (!currentOrigin) return false;

  const allowlist = configuredOrigins === undefined
    ? DEFAULT_GOOGLE_AUTH_ALLOWED_ORIGINS
    : configuredOrigins;
  return allowlist
    .split(",")
    .map(normalizedWebOrigin)
    .some((allowedOrigin) => allowedOrigin === currentOrigin);
}

function normalizedWebOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    if (url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function safeInternalRedirect(
  value: string | null | undefined,
  fallback = "/trade",
): string {
  if (!value) return fallback;
  // Callers pass both raw internal paths and once-encoded query/cookie values.
  // Keep a raw path byte-for-byte so nested return targets remain encoded.
  if (isInternalPath(value)) return value;
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return fallback;
  }
  return isInternalPath(decoded) ? decoded : fallback;
}

function isInternalPath(value: string): boolean {
  const trustedOrigin = "https://ghola.local";
  let candidate = value;

  // URL parsers treat backslashes as path separators. Validate decoded forms too,
  // without returning them, so nested return_to encoding remains byte-for-byte.
  for (let depth = 0; depth < 3; depth += 1) {
    if (
      !candidate.startsWith("/")
      || candidate.startsWith("//")
      || candidate.includes("\\")
    ) {
      return false;
    }
    try {
      if (new URL(candidate, trustedOrigin).origin !== trustedOrigin) return false;
    } catch {
      return false;
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      return false;
    }
    if (decoded === candidate) return true;
    candidate = decoded;
  }

  return false;
}

export function resolveAuthRedirect(
  searchParams: AuthSearchParams,
  fallback = "/trade",
): string {
  return safeInternalRedirect(
    searchParams.get("redirect") ?? searchParams.get("next"),
    fallback,
  );
}
