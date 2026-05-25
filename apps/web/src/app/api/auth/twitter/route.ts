import { NextRequest, NextResponse } from "next/server";
import { randomBytes, createHash } from "crypto";
import { applyNoStore, NO_STORE_HEADERS } from "../session/_lib";

// Twitter OAuth 2.0 Authorization Code Flow with PKCE
export async function GET(req: NextRequest) {
  const clientId = process.env.TWITTER_CLIENT_ID;
  const clientSecret = process.env.TWITTER_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return NextResponse.json(
      { error: "Twitter not configured" },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }

  const redirectUri = `${req.nextUrl.origin}/api/auth/twitter/callback`;

  // Generate PKCE code verifier + challenge
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");

  // Generate state for CSRF protection
  const state = randomBytes(16).toString("hex");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "users.read tweet.read offline.access",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  const authUrl = `https://twitter.com/i/oauth2/authorize?${params.toString()}`;

  // Store verifier and state in cookies (httpOnly, secure)
  const response = applyNoStore(NextResponse.redirect(authUrl));
  response.cookies.set("twitter_code_verifier", codeVerifier, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600, // 10 minutes
    path: "/",
  });
  response.cookies.set("twitter_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });

  return response;
}
