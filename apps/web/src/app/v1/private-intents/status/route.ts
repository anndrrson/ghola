import { json, privateExecutionStatus } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET() {
  return json(privateExecutionStatus());
}
