import { NextRequest, NextResponse } from "next/server";
import {
  discoverPhalaPrivateAgentExecutionUrl,
  ensurePhalaPrivateAgentProvisioned,
} from "@/lib/private-agent-phala";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

function bearer(req: NextRequest): string | null {
  const value = req.headers.get("authorization");
  if (!value?.startsWith("Bearer ")) return null;
  return value.slice("Bearer ".length).trim();
}

export async function POST(req: NextRequest) {
  const token = process.env.GHOLA_PRIVATE_AGENT_PROVISION_TOKEN?.trim();
  if (!token || bearer(req) !== token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const provisioning = await ensurePhalaPrivateAgentProvisioned({
    waitForReadyMs: 180_000,
  });
  const executionUrl = await discoverPhalaPrivateAgentExecutionUrl();

  return NextResponse.json(
    {
      version: 1,
      provisioning: {
        attempted: provisioning.attempted,
        ready: provisioning.ready,
        status: provisioning.status,
        reason: provisioning.reason ?? null,
        cvm_name: provisioning.cvm_name ?? null,
        cvm_id: provisioning.cvm_id ?? null,
      },
      execution_url: executionUrl,
    },
    {
      headers: {
        "cache-control": "no-store",
      },
    },
  );
}
