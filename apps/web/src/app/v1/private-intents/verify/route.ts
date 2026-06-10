import {
  verifyPrivateExecutionReceiptSignature,
  type PrivateExecutionReceiptV1,
} from "@/lib/private-execution";
import { json, privateExecutionEnv } from "../_lib";

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
  const env = privateExecutionEnv();
  const ok = verifyPrivateExecutionReceiptSignature(
    receipt as PrivateExecutionReceiptV1,
    env.signingSecret,
  );
  return json({
    version: 1,
    ok,
    ...(ok ? {} : { error: "receipt signature is invalid" }),
  }, ok ? 200 : 400);
}
