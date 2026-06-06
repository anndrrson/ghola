const DEFAULT_IDLE_ENDPOINT = "https://ghola.xyz/api/private-agent/idle";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

function envString(env, name, fallback = "") {
  const value = env?.[name];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function bearerToken(request) {
  const auth = request.headers.get("authorization") || "";
  return auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
}

function idleTimeoutMs(env) {
  const parsed = Number.parseInt(envString(env, "GHOLA_IDLE_TIMEOUT_MS"), 10);
  return Number.isFinite(parsed) && parsed >= 1000 && parsed <= 30000 ? parsed : 10000;
}

async function readResponseBody(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 2000);
  }
}

async function runIdleStop(env, source) {
  const endpoint = envString(env, "GHOLA_IDLE_ENDPOINT_URL", DEFAULT_IDLE_ENDPOINT);
  const secret = envString(env, "GHOLA_IDLE_CRON_SECRET") ||
    envString(env, "GHOLA_PRIVATE_AGENT_IDLE_CRON_SECRET") ||
    envString(env, "CRON_SECRET");
  if (!secret) {
    throw new Error("GHOLA_IDLE_CRON_SECRET is required.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("idle stop timed out"), idleTimeoutMs(env));
  try {
    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        authorization: `Bearer ${secret}`,
        "x-ghola-idle-cron-source": source,
        "user-agent": "ghola-idle-cron/1.0",
      },
      signal: controller.signal,
    });
    const body = await readResponseBody(response);
    if (!response.ok) {
      throw new Error(`Ghola idle stop returned HTTP ${response.status}: ${JSON.stringify(body)}`);
    }
    return {
      ok: true,
      status: response.status,
      body,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({
        ok: true,
        service: "ghola-idle-cron",
        endpoint_configured: Boolean(envString(env, "GHOLA_IDLE_ENDPOINT_URL", DEFAULT_IDLE_ENDPOINT)),
        secret_configured: Boolean(
          envString(env, "GHOLA_IDLE_CRON_SECRET") ||
            envString(env, "GHOLA_PRIVATE_AGENT_IDLE_CRON_SECRET") ||
            envString(env, "CRON_SECRET"),
        ),
      });
    }
    if (url.pathname === "/run") {
      const manualToken = envString(env, "GHOLA_IDLE_MANUAL_TOKEN");
      if (!manualToken || bearerToken(request) !== manualToken) {
        return json({ error: "unauthorized" }, 401);
      }
      try {
        return json(await runIdleStop(env, "manual"));
      } catch (error) {
        return json({
          ok: false,
          error: error instanceof Error ? error.message : "idle stop failed",
        }, 502);
      }
    }
    return json({ error: "not_found" }, 404);
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runIdleStop(env, "cloudflare_cron"));
  },
};
