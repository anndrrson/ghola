import { afterEach, describe, expect, it, vi } from "vitest";

import { createPrivacyApproval } from "./thumper-api";
import { streamChat } from "./thumper-stream";

describe("streamChat cloud approval", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("flattens explicit cloudChat approval into the chat request body", async () => {
    localStorage.setItem("thumper_token", "test-token");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("event: done\ndata: [DONE]\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const approval = createPrivacyApproval(
      "cloudChat",
      "User selected Open mode and approved Ghola Cloud chat inference for this message.",
    );

    await streamChat("11111111-1111-1111-1111-111111111111", "hello", {
      approval,
      onChunk: () => {},
      onDone: () => {},
      onError: (error) => {
        throw error;
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-token" });
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      session_id: "11111111-1111-1111-1111-111111111111",
      message: "hello",
      privacy_mode: "strictLocal",
      network_scope: "cloudChat",
      approval_summary:
        "User selected Open mode and approved Ghola Cloud chat inference for this message.",
    });
    expect(typeof body.user_approved_at).toBe("string");
    expect(typeof body.approval_nonce).toBe("string");
    expect(String(body.approval_nonce).length).toBeGreaterThanOrEqual(16);
  });

  it("does not invent approval when none is supplied", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("event: done\ndata: [DONE]\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await streamChat(null, "hello", {
      onChunk: () => {},
      onDone: () => {},
      onError: (error) => {
        throw error;
      },
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.network_scope).toBeUndefined();
    expect(body.user_approved_at).toBeUndefined();
    expect(body.approval_nonce).toBeUndefined();
  });
});
