import { createHash, timingSafeEqual } from "node:crypto";

export async function verifyConsumerStepUp(request: Request): Promise<boolean> {
  if (process.env.NODE_ENV === "test" && process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS === "true") return true;
  const proof = request.headers.get("x-ghola-step-up-token")?.trim() || "";
  if (!proof) return false;
  const local = process.env.GHOLA_CONSUMER_STEP_UP_TEST_TOKEN?.trim() || "";
  if (local && process.env.NODE_ENV !== "production") return safeEqual(proof, local);
  const url = process.env.GHOLA_CONSUMER_STEP_UP_VERIFY_URL?.trim();
  if (!url) return false;
  const session = request.headers.get("authorization") || request.headers.get("cookie") || "";
  if (!session) return false;
  const response = await fetch(url, {
    method: "POST",
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
    headers: {
      "content-type": "application/json",
      authorization: request.headers.get("authorization") || "",
      cookie: request.headers.get("cookie") || "",
    },
    body: JSON.stringify({ proof, purpose: "consumer_balance_withdrawal" }),
  }).catch(() => null);
  if (!response?.ok) return false;
  const body = await response.json().catch(() => null) as { verified?: boolean; expires_at?: string } | null;
  return body?.verified === true && Boolean(body.expires_at) && new Date(body.expires_at!).getTime() > Date.now();
}

function safeEqual(leftValue: string, rightValue: string) {
  const left = createHash("sha256").update(leftValue).digest();
  const right = createHash("sha256").update(rightValue).digest();
  return timingSafeEqual(left, right);
}
