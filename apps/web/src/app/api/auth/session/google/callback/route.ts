import { NextRequest, NextResponse } from "next/server";
import {
  GOOGLE_REDIRECT_COOKIE_NAME,
  safeInternalRedirect,
} from "@/lib/google-auth";
import { applyNoStore, withSessionCookie } from "../../_lib";
import { exchangeGoogleCredential } from "../_exchange";

const GOOGLE_CSRF_COOKIE = "g_csrf_token";

export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return failureRedirect(req);
  }

  const csrfBody = form.get(GOOGLE_CSRF_COOKIE);
  const csrfCookie = req.cookies.get(GOOGLE_CSRF_COOKIE)?.value;
  if (
    typeof csrfBody !== "string" ||
    !csrfBody ||
    !csrfCookie ||
    csrfBody !== csrfCookie
  ) {
    return failureRedirect(req);
  }

  const credential = form.get("credential");
  if (typeof credential !== "string" || !credential) {
    return failureRedirect(req);
  }

  const exchange = await exchangeGoogleCredential(credential);
  if (!exchange.ok) {
    return failureRedirect(req);
  }

  const redirectTo = safeInternalRedirect(
    req.cookies.get(GOOGLE_REDIRECT_COOKIE_NAME)?.value,
  );
  const res = NextResponse.redirect(new URL(redirectTo, req.nextUrl.origin), 303);
  withSessionCookie(res, exchange.token);
  clearRedirectCookie(res);
  return applyNoStore(res);
}

function failureRedirect(req: NextRequest) {
  const url = new URL("/signin", req.nextUrl.origin);
  url.searchParams.set("google_error", "1");
  const res = NextResponse.redirect(url, 303);
  clearRedirectCookie(res);
  return applyNoStore(res);
}

function clearRedirectCookie(res: NextResponse) {
  res.cookies.set(GOOGLE_REDIRECT_COOKIE_NAME, "", {
    httpOnly: false,
    secure: true,
    sameSite: "none",
    path: "/api/auth/session/google/callback",
    maxAge: 0,
  });
}
