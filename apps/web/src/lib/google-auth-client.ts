import {
  GOOGLE_AUTH_CALLBACK_PATH,
  GOOGLE_REDIRECT_COOKIE_NAME,
  isGoogleAuthOriginAllowed,
  safeInternalRedirect,
} from "./google-auth";

const configuredGoogleAuthOrigins =
  process.env.NEXT_PUBLIC_GOOGLE_AUTH_ALLOWED_ORIGINS;

type GoogleIdentityApi = {
  initialize: (config: {
    client_id: string;
    ux_mode: "redirect";
    login_uri: string;
  }) => void;
  renderButton: (
    element: HTMLElement,
    config: {
      theme?: string;
      size?: string;
      width?: number;
      text?: string;
      shape?: string;
    },
  ) => void;
};

export function googleIdentityApi(): GoogleIdentityApi | undefined {
  return (window as typeof window & {
    google?: { accounts?: { id?: GoogleIdentityApi } };
  }).google?.accounts?.id;
}

export function googleAuthAvailableForCurrentOrigin(
  clientId: string | undefined,
): boolean {
  return Boolean(
    clientId &&
    typeof window !== "undefined" &&
    isGoogleAuthOriginAllowed(window.location.origin, configuredGoogleAuthOrigins),
  );
}

export function initializeGoogleRedirect(
  google: GoogleIdentityApi,
  clientId: string,
  redirectTo: string,
): void {
  const target = safeInternalRedirect(redirectTo);
  document.cookie = [
    `${GOOGLE_REDIRECT_COOKIE_NAME}=${encodeURIComponent(target)}`,
    `Path=${GOOGLE_AUTH_CALLBACK_PATH}`,
    "Max-Age=600",
    "SameSite=None",
    "Secure",
  ].join("; ");
  google.initialize({
    client_id: clientId,
    ux_mode: "redirect",
    login_uri: new URL(GOOGLE_AUTH_CALLBACK_PATH, window.location.origin).toString(),
  });
}
