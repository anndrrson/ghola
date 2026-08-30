import { NextRequest, NextResponse } from "next/server";

import {
  applyNoStore,
  clearSessionCookie,
  fetchWithTimeout,
  NO_STORE_HEADERS,
  SESSION_COOKIE_NAME,
  sameOrigin,
  THUMPER_API_BASE,
} from "../_lib";

type DeletionPayload = {
  ok: true;
  status: "scheduled" | "completed";
  personal_data_deleted: boolean;
  sessions_revoked: true;
  billing_subscription_cancelled: boolean;
  completion_due_at: string;
  retained_record_categories: ["financial_settlement", "security_audit"];
  completed_at?: string;
  message: string;
  [key: string]: unknown;
};

async function handle(req: NextRequest) {
  const authorization = req.headers.get("authorization");
  let token: string | undefined;
  let bearerAuthenticated = false;

  if (authorization !== null) {
    const match = /^Bearer ([^\s]+)$/.exec(authorization);
    if (!match) {
      return NextResponse.json(
        { error: "Valid session required" },
        { status: 401, headers: NO_STORE_HEADERS },
      );
    }
    token = match[1];
    bearerAuthenticated = true;
  } else {
    token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  }

  if (!token) {
    return NextResponse.json(
      { error: "Valid session required" },
      { status: 401, headers: NO_STORE_HEADERS },
    );
  }

  // Native clients prove possession with an explicit Bearer token. Browser
  // callers use an ambient HttpOnly cookie and therefore require same-origin
  // CSRF protection before this destructive request is forwarded.
  if (!bearerAuthenticated && !sameOrigin(req)) {
    return NextResponse.json(
      { error: "cross-site session request rejected" },
      { status: 403, headers: NO_STORE_HEADERS },
    );
  }

  let upstream: Response;
  try {
    upstream = await fetchWithTimeout(
      `${THUMPER_API_BASE}/api/auth/session/delete`,
      {
        method: "DELETE",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
        cache: "no-store",
      },
    );
  } catch {
    return NextResponse.json(
      { error: "Account deletion service unavailable" },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }

  const payload = await responseJson(upstream);
  if (!upstream.ok) {
    const status = upstream.status === 403 ? 401 : upstream.status;
    const response = NextResponse.json(
      { error: safeUpstreamError(payload, status) },
      { status, headers: NO_STORE_HEADERS },
    );
    if (status === 401) applyNoStore(clearSessionCookie(response));
    return response;
  }

  if (!isDeletionPayload(payload, upstream.status)) {
    return NextResponse.json(
      { error: "Account deletion returned an incomplete result" },
      { status: 502, headers: NO_STORE_HEADERS },
    );
  }

  const response = NextResponse.json(payload, {
    status: payload.status === "scheduled" ? 202 : 200,
    headers: NO_STORE_HEADERS,
  });
  applyNoStore(clearSessionCookie(response));
  return response;
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function isDeletionPayload(value: unknown, upstreamStatus: number): value is DeletionPayload {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const common = (
    record.ok === true &&
    record.sessions_revoked === true &&
    typeof record.billing_subscription_cancelled === "boolean" &&
    validRfc3339(record.completion_due_at) &&
    hasRequiredRetainedCategories(record.retained_record_categories) &&
    typeof record.message === "string" &&
    record.message.length > 0
  );
  if (!common) return false;
  if (record.status === "scheduled") {
    return upstreamStatus === 202 &&
      record.personal_data_deleted === false &&
      !("completed_at" in record);
  }
  return record.status === "completed" &&
    upstreamStatus === 200 &&
    record.personal_data_deleted === true &&
    record.billing_subscription_cancelled === true &&
    validRfc3339(record.completed_at);
}

function hasRequiredRetainedCategories(value: unknown): boolean {
  return Array.isArray(value) &&
    value.length === 2 &&
    value[0] === "financial_settlement" &&
    value[1] === "security_audit";
}

function validRfc3339(value: unknown): value is string {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

function safeUpstreamError(payload: unknown, status: number): string {
  if (status === 401) return "Session expired — sign in again";
  if (status === 429) return "Too many requests — try again later";
  if (status >= 500) return "Account deletion service unavailable";
  if (payload && typeof payload === "object") {
    const error = (payload as Record<string, unknown>).error;
    if (typeof error === "string" && error.length > 0 && error.length <= 200) {
      return error;
    }
  }
  return `Account deletion failed (${status})`;
}

export const DELETE = handle;
export const POST = handle;
