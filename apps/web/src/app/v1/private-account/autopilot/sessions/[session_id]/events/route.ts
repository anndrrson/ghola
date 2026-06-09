import {
  PRIVATE_ACCOUNT_SSE_HEADERS,
  json,
  privateAccountOwnerFromRequest,
  unauthorized,
} from "../../../../_lib";
import { syncWorkerAutopilotSession } from "@/lib/private-account-autopilot";

export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 10_000;

function sessionId(params: unknown): string | null {
  if (!params || typeof params !== "object" || !("session_id" in params)) return null;
  const value = (params as { session_id?: unknown }).session_id;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<unknown> },
) {
  const id = sessionId(await params);
  if (!id) return json({ error: "autopilot_session_not_found" }, 404);
  const owner = await privateAccountOwnerFromRequest(req);
  if (!owner) return unauthorized();
  const initial = await syncWorkerAutopilotSession(id, owner);
  if ("error" in initial) return json({ error: initial.error }, 404);

  const encoder = new TextEncoder();
  const seen = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let syncing = false;

  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: string, data: unknown) => controller.enqueue(encoder.encode(sse(event, data)));
      emit("session_state", initial.session);
      for (const event of initial.events) {
        seen.add(event.event_id);
        emit(event.type, event);
      }
      const poll = async () => {
        if (syncing) return;
        syncing = true;
        const current = await syncWorkerAutopilotSession(id, owner).catch((error) => ({
          error: error instanceof Error ? error.message : "worker_sync_failed",
        } as const)).finally(() => {
          syncing = false;
        });
        if ("error" in current) {
          emit("stream_status", {
            version: 1,
            stream_status: "closed",
            error: current.error,
            updated_at: new Date().toISOString(),
          });
          controller.close();
          if (timer) clearInterval(timer);
          timer = null;
          return;
        }
        emit("session_state", current.session);
        for (const event of current.events) {
          if (seen.has(event.event_id)) continue;
          seen.add(event.event_id);
          emit(event.type, event);
        }
        emit("stream_status", {
          version: 1,
          stream_status: "live",
          updated_at: new Date().toISOString(),
        });
      };
      timer = setInterval(() => {
        void poll();
      }, HEARTBEAT_MS);
    },
    cancel() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  }), {
    status: 200,
    headers: PRIVATE_ACCOUNT_SSE_HEADERS,
  });
}
