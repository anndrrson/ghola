import { NextResponse } from "next/server";
import { privateAccountLaunchStatus } from "@/lib/private-account-launch-status";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const startedAt = Date.now();
  const requestId = req.headers.get("x-vercel-id") || req.headers.get("x-ghola-correlation-id") || "missing";
  try {
    const status = await privateAccountLaunchStatus();
    console.info(JSON.stringify({
      level: "info",
      message: "private_account_launch_status_completed",
      request_id: requestId,
      route: "/v1/private-account/launch/status",
      ready_to_accept_users: status.ready_to_accept_users,
      blocking_check_count: status.checks.filter((check) => check.status !== "ready").length,
      duration_ms: Date.now() - startedAt,
    }));
    return NextResponse.json(status, {
      headers: {
        "Cache-Control": "no-store",
        "x-ghola-request-id": requestId,
      },
    });
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      message: "private_account_launch_status_failed",
      request_id: requestId,
      route: "/v1/private-account/launch/status",
      error_name: error instanceof Error ? error.name : "unknown",
      duration_ms: Date.now() - startedAt,
    }));
    return NextResponse.json({
      ready_to_accept_users: false,
      error: "launch_status_unavailable",
    }, {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "x-ghola-request-id": requestId,
      },
    });
  }
}
