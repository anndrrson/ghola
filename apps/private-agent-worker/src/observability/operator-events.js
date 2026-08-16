const ALERT_SEVERITIES = new Set(["error", "critical"]);
const SAFE_FIELDS = new Set([
  "venue_id",
  "platform_class",
  "execution_mode",
  "operation_class",
  "execution_id",
  "work_order_commitment",
  "close_work_order_commitment",
  "claim_status",
  "status",
  "error_code",
  "duration_ms",
  "broadcast_performed",
  "final_venue_execution_proven",
  "final_fill_proven",
  "final_flat_proven",
]);
const RECENT_ALERTS = new Map();

export function buildOperatorEvent(event, fields = {}, { now = Date.now } = {}) {
  const safeEvent = safeToken(event, "operator_event");
  const severity = ["info", "warn", "error", "critical"].includes(fields.severity)
    ? fields.severity
    : "info";
  const payload = {
    timestamp: new Date(now()).toISOString(),
    service: "ghola-private-agent-worker",
    event: safeEvent,
    severity,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (!SAFE_FIELDS.has(key) || value === undefined || value === null) continue;
    payload[key] = safeValue(key, value);
  }
  return payload;
}

export async function emitOperatorEvent(event, fields = {}, options = {}) {
  const payload = buildOperatorEvent(event, fields, options);
  const line = JSON.stringify(payload);
  const write = options.write || defaultWrite;
  write(line, payload);

  const webhookUrl = options.webhookUrl ??
    process.env.PRIVATE_AGENT_OPERATOR_ALERT_WEBHOOK_URL ??
    process.env.GHOLA_OPERATOR_ALERT_WEBHOOK_URL;
  if (!webhookUrl || !ALERT_SEVERITIES.has(payload.severity)) return payload;
  if (!operatorAlertDue(payload, options)) return payload;

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") return payload;
  const timeoutMs = boundedTimeout(options.timeoutMs ?? process.env.PRIVATE_AGENT_OPERATOR_ALERT_TIMEOUT_MS);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { "content-type": "application/json" };
    const token = options.alertToken ?? process.env.PRIVATE_AGENT_OPERATOR_ALERT_TOKEN;
    if (token) headers.authorization = `Bearer ${token}`;
    await fetchImpl(webhookUrl, {
      method: "POST",
      headers,
      body: line,
      signal: controller.signal,
    });
  } catch {
    // Alert transport must never alter execution semantics.
  } finally {
    clearTimeout(timeout);
  }
  return payload;
}

export function resetOperatorAlertDedupeForTests() {
  RECENT_ALERTS.clear();
}

function operatorAlertDue(payload, options) {
  const nowMs = typeof options.nowMs === "number" ? options.nowMs : Date.now();
  const windowMs = boundedDedupeWindow(options.dedupeWindowMs);
  const key = [payload.event, payload.work_order_commitment || "global", payload.error_code || "none"].join(":");
  const previous = RECENT_ALERTS.get(key);
  if (previous !== undefined && nowMs - previous < windowMs) return false;
  RECENT_ALERTS.set(key, nowMs);
  if (RECENT_ALERTS.size > 1_000) {
    const oldest = RECENT_ALERTS.keys().next().value;
    RECENT_ALERTS.delete(oldest);
  }
  return true;
}

function safeValue(key, value) {
  if (["duration_ms"].includes(key)) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
  }
  if (["broadcast_performed", "final_venue_execution_proven", "final_fill_proven", "final_flat_proven"].includes(key)) {
    return value === true;
  }
  return safeToken(value, "unknown");
}

function safeToken(value, fallback) {
  const normalized = String(value ?? "")
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, 160);
  return normalized || fallback;
}

function boundedTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 2_000;
  return Math.max(100, Math.min(10_000, Math.round(parsed)));
}

function boundedDedupeWindow(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 60_000;
  return Math.max(0, Math.min(3_600_000, Math.round(parsed)));
}

function defaultWrite(line, payload) {
  const stream = ALERT_SEVERITIES.has(payload.severity) ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}
