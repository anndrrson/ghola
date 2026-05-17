import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function thumperBase(): string {
  return (
    process.env.NEXT_PUBLIC_THUMPER_API_URL ||
    process.env.THUMPER_API_URL ||
    "https://thumper-cloud.onrender.com"
  );
}

export async function GET() {
  try {
    const res = await fetch(new URL("/health/payments", thumperBase()), {
      method: "GET",
      cache: "no-store",
    });
    const body = await res.json().catch(() => null);
    return NextResponse.json(body ?? { error: "invalid payment health" }, {
      status: res.ok ? 200 : res.status,
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "payment health unavailable" },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  }
}
