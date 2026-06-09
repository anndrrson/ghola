import { PRIVATE_ACCOUNT_SSE_HEADERS } from "../../_lib";
import { getMobileMarketSnapshot } from "@/lib/mobile-market-data";

export const dynamic = "force-dynamic";

const SNAPSHOT_INTERVAL_MS = 4_000;
const HEARTBEAT_INTERVAL_MS = 15_000;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const productId = url.searchParams.get("product_id");
  const interval = url.searchParams.get("interval");
  const encoder = new TextEncoder();
  let snapshotTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let active = true;
  let inFlight = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const emitSnapshot = async () => {
        if (!active || inFlight) return;
        inFlight = true;
        try {
          const snapshot = await getMobileMarketSnapshot({ productId, interval });
          emit("snapshot", snapshot);
        } catch (error) {
          emit("status", {
            version: 1,
            live_status: "stale",
            updated_at: new Date().toISOString(),
            error: error instanceof Error ? error.message : "mobile_market_stream_failed",
          });
        } finally {
          inFlight = false;
        }
      };

      emit("status", {
        version: 1,
        live_status: "connecting",
        updated_at: new Date().toISOString(),
      });
      void emitSnapshot();
      snapshotTimer = setInterval(() => void emitSnapshot(), SNAPSHOT_INTERVAL_MS);
      heartbeatTimer = setInterval(() => {
        emit("status", {
          version: 1,
          live_status: "live",
          updated_at: new Date().toISOString(),
        });
      }, HEARTBEAT_INTERVAL_MS);
    },
    cancel() {
      active = false;
      if (snapshotTimer) clearInterval(snapshotTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      snapshotTimer = null;
      heartbeatTimer = null;
    },
  });

  return new Response(stream, {
    status: 200,
    headers: PRIVATE_ACCOUNT_SSE_HEADERS,
  });
}
