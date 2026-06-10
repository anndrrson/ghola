import {
  json,
  privateModeHealthBody,
} from "../../_lib";

export const dynamic = "force-dynamic";

export async function GET() {
  const health = await privateModeHealthBody();
  return json({
    version: 1,
    status: health.sealed_runtime.status,
    sealed_runtime: health.sealed_runtime,
    v6_production_gates: health.v6_production_gates,
    checked_at: health.checked_at,
  });
}
