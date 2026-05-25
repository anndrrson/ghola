import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import {
  applyNoStore,
  fetchSessionUser,
  fetchWithTimeout,
  THUMPER_API_BASE,
  withSessionCookie,
} from "../../session/_lib";

// Legacy in-memory exchange store. The primary callback path now sets the
// HttpOnly session cookie directly; keep this for older clients/tests only.
const pendingCodes = new Map<string, { token: string; expires: number }>();

export { pendingCodes };

function redirectWithClearedOAuthCookies(url: URL) {
  const response = NextResponse.redirect(url);
  response.cookies.delete("twitter_code_verifier");
  response.cookies.delete("twitter_oauth_state");
  return applyNoStore(response);
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  if (error) {
    return redirectWithClearedOAuthCookies(
      new URL(`/signup?error=${encodeURIComponent(error)}`, req.nextUrl.origin),
    );
  }

  if (!code || !state) {
    return redirectWithClearedOAuthCookies(
      new URL("/signup?error=missing_params", req.nextUrl.origin),
    );
  }

  // Verify state
  const storedState = req.cookies.get("twitter_oauth_state")?.value;
  if (!storedState || storedState !== state) {
    return redirectWithClearedOAuthCookies(
      new URL("/signup?error=invalid_state", req.nextUrl.origin),
    );
  }

  const codeVerifier = req.cookies.get("twitter_code_verifier")?.value;
  if (!codeVerifier) {
    return redirectWithClearedOAuthCookies(
      new URL("/signup?error=missing_verifier", req.nextUrl.origin),
    );
  }

  const clientId = process.env.TWITTER_CLIENT_ID!;
  const clientSecret = process.env.TWITTER_CLIENT_SECRET!;
  if (!clientId || !clientSecret) {
    return redirectWithClearedOAuthCookies(
      new URL("/signup?error=twitter_not_configured", req.nextUrl.origin),
    );
  }
  const redirectUri = `${req.nextUrl.origin}/api/auth/twitter/callback`;

  try {
    // Exchange code for access token
    const tokenRes = await fetchWithTimeout(
      "https://api.x.com/2/oauth2/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        },
        body: new URLSearchParams({
          code,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        }),
      },
    );

    if (!tokenRes.ok) {
      logger.error("Twitter token exchange failed", { status: tokenRes.status });
      return redirectWithClearedOAuthCookies(
        new URL("/signup?error=token_exchange_failed", req.nextUrl.origin),
      );
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    // Fetch user profile from Twitter
    const userRes = await fetchWithTimeout(
      "https://api.x.com/2/users/me?user.fields=id,name,username,profile_image_url",
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );

    if (!userRes.ok) {
      logger.error("Twitter user fetch failed", { status: userRes.status });
      return redirectWithClearedOAuthCookies(
        new URL("/signup?error=user_fetch_failed", req.nextUrl.origin),
      );
    }

    const userData = await userRes.json();
    const twitterUser = userData.data;

    // Call thumper-cloud backend to create/authenticate user.
    //
    // SECURITY: the backend cannot verify the X OAuth flow itself, so it trusts
    // this proxy's resolved `twitter_id` only when accompanied by the shared
    // internal-proxy secret. Without it the backend rejects the request (and
    // is, by design, unreachable for Twitter auth from arbitrary clients).
    const internalProxySecret = process.env.GHOLA_INTERNAL_PROXY_SECRET;
    if (!internalProxySecret) {
      logger.error("GHOLA_INTERNAL_PROXY_SECRET not configured — cannot authenticate Twitter");
      return redirectWithClearedOAuthCookies(
        new URL("/signup?error=server_error", req.nextUrl.origin),
      );
    }
    const authRes = await fetchWithTimeout(`${THUMPER_API_BASE}/api/auth/twitter`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ghola-Internal-Proxy-Secret": internalProxySecret,
      },
      body: JSON.stringify({
        twitter_id: twitterUser.id,
        name: twitterUser.name,
        username: twitterUser.username,
        email: null, // Twitter doesn't reliably provide email
      }),
    });

    if (!authRes.ok) {
      logger.error("Thumper twitter auth failed", { status: authRes.status });
      return redirectWithClearedOAuthCookies(
        new URL("/signup?error=auth_failed", req.nextUrl.origin),
      );
    }

    const authData = await authRes.json();
    if (!authData.token || typeof authData.token !== "string") {
      logger.error("Thumper twitter auth returned no token");
      return redirectWithClearedOAuthCookies(
        new URL("/signup?error=auth_failed", req.nextUrl.origin),
      );
    }
    const session = await fetchSessionUser(authData.token);
    if (!session.ok) {
      logger.error("Thumper twitter session verification failed", { status: session.status });
      return redirectWithClearedOAuthCookies(
        new URL("/signup?error=auth_failed", req.nextUrl.origin),
      );
    }

    const response = redirectWithClearedOAuthCookies(
      new URL("/chat", req.nextUrl.origin),
    );
    return withSessionCookie(response, authData.token);
  } catch (err) {
    logger.error("Twitter OAuth error", {
      message: err instanceof Error ? err.message : "unknown error",
    });
    return redirectWithClearedOAuthCookies(
      new URL("/signup?error=server_error", req.nextUrl.origin),
    );
  }
}
