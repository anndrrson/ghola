import { type NextRequest } from "next/server";
import { proxySessionAuth } from "../../_auth-proxy";
import { sessionError } from "../../_lib";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return sessionError("Invalid sign-up request.", 400);
  }

  const record = body as Record<string, unknown>;
  const email = typeof record.email === "string" ? record.email.trim() : "";
  const password = typeof record.password === "string" ? record.password : "";
  const displayName = record.display_name ?? record.name;
  const name = typeof displayName === "string" ? displayName.trim() : "";
  if (!email || !password) {
    return sessionError("Email and password are required.", 400);
  }

  return proxySessionAuth(req, {
    upstreamPath: "/api/auth/email/signup",
    body: {
      email,
      password,
      name,
      display_name: name,
    },
  });
}
