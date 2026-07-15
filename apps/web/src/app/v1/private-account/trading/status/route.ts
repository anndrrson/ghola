import { getConsumerCircuitState } from "@/lib/consumer-production-store";
import { getPrivateAgentRuntimeStatus } from "@/lib/private-agent-runtime-server";
import { json } from "../../_lib";

export const dynamic = "force-dynamic";

export async function GET() {
  const [circuit, runtime] = await Promise.all([
    getConsumerCircuitState(),
    getPrivateAgentRuntimeStatus().catch(() => null),
  ]);
  const phala = runtime?.providers.find((provider) => provider.id === "phala");
  const cvm = phala?.evidence && typeof phala.evidence === "object"
    ? String((phala.evidence as { cvm_status?: unknown }).cvm_status || "unknown")
    : "unknown";
  const worker = runtime?.remote_execution_ready
    ? "ready"
    : phala?.configured && cvm === "stopped" ? "sleeping_wakeable" : "unavailable";
  return json({
    version: 1,
    consumer_registration: "open",
    live_trading: circuit.status === "open" ? "available_when_funded" : "halted",
    circuit: { status: circuit.status, reason_codes: circuit.reasons },
    worker,
    venues: {
      hyperliquid: "byo_trade_only_credentials",
      phoenix: "prepaid_balance_required",
    },
    checked_at: new Date().toISOString(),
  });
}
