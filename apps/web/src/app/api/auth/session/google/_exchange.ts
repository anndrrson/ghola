import {
  fetchSessionUser,
  fetchWithTimeout,
  invalidSessionStatus,
  THUMPER_API_BASE,
  type SessionUser,
} from "../_lib";

export type GoogleSessionExchange =
  | { ok: true; token: string; user: SessionUser }
  | { ok: false; status: number; error: string };

export async function exchangeGoogleCredential(
  idToken: string,
): Promise<GoogleSessionExchange> {
  if (!idToken) {
    return { ok: false, status: 400, error: "Missing Google credential" };
  }

  try {
    const upstream = await fetchWithTimeout(`${THUMPER_API_BASE}/api/auth/google`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id_token: idToken }),
    });
    const raw = await upstream.text();
    if (!upstream.ok) {
      return {
        ok: false,
        status: upstream.status,
        error: safeError(raw, upstream.status),
      };
    }

    const parsed = JSON.parse(raw) as { token?: string };
    if (!parsed.token) {
      return { ok: false, status: 502, error: "Missing token from auth provider" };
    }
    const session = await fetchSessionUser(parsed.token);
    if (!session.ok) {
      return {
        ok: false,
        status: invalidSessionStatus(session.status),
        error: "Invalid session from auth provider",
      };
    }
    return { ok: true, token: parsed.token, user: session.user };
  } catch {
    return { ok: false, status: 503, error: "Auth provider unavailable" };
  }
}

function safeError(raw: string, status: number): string {
  try {
    const parsed = JSON.parse(raw) as { error?: string };
    if (parsed.error) return parsed.error;
  } catch {}
  return `Auth request failed (${status})`;
}
