import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { THUMPER_API_BASE } from "../../session/_lib";

// Temporary in-memory store for OAuth token exchange codes
const pendingCodes = new Map<string, { token: string; expires: number }>();

function cleanupExpiredCodes() {
  const now = Date.now();
  for (const [code, entry] of pendingCodes) {
    if (entry.expires <= now) {
      pendingCodes.delete(code);
    }
  }
}

export { pendingCodes };

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  if (error) {
    return NextResponse.redirect(
      new URL(`/signup?error=${encodeURIComponent(error)}`, req.nextUrl.origin)
    );
  }

  if (!code || !state) {
    return NextResponse.redirect(
      new URL("/signup?error=missing_params", req.nextUrl.origin)
    );
  }

  // Verify state
  const storedState = req.cookies.get("twitter_oauth_state")?.value;
  if (!storedState || storedState !== state) {
    return NextResponse.redirect(
      new URL("/signup?error=invalid_state", req.nextUrl.origin)
    );
  }

  const codeVerifier = req.cookies.get("twitter_code_verifier")?.value;
  if (!codeVerifier) {
    return NextResponse.redirect(
      new URL("/signup?error=missing_verifier", req.nextUrl.origin)
    );
  }

  const clientId = process.env.TWITTER_CLIENT_ID!;
  const clientSecret = process.env.TWITTER_CLIENT_SECRET!;
  const redirectUri = `${req.nextUrl.origin}/api/auth/twitter/callback`;

  try {
    // Exchange code for access token
    const tokenRes = await fetch("https://api.x.com/2/oauth2/token", {
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
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      logger.error("Twitter token exchange failed:", err);
      return NextResponse.redirect(
        new URL("/signup?error=token_exchange_failed", req.nextUrl.origin)
      );
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    // Fetch user profile from Twitter
    const userRes = await fetch(
      "https://api.x.com/2/users/me?user.fields=id,name,username,profile_image_url",
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );

    if (!userRes.ok) {
      logger.error("Twitter user fetch failed:", await userRes.text());
      return NextResponse.redirect(
        new URL("/signup?error=user_fetch_failed", req.nextUrl.origin)
      );
    }

    const userData = await userRes.json();
    const twitterUser = userData.data;

    // Call thumper-cloud backend to create/authenticate user
    const authRes = await fetch(`${THUMPER_API_BASE}/api/auth/twitter`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        twitter_id: twitterUser.id,
        name: twitterUser.name,
        username: twitterUser.username,
        email: null, // Twitter doesn't reliably provide email
      }),
    });

    if (!authRes.ok) {
      logger.error("Thumper twitter auth failed:", await authRes.text());
      return NextResponse.redirect(
        new URL("/signup?error=auth_failed", req.nextUrl.origin)
      );
    }

    const authData = await authRes.json();

    // Store token behind a short-lived exchange code (avoid token in URL)
    cleanupExpiredCodes();
    const exchangeCode = crypto.randomUUID();
    pendingCodes.set(exchangeCode, {
      token: authData.token,
      expires: Date.now() + 30_000, // 30-second TTL
    });

    const response = NextResponse.redirect(
      new URL(`/chat?code=${exchangeCode}`, req.nextUrl.origin)
    );

    // Clear OAuth cookies
    response.cookies.delete("twitter_code_verifier");
    response.cookies.delete("twitter_oauth_state");

    return response;
  } catch (err) {
    logger.error("Twitter OAuth error:", err);
    return NextResponse.redirect(
      new URL("/signup?error=server_error", req.nextUrl.origin)
    );
  }
}
