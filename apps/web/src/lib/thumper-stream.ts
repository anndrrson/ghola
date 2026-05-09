const THUMPER_API_BASE =
  process.env.NEXT_PUBLIC_THUMPER_API_URL || "http://localhost:3000";

interface StreamChatOptions {
  onSession?: (sessionId: string) => void;
  onProvider?: (info: { type: string; model?: string; provider_name?: string }) => void;
  onChunk: (text: string) => void;
  onDone: () => void;
  onError: (error: Error) => void;
  /**
   * Optional sealed-envelope-v1 ciphertext of the user's message
   * (base64 standard with padding). When supplied the cloud persists
   * the envelope blob and never stores plaintext for the user-role
   * row — see crates/thumper-cloud/src/routes/chat.rs for the
   * server-side write path.
   *
   * `message` is still sent (the cloud needs plaintext to forward to
   * the LLM) but is not persisted alongside the envelope.
   */
  envelopeBlobB64?: string;
}

export async function streamChat(
  sessionId: string | null,
  message: string,
  options: StreamChatOptions
): Promise<void> {
  const token =
    typeof window !== "undefined"
      ? localStorage.getItem("thumper_token")
      : null;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  try {
    const body: Record<string, unknown> = {
      session_id: sessionId,
      message,
    };
    if (options.envelopeBlobB64) {
      body.envelope_blob_b64 = options.envelopeBlobB64;
    }
    const res = await fetch(`${THUMPER_API_BASE}/api/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "Chat error");
      options.onError(new Error(body));
      return;
    }

    const reader = res.body?.getReader();
    if (!reader) {
      options.onDone();
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let currentEvent = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7).trim();
          continue;
        }

        if (line.startsWith("data: ")) {
          const data = line.slice(6);

          if (currentEvent === "session" || (!currentEvent && data.startsWith('{"session_id"'))) {
            try {
              const parsed = JSON.parse(data);
              if (parsed.session_id && options.onSession) {
                options.onSession(parsed.session_id);
              }
            } catch {
              // not JSON session data
            }
            currentEvent = "";
            continue;
          }

          if (currentEvent === "provider") {
            try {
              const parsed = JSON.parse(data);
              options.onProvider?.(parsed);
            } catch {
              // not JSON provider data
            }
            currentEvent = "";
            continue;
          }

          if (currentEvent === "done" || data === "[DONE]") {
            options.onDone();
            return;
          }

          if (currentEvent === "error") {
            options.onError(new Error(data));
            return;
          }

          // text_delta or default text streaming
          if (currentEvent === "text_delta" || !currentEvent) {
            try {
              const parsed = JSON.parse(data);
              if (parsed.content) {
                options.onChunk(parsed.content);
              } else if (parsed.text) {
                options.onChunk(parsed.text);
              } else if (typeof parsed === "string") {
                options.onChunk(parsed);
              }
            } catch {
              // Raw text
              if (data.trim()) {
                options.onChunk(data);
              }
            }
          }

          currentEvent = "";
        }
      }
    }

    options.onDone();
  } catch (e) {
    options.onError(e instanceof Error ? e : new Error(String(e)));
  }
}
