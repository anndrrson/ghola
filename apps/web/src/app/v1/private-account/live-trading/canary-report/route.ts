import { timingSafeEqual } from "node:crypto";
import { json } from "../../_lib";

export const dynamic = "force-dynamic";

/** Green evidence is recorded only from a validated funded worker round trip. */
export async function POST(req: Request) {
  const expected = (process.env.GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN || "").trim();
  if (!expected) return json({ error: "private_account_internal_token_missing" }, 503);
  const authorization = req.headers.get("authorization") ?? "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
  const supplied = bearer || req.headers.get("x-ghola-internal-token")?.trim() || "";
  if (!safeEqual(supplied, expected)) return json({ error: "unauthorized" }, 401);
  return json({ error: "legacy_canary_report_retired" }, 410);
}

function safeEqual(leftValue: string, rightValue: string) {
  if (!leftValue || !rightValue) return false;
  const left = Buffer.from(leftValue);
  const right = Buffer.from(rightValue);
  return left.length === right.length && timingSafeEqual(left, right);
}
