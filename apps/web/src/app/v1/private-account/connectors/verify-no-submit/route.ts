import { after } from "next/server";
import {
  connectorVerifyNoSubmitFromBody,
  json,
  privateAccountLiveGuard,
} from "../../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const startedAt = Date.now();
  const guarded = await privateAccountLiveGuard(req);
  if (!guarded.ok) return guarded.response;
  const verified = await connectorVerifyNoSubmitFromBody(guarded.body, guarded.owner, {
    site_origin: new URL(req.url).origin,
    defer: process.env.NODE_ENV === "test" ? undefined : (task) => after(task),
  });
  console.info("[private-account] connector no-submit completed", {
    duration_ms: Date.now() - startedAt,
    status: "error" in verified ? "error" : verified.verification.status,
    platform_class: "error" in verified ? null : verified.verification.platform_class,
    connection_proof_persisted: "error" in verified
      ? false
      : verified.connection_proof_persisted === true,
  });
  if ("error" in verified) return json({ error: verified.error }, 400);
  return json(verified);
}
