/**
 * Local inference transport — talks to a locally-installed ghola-home
 * instance over HTTP on the user's machine. Used when the chat is set
 * to Sovereignty mode "local."
 *
 * v1: ghola-home only. WebGPU / transformers.js for ≤3B in-browser
 * models is a v2 add — the probe surface here is forward-compatible so
 * the picker UI can stay the same once that lands.
 *
 * Fails closed: if ghola-home is unreachable or the browser isn't
 * paired, this module throws/errors rather than silently routing
 * through the relay. The whole point of Local mode is that the user
 * picked it; downgrading to cloud without telling them would be the
 * privacy-product equivalent of a lie.
 */

// ghola-home binds 0.0.0.0:3000 by default (GHOLA_HOME_BIND env var).
// We probe 127.0.0.1:7878 first because :3000 collides with the Next.js
// dev server on a developer machine and most home users will set
// GHOLA_HOME_BIND to something dedicated. Users can override either
// value via localStorage `ghola:home-url`.
const DEFAULT_HOME_URL = "http://127.0.0.1:7878";
const HOME_URL_STORAGE_KEY = "ghola:home-url";
const PAIR_TOKEN_STORAGE_KEY = "ghola:home-pair-token";
const PROBE_TIMEOUT_MS = 1500;

export function getGholaHomeUrl(): string {
  if (typeof window === "undefined") return DEFAULT_HOME_URL;
  try {
    const stored = window.localStorage.getItem(HOME_URL_STORAGE_KEY);
    if (stored && stored.startsWith("http")) return stored;
  } catch {
    // localStorage may be disabled; fall through to default.
  }
  return DEFAULT_HOME_URL;
}

function getPairToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(PAIR_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export interface GholaHomeStatus {
  available: boolean;
  baseUrl: string;
  paired: boolean;
  reason?: string;
}

export async function probeGholaHome(): Promise<GholaHomeStatus> {
  const baseUrl = getGholaHomeUrl();
  const paired = getPairToken() !== null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    const res = await fetch(`${baseUrl}/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) {
      return {
        available: false,
        baseUrl,
        paired,
        reason: `health endpoint returned ${res.status}`,
      };
    }
    return { available: true, baseUrl, paired };
  } catch (err) {
    return {
      available: false,
      baseUrl,
      paired,
      reason: err instanceof Error ? err.message : "fetch failed",
    };
  }
}

interface StreamLocalChatOptions {
  onChunk: (text: string) => void;
  onDone: () => void;
  onError: (message: string) => void;
  model?: string;
}

// SSE parser mirrors crates/ghola-home/src/routes/chat.rs:
// events `session`, `text_delta`, `error`, `done`.
export async function streamLocalChat(
  sessionId: string,
  message: string,
  options: StreamLocalChatOptions,
): Promise<void> {
  const status = await probeGholaHome();
  if (!status.available) {
    options.onError(
      `Local mode needs ghola-home running on this machine. Tried ${status.baseUrl}${status.reason ? ` (${status.reason})` : ""}. Install ghola-home from ghola.xyz/local, or switch to Private mode.`,
    );
    return;
  }
  const token = getPairToken();
  if (!token) {
    options.onError(
      `ghola-home is running at ${status.baseUrl} but this browser isn't paired. Open the ghola-home app, pair this browser with the displayed PIN, and try again — or switch to Private mode.`,
    );
    return;
  }

  let res: Response;
  try {
    res = await fetch(`${status.baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        session_id: sessionId,
        message,
        model: options.model,
      }),
    });
  } catch (err) {
    options.onError(
      `Could not reach ghola-home: ${err instanceof Error ? err.message : "network error"}`,
    );
    return;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    options.onError(
      `ghola-home returned ${res.status}${body ? `: ${body}` : ""}`,
    );
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

  try {
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
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        switch (currentEvent) {
          case "text_delta": {
            try {
              const parsed = JSON.parse(data);
              if (typeof parsed.text === "string") options.onChunk(parsed.text);
            } catch {
              // ghola-home should always emit JSON here, but treat raw
              // text as a chunk too so we don't drop output on a parse
              // hiccup.
              if (data) options.onChunk(data);
            }
            break;
          }
          case "error": {
            try {
              const parsed = JSON.parse(data);
              options.onError(parsed.error ?? "local inference failed");
            } catch {
              options.onError(data || "local inference failed");
            }
            return;
          }
          case "done": {
            options.onDone();
            return;
          }
          // "session" carries the session id ghola-home assigned; we
          // ignore it because we keep using the client-side session id.
          default:
            break;
        }
        currentEvent = "";
      }
    }
    options.onDone();
  } catch (err) {
    options.onError(
      err instanceof Error ? err.message : "local stream interrupted",
    );
  }
}
