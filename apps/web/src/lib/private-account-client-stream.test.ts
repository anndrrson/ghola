import { afterEach, describe, expect, it, vi } from "vitest";
import { openHyperliquidAccountStream } from "./private-account-client";

function unavailableStreamResponse() {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        'event: error\ndata: {"error":"stream_unavailable"}\n\n',
      ));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

describe("Hyperliquid account stream", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("backs off repeated unavailable streams instead of reconnecting every second", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => unavailableStreamResponse());
    vi.stubGlobal("fetch", fetchMock);
    const stream = openHyperliquidAccountStream({
      onState: vi.fn(),
      onError: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    stream.close();
  });
});
