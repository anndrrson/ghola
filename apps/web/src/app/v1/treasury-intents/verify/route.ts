import {
  verifyTreasuryExecutionReceiptSignature,
  type TreasuryExecutionReceiptV1,
} from "@/lib/treasury-execution";
import { json, treasuryExecutionEnv } from "../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const receipt =
    body && typeof body === "object" && "receipt" in body
      ? (body as { receipt?: unknown }).receipt
      : body;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return json({ error: "receipt is required" }, 400);
  }
  const env = treasuryExecutionEnv();
  const ok = verifyTreasuryExecutionReceiptSignature(
    receipt as TreasuryExecutionReceiptV1,
    env.signingSecret,
  );
  return json(
    {
      version: 1,
      ok,
      ...(ok ? {} : { error: "treasury receipt signature is invalid" }),
    },
    ok ? 200 : 400,
  );
}
