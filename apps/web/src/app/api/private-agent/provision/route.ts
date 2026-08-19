import { NextRequest, NextResponse } from "next/server";
import {
  discoverPhalaPrivateAgentExecutionUrl,
  phalaJitProvisioningEnabled,
  wakePhalaPrivateAgentForUse,
} from "@/lib/private-agent-phala";
import { privateAgentSpendPolicy } from "@/lib/private-agent-spend-policy";
import { verifyInternalBearer } from "@/lib/internal-control-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  if (!verifyInternalBearer(req, "GHOLA_PRIVATE_AGENT_PROVISION_TOKEN")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const policy = privateAgentSpendPolicy("provision");
  if (!policy.allowed) {
    return NextResponse.json(
      { error: "private_agent_runtime_unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  if (!phalaJitProvisioningEnabled()) {
    return NextResponse.json(
      { error: "private_agent_provisioning_mutations_disabled" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  const provisioning = await wakePhalaPrivateAgentForUse({
    reason: "operator_provision",
    waitForReadyMs: 180_000,
    allowReleaseMutation: true,
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
        compose: provisioning.compose ?? null,
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
