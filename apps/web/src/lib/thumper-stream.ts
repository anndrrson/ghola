import type { ThumperInlineAction, ThumperPrivacyApproval } from "@/lib/thumper-types";

const THUMPER_API_BASE =
  typeof window === "undefined"
    ? process.env.NEXT_PUBLIC_THUMPER_API_URL || "https://thumper-cloud.onrender.com"
    : process.env.NEXT_PUBLIC_THUMPER_API_URL || "";

interface StreamChatOptions {
  onSession?: (sessionId: string) => void;
  onProvider?: (info: {
    type: string;
    model?: string;
    provider_name?: string;
    tool_use_supported?: boolean;
  }) => void;
  onChunk: (text: string) => void;
  /**
   * Called once with the accumulated client-side action tool_use events
   * surfaced during the turn. Fires just before `onDone` and only if any
   * client_action tool_use events arrived.
   */
  onActions?: (actions: ThumperInlineAction[]) => void;
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
  /**
   * Explicit, per-message user approval for remote cloud inference.
   * Flattened into the /api/chat body because the Rust endpoint uses
   * serde(flatten) on PrivacyApproval.
   */
  approval?: ThumperPrivacyApproval;
}

function toolUseToInlineAction(
  tool: string,
  input: unknown,
): ThumperInlineAction | null {
  const data =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};
  switch (tool) {
    case "send_email":
      return { type: "email", status: "ready", data };
    case "send_sms":
      return { type: "sms", status: "ready", data };
    case "initiate_call":
      return {
        type: "call",
        status: "ready",
        data: {
          phone_number: data.phone_number,
          objective: data.objective,
        },
      };
    case "create_calendar_event":
      return { type: "calendar", status: "ready", data };
    default:
      return null;
  }
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
    if (options.approval) {
      Object.assign(body, options.approval);
    }
    const res = await fetch(`${THUMPER_API_BASE}/api/chat`, {
      method: "POST",
      headers,
      credentials: "same-origin",
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
    const pendingActions: ThumperInlineAction[] = [];

    const flushActions = () => {
      if (pendingActions.length > 0 && options.onActions) {
        options.onActions(pendingActions.slice());
        pendingActions.length = 0;
      }
    };

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

          if (currentEvent === "tool_use") {
            try {
              const parsed = JSON.parse(data);
              if (parsed.status === "client_action" && typeof parsed.tool === "string") {
                const action = toolUseToInlineAction(parsed.tool, parsed.input);
                if (action) pendingActions.push(action);
              }
            } catch {
              // ignore malformed payload — server-side bug, not the client's
              // problem to recover from
            }
            currentEvent = "";
            continue;
          }

          if (currentEvent === "tool_result") {
            // Server-executed tool results aren't surfaced to the user-facing
            // chat surface today; drop silently. Wallet UX may consume these
            // in a future change.
            currentEvent = "";
            continue;
          }

          if (currentEvent === "done" || data === "[DONE]") {
            flushActions();
            options.onDone();
            return;
          }

          if (currentEvent === "error") {
            flushActions();
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

    flushActions();
    options.onDone();
  } catch (e) {
    options.onError(e instanceof Error ? e : new Error(String(e)));
  }
}
