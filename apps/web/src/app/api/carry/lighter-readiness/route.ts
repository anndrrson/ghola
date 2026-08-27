import { readLighterActivationReadiness } from "@/lib/lighter-activation-readiness.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const ownerAddress = new URL(request.url).searchParams.get("owner_address") || "";
  try {
    const readiness = await readLighterActivationReadiness({ ownerAddress });
    return Response.json(readiness, {
      headers: { "cache-control": "no-store, max-age=0" },
    });
  } catch (caught) {
    const failure = caught as { code?: unknown; status?: unknown };
    const error = typeof failure.code === "string" ? failure.code : "lighter_readiness_failed";
    const status = typeof failure.status === "number" && failure.status >= 400 && failure.status <= 599
      ? failure.status
      : 500;
    return Response.json({ error }, { status, headers: { "cache-control": "no-store, max-age=0" } });
  }
}
