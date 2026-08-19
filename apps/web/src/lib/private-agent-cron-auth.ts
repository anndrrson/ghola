import { timingSafeEqual } from "node:crypto";

const MIN_CRON_SECRET_LENGTH = 32;

export function privateAgentCronAuthorized(
  request: Pick<Request, "headers">,
  environment: Record<string, string | undefined> = process.env,
): boolean {
  const secret = environment.CRON_SECRET?.trim() ?? "";
  if (secret.length < MIN_CRON_SECRET_LENGTH) return false;

  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  const candidate = authorization.slice("Bearer ".length).trim();
  const expectedBytes = Buffer.from(secret, "utf8");
  const candidateBytes = Buffer.from(candidate, "utf8");
  return (
    candidateBytes.length === expectedBytes.length &&
    timingSafeEqual(candidateBytes, expectedBytes)
  );
}
