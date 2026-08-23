export type GholaOperationalAlert = {
  code: string;
  route: string;
  severity: "warning" | "critical";
  correlation_id?: string | null;
  duration_ms?: number | null;
};

type AlertEnvironment = Record<string, string | undefined>;
type AlertFetch = typeof fetch;

export async function emitOperationalAlert(
  input: GholaOperationalAlert,
  env: AlertEnvironment = process.env,
  fetchImpl: AlertFetch = fetch,
) {
  const alert = {
    version: 1,
    kind: "ghola_public_beta_operational_alert",
    severity: input.severity,
    code: safeToken(input.code),
    route: safeRoute(input.route),
    correlation_id: safeCorrelationId(input.correlation_id),
    duration_ms: safeDuration(input.duration_ms),
    occurred_at: new Date().toISOString(),
  };
  console.error(JSON.stringify({ level: input.severity === "critical" ? "error" : "warning", ...alert }));

  const configured = env.GHOLA_OPERATIONS_ALERT_WEBHOOK?.trim() ?? "";
  if (!configured) return { delivered: false, reason: "alert_webhook_unconfigured" as const };
  let endpoint: URL;
  try {
    endpoint = new URL(configured);
  } catch {
    return { delivered: false, reason: "alert_webhook_invalid" as const };
  }
  if (endpoint.protocol !== "https:") {
    return { delivered: false, reason: "alert_webhook_https_required" as const };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(alert),
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      console.error(JSON.stringify({
        level: "error",
        kind: "ghola_operational_alert_delivery_failed",
        status: response.status,
        code: alert.code,
        occurred_at: new Date().toISOString(),
      }));
      return { delivered: false, reason: "alert_webhook_rejected" as const, status: response.status };
    }
    return { delivered: true as const, status: response.status };
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      kind: "ghola_operational_alert_delivery_failed",
      error_name: error instanceof Error ? error.name : "unknown",
      code: alert.code,
      occurred_at: new Date().toISOString(),
    }));
    return { delivered: false, reason: "alert_webhook_unavailable" as const };
  } finally {
    clearTimeout(timeout);
  }
}

function safeToken(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._:-]/g, "_");
  return normalized.slice(0, 96) || "unknown";
}

function safeRoute(value: string): string {
  const normalized = value.trim();
  return /^\/[a-zA-Z0-9/_-]{1,160}$/.test(normalized) ? normalized : "/unknown";
}

function safeCorrelationId(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return /^[a-zA-Z0-9._:-]{8,96}$/.test(normalized) ? normalized : null;
}

function safeDuration(value: number | null | undefined): number | null {
  return Number.isFinite(value) && Number(value) >= 0 ? Math.round(Number(value)) : null;
}
