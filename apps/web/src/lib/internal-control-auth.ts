import { createHash, timingSafeEqual } from "node:crypto";

export function verifyInternalBearer(request: Request, envName: string): boolean {
  const expected = process.env[envName]?.trim() || "";
  const actual = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() || "";
  if (expected.length < 32 || !actual) return false;
  const left = createHash("sha256").update(actual).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}
