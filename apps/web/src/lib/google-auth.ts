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
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return fallback;
  }
  if (!decoded.startsWith("/") || decoded.startsWith("//")) return fallback;
  return decoded;
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
