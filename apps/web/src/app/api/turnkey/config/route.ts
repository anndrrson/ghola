import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
} as const;

export async function GET() {
  const organizationId =
    process.env.NEXT_PUBLIC_TURNKEY_PERPS_ORGANIZATION_ID?.trim() || "";
  const authProxyConfigId =
    process.env.NEXT_PUBLIC_TURNKEY_PERPS_AUTH_PROXY_CONFIG_ID?.trim() || "";

  if (!organizationId || !authProxyConfigId) {
    return NextResponse.json(
      { error: "Turnkey wallet authentication is unavailable" },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }

  return NextResponse.json(
    {
      organizationId,
      authProxyConfigId,
      apiUrl: "https://api.turnkey.com",
      authProxyUrl: "https://authproxy.turnkey.com",
      rpId: "ghola.xyz",
      appleServiceId: null,
      xClientId: null,
    },
    { headers: NO_STORE_HEADERS },
  );
}
