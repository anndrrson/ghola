export const GOOGLE_AUTH_CALLBACK_PATH = "/api/auth/session/google/callback";
export const GOOGLE_REDIRECT_COOKIE_NAME = "ghola_google_redirect";

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
