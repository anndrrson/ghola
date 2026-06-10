import { NextResponse } from "next/server";
import {
  fetchRemoteModelsForRoute,
  listStaticModelsForRoute,
  MODEL_ROUTER_HEADERS,
  type GholaModelRouteId,
} from "@/lib/model-router";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const route = routeParam(url.searchParams.get("route"));
  const remote = url.searchParams.get("remote") === "true";
  if (!route) {
    return NextResponse.json({ error: "unknown_model_route" }, {
      status: 404,
      headers: MODEL_ROUTER_HEADERS,
    });
  }
  if (remote && route !== "all") {
    const result = await fetchRemoteModelsForRoute(route, process.env);
    if ("error" in result) {
      return NextResponse.json({ error: result.error }, {
        status: result.status,
        headers: MODEL_ROUTER_HEADERS,
      });
    }
    return NextResponse.json(result, { headers: MODEL_ROUTER_HEADERS });
  }
  return NextResponse.json(listStaticModelsForRoute(route, process.env), {
    headers: MODEL_ROUTER_HEADERS,
  });
}

function routeParam(value: string | null): GholaModelRouteId | "all" | null {
  if (!value || value === "all") return "all";
  if (
    value === "local_webgpu" ||
    value === "local_ghola_home" ||
    value === "local_openai_compatible" ||
    value === "venice" ||
    value === "frontier_openai" ||
    value === "sealed_ghola"
  ) {
    return value;
  }
  return null;
}
