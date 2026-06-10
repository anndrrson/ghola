import {
  simulateTreasuryIntent,
  validateTreasurySimulationRequest,
} from "@/lib/treasury-execution";
import { recordTreasurySimulation } from "@/lib/treasury-execution-store";
import { json } from "../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const validation = validateTreasurySimulationRequest(body);
  if (!validation.ok || !validation.policy || !validation.intent) {
    return json({ error: validation.error ?? "invalid treasury intent" }, 400);
  }

  const simulation = simulateTreasuryIntent({
    policy: validation.policy,
    intent: validation.intent,
  });
  await recordTreasurySimulation(simulation);
  return json(simulation);
}
