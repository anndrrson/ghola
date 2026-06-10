import { type NextRequest } from "next/server";
import { proxySessionAuth } from "../../_auth-proxy";
import { sessionError } from "../../_lib";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return sessionError("Invalid sign-in request.", 400);
  }

  const record = body as Record<string, unknown>;
  const email = typeof record.email === "string" ? record.email.trim() : "";
  const password = typeof record.password === "string" ? record.password : "";
  if (!email || !password) {
    return sessionError("Email and password are required.", 400);
  }

  return proxySessionAuth(req, {
    upstreamPath: "/api/auth/email/signin",
    body: { email, password },
  });
}
